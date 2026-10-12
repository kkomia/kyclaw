/**
 * 「文件」工具：会话根的懒加载目录树 + 单击文件的内联预览 + 自绘右键菜单。
 *
 * 数据流：`workbench:list-dir` 一次只列**一层**（根 = `''`），子目录展开时再列 —— 目录内容按
 * 相对路径缓存在本组件里（展开过一次的路径不重复请求）。单击文件按后缀分流（`preview/modes.ts`）：
 * 文本 / markdown / 代码走 `workbench:read-file`（有界文本），图片 / PDF / 办公三件 / csv 走
 * `workbench:read-bytes`（原始字节或主进程抽好的结构）。路径解析与 containment 全在主进程：
 * 这里只递相对路径，绝对路径只用来拼"复制路径"的文本。
 *
 * 会话切换（threadId 变）时整棵树清空重来，并用"代次"丢弃晚到的响应（旧会话的目录不会再画回来）。
 *
 * round 42：右键菜单首项「添加到上下文」（仅文件）与预览区选中的「添加到上下文（摘选）」
 * 走 composer-inbox 的事件通道进输入卡的附件条；这里只发布"哪个会话的哪个文件 / 哪段摘选"，
 * 读文件与上限判定都在订阅方（Composer）做。
 *
 * round 44：工具条上的搜索钮把工具条与树之间展开一行搜索行（文件名 / 内容两种口径）。
 * 递归遍历、上限判定、大小写口径全在主进程（`workbench:search`），这里只管防抖、渲染与打开：
 * 查询（trim 后）不足 `SEARCH_QUERY_MIN` 个字符就回树；结果点击复用 `chooseFile` 那条预览链。
 *
 * round 50：**双击文件**（或右键「在新标签页中查看」）把这份文件开成一个**预览标签**
 * （FilesTool 的单击内联预览原样不动）。开标签由 workbench-store 的 `openPreviewTab` 去重，
 * 开面板由这里顺带做（store 不碰 shell-store）。
 */
import {
  ChevronRight,
  Copy,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  MessageSquarePlus,
  Search,
  TextSelect,
  X
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  SEARCH_QUERY_MIN,
  type DirEntry,
  type WorkbenchSearchHit,
  type WorkbenchSearchMode,
  type WorkbenchSearchResult
} from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { linesOfSelection, publishContextItem } from '@renderer/features/chat/composer-inbox'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useShellStore } from '@renderer/lib/shell-store'
import { BottomSheet, RefreshButton, ToolBar, ToolEmpty, ToolError } from './bits'
import { ContextMenu, type ContextMenuState, type ContextMenuItem } from './ContextMenu'
import { PreviewBody } from './preview/PreviewBody'
import { baseNameOf, readPreviewState, type PreviewState } from './preview/fetch'
import { previewModeOf } from './preview/modes'
import { absoluteOf, type WorkbenchRoot } from './use-workbench-root'
import { formatBytes } from './format'
import { useWorkbenchStore } from './workbench-store'

interface DirState {
  status: 'ready' | 'error'
  entries: DirEntry[]
  truncated: boolean
  error?: string
}

/** 列目录失败时的状态（`entries` 留空，界面只看 error） */
function failedDir(error: string): DirState {
  return { status: 'error', entries: [], truncated: false, error }
}

/** 输入停多久才真发搜索（防抖；打字期间一个请求都不发） */
const SEARCH_DEBOUNCE_MS = 300

/**
 * 搜索的状态。`key` 是这份结果对应的"口径 + 查询"：对不上就是还没返回（或已过期），
 * 界面据此画 spinner —— 晚到的旧响应靠 key 失配自然作废，不需要额外的代次计数。
 */
interface SearchState {
  key: string
  status: 'loading' | 'done' | 'error'
  result?: WorkbenchSearchResult
  error?: string
}

export function FilesTool({ root }: { root: WorkbenchRoot }): React.JSX.Element {
  const { threadId, rootPath, ready, notice, workbench } = root
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<WorkbenchSearchMode>('name')
  const [search, setSearch] = useState<SearchState | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  /**
   * 列一层目录。**不在请求前写"加载中"状态**：`dirs[路径]` 不存在本身就表示"还没列出来"
   * （界面据此画 spinner）—— 这样挂载时那次调用不会在 effect 里同步 setState（级联渲染），
   * 刷新时也保留旧内容直到新结果到位（不闪一下白）。
   * 换会话由 Workbench 用 key 重挂本组件（状态自然清空），所以这里不用代次防串台：
   * 旧挂载的迟到响应落在已卸载的组件上，React 会忽略。
   */
  const loadDir = useCallback(
    (relative: string): void => {
      if (workbench === null || threadId === null) return
      void workbench.listDir(threadId, relative).then(
        (result) => {
          setDirs((prev) => ({
            ...prev,
            [relative]: { status: 'ready', entries: result.entries, truncated: result.truncated }
          }))
        },
        (error: unknown) => {
          setDirs((prev) => ({
            ...prev,
            [relative]: failedDir(unwrapIpcError(error))
          }))
        }
      )
    },
    [threadId, workbench]
  )

  // 根就绪 → 列根目录
  useEffect(() => {
    if (ready) loadDir('')
  }, [ready, loadDir])

  const chooseFile = useCallback(
    (relative: string): void => {
      if (workbench === null || threadId === null) return
      const mode = previewModeOf(relative)
      // 旧版 Office（.doc/.xls/.ppt）：不读文件，直接给人话（"另存为 .docx/.xlsx/.pptx"）
      if (mode === 'office-legacy') {
        setPreview({ threadId, relative, mode, status: 'ready' })
        return
      }
      setPreview({ threadId, relative, mode, status: 'loading' })
      // 取内容的那一段与预览标签共用（分流口径见 preview/fetch.ts）。响应带上"这是哪个会话的
      // 哪份文件"的记账：预览标签那边要靠它判晚到，这边则让 `sourceTextOf`（摘选取行号）拿得到源文。
      void readPreviewState(workbench, threadId, relative).then(setPreview)
    },
    [threadId, workbench]
  )

  /**
   * round 50：**双击文件**在新标签页里打开（单击的内联预览原样不动）。
   * 开面板是调用方的事（store 只管标签）——这里顺带把右栏打开，否则新标签在收起的面板里看不见。
   */
  const openInTab = useCallback((relative: string): void => {
    useWorkbenchStore.getState().openPreviewTab(relative)
    useShellStore.getState().setWorkPanelOpen(true)
  }, [])

  const toggleDir = useCallback(
    (relative: string): void => {
      const open = expanded.includes(relative)
      setExpanded((prev) => (open ? prev.filter((path) => path !== relative) : [...prev, relative]))
      if (!open && dirs[relative] === undefined) loadDir(relative)
    },
    [dirs, expanded, loadDir]
  )

  /* ── round 44：搜索 ─────────────────────────────────────────────────── */

  const needle = query.trim()
  /** 真在搜索（搜索行开着 + 查询够长）；否则一律回树 */
  const searching = searchOpen && needle.length >= SEARCH_QUERY_MIN
  const searchKey = `${mode}:${needle}`
  /** 只看**当前这轮**的结果：晚到的旧响应（key 对不上）留在 state 里也不进界面 */
  const current = search !== null && search.key === searchKey ? search : null

  /**
   * 防抖后发搜索。请求发出前不写任何状态：`current === null` 就是"还没结果"，
   * 界面据此画 spinner —— 于是打字期间一个请求都不发、也没有多余的渲染。
   */
  useEffect(() => {
    if (!searching || workbench === null || threadId === null) return
    const timer = window.setTimeout(() => {
      setSearch({ key: searchKey, status: 'loading' })
      void workbench.search(threadId, needle, mode).then(
        (result) => setSearch({ key: searchKey, status: 'done', result }),
        (error: unknown) =>
          setSearch({ key: searchKey, status: 'error', error: unwrapIpcError(error) })
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [mode, needle, searchKey, searching, threadId, workbench])

  // 打开搜索行就把光标放进去（折叠容器里的输入拿到焦点才谈得上"点开即打"）
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    setQuery('')
    setSearch(null)
  }, [])

  /** 结果行：走与单击文件同一条预览链（内容命中本轮只打开文件，不做行内定位） */
  const openHit = useCallback(
    (hit: WorkbenchSearchHit): void => {
      chooseFile(hit.path)
    },
    [chooseFile]
  )

  /** 搜索行里的键盘：回车打开第一条命中（Esc 交给整块的容器，见下面 onToolKeyDown） */
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    const first = current?.result?.results[0]
    if (first !== undefined) openHit(first)
  }

  /** Esc 关搜索回树：挂在整块工具上，焦点在输入框**或**某条结果上都成立 */
  const onToolKeyDown = (event: React.KeyboardEvent): void => {
    if (searchOpen && event.key === 'Escape') closeSearch()
  }

  const reveal = useCallback(
    (relative: string): void => {
      if (workbench === null || threadId === null) return
      void workbench.reveal(threadId, relative).then(
        () => undefined,
        (error: unknown) => {
          setMenu(null)
          setPreview({
            threadId,
            relative,
            mode: previewModeOf(relative),
            status: 'error',
            error: unwrapIpcError(error)
          })
        }
      )
    },
    [threadId, workbench]
  )

  const copyPath = useCallback(
    (relative: string): void => {
      if (rootPath === null) return
      void navigator.clipboard?.writeText(absoluteOf(rootPath, relative))
    },
    [rootPath]
  )

  /**
   * round 42：把**整份文件**交给输入卡（只报"哪个会话的哪个文件"——读文件与判档在订阅方做，
   * 见 composer-inbox.ts；没有会话时不发布，事件挂不到任何输入卡上）。
   */
  const addFileToContext = useCallback(
    (relative: string): void => {
      if (threadId === null) return
      publishContextItem({ source: 'file', threadId, relative, name: baseNameOf(relative) })
    },
    [threadId]
  )

  /**
   * round 42：把预览里**选中的那段**交给输入卡（名称带「摘选」，与整份文件区分开）。
   * 位置（行号区间）在这一侧算：只有预览手里有**源文**（订阅方只看得到选中的文字本身）。
   * 算不出就不带 `lines`——不瞎编（口径见 composer-inbox.ts 的 linesOfSelection）。
   */
  const addSelectionToContext = useCallback(
    (state: PreviewState, text: string): void => {
      if (threadId === null) return
      const source = sourceTextOf(state)
      const lines = source === null ? null : linesOfSelection(source, text)
      publishContextItem({
        source: 'selection',
        threadId,
        relative: state.relative,
        name: `${baseNameOf(state.relative)} 摘选`,
        text,
        ...(lines === null ? {} : { lines })
      })
    },
    [threadId]
  )

  /** 「全选」：把预览体的内容整体选上（选中后右键就是"有选区"那一档菜单） */
  const previewBodyRef = useRef<HTMLDivElement>(null)
  const selectPreviewAll = useCallback((): void => {
    const node = previewBodyRef.current
    const selection = window.getSelection()
    if (node === null || selection === null) return
    const range = document.createRange()
    range.selectNodeContents(node)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [])

  /**
   * 预览区的右键 = 自绘菜单（雷点 4：原生菜单一律拦掉——整块预览区都拦，不只是选中文字那一小块）。
   * 有选区：[添加到上下文（摘选）/ 复制 / 全选]；没有：[全选]（最小集合，不摆点了没用的项）。
   */
  const onPreviewContextMenu = (event: React.MouseEvent, state: PreviewState): void => {
    event.preventDefault()
    const selected = window.getSelection()?.toString() ?? ''
    const items: ContextMenuItem[] = []
    if (selected.trim() !== '') {
      items.push({
        id: 'context',
        label: '添加到上下文（摘选）',
        icon: <MessageSquarePlus />,
        onSelect: () => addSelectionToContext(state, selected)
      })
      items.push({
        id: 'copy',
        label: '复制',
        icon: <Copy />,
        onSelect: () => {
          void navigator.clipboard?.writeText(selected)
        }
      })
    }
    items.push({
      id: 'select-all',
      label: '全选',
      icon: <TextSelect />,
      onSelect: selectPreviewAll
    })
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  if (!ready) {
    return <ToolEmpty testId="files-notice" icon={FolderOpen} title={notice ?? '文件不可用'} />
  }

  const rootDir = dirs['']

  return (
    <div
      data-testid="files-tool"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onToolKeyDown}
    >
      <ToolBar className="justify-between">
        <span
          data-testid="files-root"
          title={rootPath ?? ''}
          className="min-w-0 truncate px-1 text-b2 text-ink-secondary"
        >
          {root.rootName ?? ''}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            data-testid="files-search"
            label="搜索文件"
            icon={<Search />}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            className="border-transparent hover:bg-hover"
          />
          <RefreshButton label="刷新目录树" testId="files-refresh" onClick={() => loadDir('')} />
        </div>
      </ToolBar>

      {/* 搜索行：与工具条同一条视觉带（树在它下面）；折叠走 .trace-fold 的双向过渡，不硬切 */}
      <div
        className="trace-fold shrink-0"
        data-open={searchOpen ? 'true' : 'false'}
        data-testid="files-search-panel"
      >
        <div className="trace-fold-in">
          <div className="flex items-center gap-1 px-2 pb-1">
            <Input
              ref={searchInputRef}
              data-testid="files-search-input"
              aria-label="搜索文件"
              value={query}
              placeholder={mode === 'name' ? '搜索文件名' : '搜索文件内容'}
              className="h-8 px-2 text-b2"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            <div className="flex shrink-0 items-center gap-0.5">
              <SearchModeButton mode="name" current={mode} onSelect={setMode} label="文件名" />
              <SearchModeButton mode="content" current={mode} onSelect={setMode} label="内容" />
            </div>
            <IconButton
              data-testid="files-search-close"
              label="关闭搜索"
              icon={<X />}
              onClick={closeSearch}
              className="border-transparent hover:bg-hover"
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {searching ? (
          <SearchResults state={current} mode={mode} onOpen={openHit} />
        ) : rootDir === undefined ? (
          <div className="flex justify-center py-3">
            <Spinner label="加载中" className="text-ink-tertiary" />
          </div>
        ) : rootDir.status === 'error' ? (
          <ToolError testId="files-error" message={rootDir.error ?? '目录读不了'} />
        ) : rootDir.entries.length === 0 ? (
          <ToolEmpty testId="files-empty" icon={Folder} title="这个文件夹是空的" />
        ) : (
          <Level
            relative=""
            depth={0}
            dirs={dirs}
            expanded={expanded}
            onToggle={toggleDir}
            onChoose={chooseFile}
            onDoubleChoose={openInTab}
            onContext={(event, relative, isDir) => {
              event.preventDefault()
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  // round 42：只有文件能进上下文（目录不进——"把文件夹塞进消息"没有意义）
                  ...(isDir
                    ? []
                    : [
                        {
                          id: 'context',
                          label: '添加到上下文',
                          icon: <MessageSquarePlus />,
                          onSelect: () => addFileToContext(relative)
                        },
                        // round 50：在新标签页里查看（目录不进——标签看的是文件内容）
                        {
                          id: 'preview',
                          label: '在新标签页中查看',
                          icon: <FileText />,
                          onSelect: () => openInTab(relative)
                        }
                      ]),
                  {
                    id: 'reveal',
                    label: isDir ? '在文件资源管理器中打开' : '在文件资源管理器中定位',
                    icon: <FolderSearch />,
                    onSelect: () => reveal(relative)
                  },
                  {
                    id: 'copy',
                    label: '复制路径',
                    icon: <Copy />,
                    onSelect: () => copyPath(relative)
                  }
                ]
              })
            }}
          />
        )}
      </div>

      {preview === null ? null : (
        // display: contents 的包装层：只为把整块预览区（含标题条）的右键都拦下来，
        // 自己不产生盒子、不改布局（自绘菜单见 onPreviewContextMenu）
        <div className="contents" onContextMenu={(event) => onPreviewContextMenu(event, preview)}>
          <BottomSheet
            testId="file-preview"
            title={baseNameOf(preview.relative)}
            onClose={() => setPreview(null)}
          >
            <div ref={previewBodyRef} data-testid="file-preview-body">
              <PreviewBody relative={preview.relative} state={preview} mode={preview.mode} />
            </div>
          </BottomSheet>
        </div>
      )}

      {menu === null ? null : <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/**
 * 预览手里能拿来比对位置的**源文**：只有文本通道有（markdown 也是这条通道，内容就是源文）。
 * 字节通道（图片 / PDF）没有可比对的文本 → null（位置就省略）。
 */
function sourceTextOf(state: PreviewState): string | null {
  const value = state.value
  if (value === undefined || value.channel !== 'text' || value.preview.kind !== 'text') return null
  return value.preview.text
}

interface LevelProps {
  relative: string
  depth: number
  dirs: Record<string, DirState>
  expanded: readonly string[]
  onToggle: (relative: string) => void
  onChoose: (relative: string) => void
  /** 双击文件 = 在新标签页里看（目录没有这一档；见 Round 50） */
  onDoubleChoose: (relative: string) => void
  onContext: (event: React.MouseEvent, relative: string, isDir: boolean) => void
}

/** 一层目录的条目（递归；子层只在展开过之后进 DOM，折叠走 .trace-fold 的双向过渡） */
function Level(props: LevelProps): React.JSX.Element {
  const state = props.dirs[props.relative]
  const entries = state?.entries ?? []

  return (
    <>
      {state === undefined ? (
        <div className="flex justify-center py-2">
          <Spinner label="加载中" className="text-ink-tertiary" />
        </div>
      ) : state.status === 'error' ? (
        <p className="px-3 py-2 text-b2 text-danger">{state.error ?? '目录读不了'}</p>
      ) : null}
      {state?.truncated === true ? (
        <p className="px-3 py-2 text-b2 text-ink-tertiary">条目太多，只列了前一部分</p>
      ) : null}
      {entries.map((entry) => {
        const child = props.relative === '' ? entry.name : `${props.relative}/${entry.name}`
        return entry.kind === 'dir' ? (
          <DirRow key={child} {...props} relative={child} entry={entry} />
        ) : (
          <Row
            key={child}
            relative={child}
            depth={props.depth}
            entry={entry}
            onChoose={props.onChoose}
            onDoubleChoose={props.onDoubleChoose}
            onContext={props.onContext}
          />
        )
      })}
    </>
  )
}

function DirRow({
  relative,
  depth,
  entry,
  dirs,
  expanded,
  onToggle,
  onChoose,
  onDoubleChoose,
  onContext
}: LevelProps & { entry: DirEntry }): React.JSX.Element {
  const open = expanded.includes(relative)
  // 展开过一次就常驻 DOM（收起时也能跑完整过渡；与 TraceFold 的 everOpened 同一口径）
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)

  return (
    <Fragment>
      <button
        type="button"
        data-testid="file-row"
        data-kind="dir"
        data-relative={relative}
        data-open={open ? 'true' : 'false'}
        onClick={() => onToggle(relative)}
        onContextMenu={(event) => onContext(event, relative, true)}
        style={{ paddingInlineStart: 8 + depth * 12 }}
        className="flex h-8 w-full cursor-default items-center gap-1.5 pr-2 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-(--icon-size-sm) shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main',
            open && 'rotate-90'
          )}
        />
        <Folder aria-hidden="true" className="size-(--icon-size-sm) shrink-0 text-ink-secondary" />
        <span className="truncate">{entry.name}</span>
      </button>
      <div className="trace-fold" data-open={open ? 'true' : 'false'}>
        <div className="trace-fold-in">
          {everOpened ? (
            <Level
              relative={relative}
              depth={depth + 1}
              dirs={dirs}
              expanded={expanded}
              onToggle={onToggle}
              onChoose={onChoose}
              onDoubleChoose={onDoubleChoose}
              onContext={onContext}
            />
          ) : null}
        </div>
      </div>
    </Fragment>
  )
}

function Row({
  relative,
  depth,
  entry,
  onChoose,
  onDoubleChoose,
  onContext
}: {
  relative: string
  depth: number
  entry: DirEntry
  onChoose: (relative: string) => void
  onDoubleChoose: (relative: string) => void
  onContext: (event: React.MouseEvent, relative: string, isDir: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="file-row"
      data-kind="file"
      data-relative={relative}
      onClick={() => onChoose(relative)}
      // 双击在新标签页里看（单击的内联预览不受影响：两次 click 之后才到的 dblclick）
      onDoubleClick={() => onDoubleChoose(relative)}
      onContextMenu={(event) => onContext(event, relative, false)}
      style={{ paddingInlineStart: 8 + depth * 12 + 18 }}
      className="flex h-8 w-full cursor-default items-center gap-1.5 pr-2 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
    >
      <FileIcon aria-hidden="true" className="size-(--icon-size-sm) shrink-0 text-ink-tertiary" />
      <span className="truncate">{entry.name}</span>
      <span className="ml-auto shrink-0 text-c1 text-ink-tertiary">{formatBytes(entry.size)}</span>
    </button>
  )
}

/** 搜索口径的小按钮（选中的那枚铺个底；未选中的只是灰字，与工具条同一套观感） */
function SearchModeButton({
  mode,
  current,
  onSelect,
  label
}: {
  mode: WorkbenchSearchMode
  current: WorkbenchSearchMode
  onSelect: (mode: WorkbenchSearchMode) => void
  label: string
}): React.JSX.Element {
  const active = mode === current
  return (
    <button
      type="button"
      data-testid={`files-search-mode-${mode}`}
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      onClick={() => onSelect(mode)}
      className={cn(
        'h-8 shrink-0 cursor-default rounded-field px-2 text-b2 transition-colors duration-(--motion-fast) ease-main',
        active ? 'bg-hover text-ink' : 'text-ink-secondary hover:bg-hover'
      )}
    >
      {label}
    </button>
  )
}

/**
 * 搜索结果（替掉树的那块内容）：`state === null` 就是"还没结果"（防抖中 / 请求在路上）→ spinner；
 * 错误与空结果都给一句人话；`truncated` 如实说明"只显示了一部分"（上限口径见主进程）。
 */
function SearchResults({
  state,
  mode,
  onOpen
}: {
  state: SearchState | null
  mode: WorkbenchSearchMode
  onOpen: (hit: WorkbenchSearchHit) => void
}): React.JSX.Element {
  if (state !== null && state.status === 'error') {
    return <ToolError testId="files-search-error" message={state.error ?? '搜索失败'} />
  }

  const result = state?.result
  if (result === undefined) {
    return (
      <div className="flex justify-center py-3">
        <Spinner label="搜索中" className="text-ink-tertiary" />
      </div>
    )
  }

  return (
    <>
      {result.results.length === 0 ? (
        <p data-testid="files-search-empty" className="px-3 py-3 text-b2 text-ink-secondary">
          {mode === 'name' ? '没有找到匹配的文件名' : '没有找到包含这段文字的文件'}
        </p>
      ) : (
        result.results.map((hit, index) => (
          <SearchHitRow key={`${hit.path}:${hit.line ?? 0}:${index}`} hit={hit} onOpen={onOpen} />
        ))
      )}
      {result.truncated ? (
        <p data-testid="files-search-truncated" className="px-3 py-2 text-b2 text-ink-tertiary">
          结果可能不全（只搜了一部分）
        </p>
      ) : null}
    </>
  )
}

/** 一条命中：第一行是文件名（内容命中在右端带行号），第二行是相对路径，内容命中再加一行预览 */
function SearchHitRow({
  hit,
  onOpen
}: {
  hit: WorkbenchSearchHit
  onOpen: (hit: WorkbenchSearchHit) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="file-search-hit"
      data-relative={hit.path}
      data-line={hit.line === undefined ? undefined : String(hit.line)}
      title={hit.path}
      onClick={() => onOpen(hit)}
      className="flex w-full cursor-default flex-col gap-0.5 px-3 py-1.5 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
    >
      <span className="flex w-full items-center gap-1.5">
        <FileIcon aria-hidden="true" className="size-(--icon-size-sm) shrink-0 text-ink-tertiary" />
        <span className="truncate text-b2 text-ink">{hit.name}</span>
        {hit.line === undefined ? null : (
          <span className="ml-auto shrink-0 text-c1 text-ink-tertiary tabular-nums">
            第 {hit.line} 行
          </span>
        )}
      </span>
      <span data-testid="file-search-path" className="truncate text-c1 text-ink-tertiary">
        {hit.path}
      </span>
      {hit.preview === undefined ? null : (
        <span data-testid="file-search-preview" className="truncate text-c1 text-ink-tertiary">
          {hit.preview}
        </span>
      )}
    </button>
  )
}
