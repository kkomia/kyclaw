/**
 * 「文件」工具：会话根的懒加载目录树 + 单击文件的内联预览 + 自绘右键菜单。
 *
 * 数据流：`workbench:list-dir` 一次只列**一层**（根 = `''`），子目录展开时再列 —— 目录内容按
 * 相对路径缓存在本组件里（展开过一次的路径不重复请求）。单击文件 → `workbench:read-file`
 * 拿有界预览（文本 64KB / 二进制 / 过大三种判别结果）。路径解析与 containment 全在主进程：
 * 这里只递相对路径，绝对路径只用来拼"复制路径"的文本。
 *
 * 会话切换（threadId 变）时整棵树清空重来，并用"代次"丢弃晚到的响应（旧会话的目录不会再画回来）。
 *
 * round 42：右键菜单首项「添加到上下文」（仅文件）与预览区选中的「添加到上下文（摘选）」
 * 走 composer-inbox 的事件通道进输入卡的附件条；这里只发布"哪个会话的哪个文件 / 哪段摘选"，
 * 读文件与上限判定都在订阅方（Composer）做。
 */
import {
  ChevronRight,
  Copy,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderSearch,
  MessageSquarePlus,
  TextSelect
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { DirEntry, FileBytesResult, FilePreview } from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/spinner'
import { linesOfSelection, publishContextItem } from '@renderer/features/chat/composer-inbox'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { BottomSheet, RefreshButton, ToolBar, ToolEmpty, ToolError } from './bits'
import { ContextMenu, type ContextMenuState, type ContextMenuItem } from './ContextMenu'
import { ImagePreview } from './preview/ImagePreview'
import { MarkdownPreview } from './preview/MarkdownPreview'
import { PdfPreview } from './preview/PdfPreview'
import { previewModeOf, type PreviewMode } from './preview/modes'
import { absoluteOf, type WorkbenchRoot } from './use-workbench-root'
import { formatBytes } from './format'

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

/** 预览拿到的值：文本通道（`FilePreview`）与字节通道（`FileBytesResult`）各一路 */
type PreviewValue =
  { channel: 'text'; preview: FilePreview } | { channel: 'bytes'; bytes: FileBytesResult }

interface PreviewState {
  /** 属于哪个线程（晚到的响应据此丢弃） */
  threadId: string
  relative: string
  /** 按后缀定下来的渲染方式（决定走哪条通道、哪个组件） */
  mode: PreviewMode
  status: 'loading' | 'ready' | 'error'
  value?: PreviewValue
  error?: string
}

export function FilesTool({ root }: { root: WorkbenchRoot }): React.JSX.Element {
  const { threadId, rootPath, ready, notice, workbench } = root
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

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
      setPreview({ threadId, relative, mode, status: 'loading' })
      // 图片 / PDF 走字节通道（文本通道 64KB 且只给字符串，承载不了真渲染）
      const request =
        mode === 'image' || mode === 'pdf'
          ? workbench
              .readBytes(threadId, relative)
              .then((bytes): PreviewValue => ({ channel: 'bytes', bytes }))
          : workbench
              .readFile(threadId, relative)
              .then((preview): PreviewValue => ({ channel: 'text', preview }))
      void request.then(
        (value) => setPreview({ threadId, relative, mode, status: 'ready', value }),
        (error: unknown) =>
          setPreview({ threadId, relative, mode, status: 'error', error: unwrapIpcError(error) })
      )
    },
    [threadId, workbench]
  )

  const toggleDir = useCallback(
    (relative: string): void => {
      const open = expanded.includes(relative)
      setExpanded((prev) => (open ? prev.filter((path) => path !== relative) : [...prev, relative]))
      if (!open && dirs[relative] === undefined) loadDir(relative)
    },
    [dirs, expanded, loadDir]
  )

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
      publishContextItem({ source: 'file', threadId, relative, name: baseName(relative) })
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
        name: `${baseName(state.relative)} 摘选`,
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
    <div data-testid="files-tool" className="flex min-h-0 flex-1 flex-col">
      <ToolBar className="justify-between">
        <span
          data-testid="files-root"
          title={rootPath ?? ''}
          className="min-w-0 truncate px-1 text-b2 text-ink-secondary"
        >
          {root.rootName ?? ''}
        </span>
        <RefreshButton label="刷新目录树" testId="files-refresh" onClick={() => loadDir('')} />
      </ToolBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {rootDir === undefined ? (
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
            title={baseName(preview.relative)}
            onClose={() => setPreview(null)}
          >
            <div ref={previewBodyRef} data-testid="file-preview-body">
              <PreviewBody state={preview} />
            </div>
          </BottomSheet>
        </div>
      )}

      {menu === null ? null : <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function baseName(relative: string): string {
  const index = relative.lastIndexOf('/')
  return index === -1 ? relative : relative.slice(index + 1)
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
  onContext
}: {
  relative: string
  depth: number
  entry: DirEntry
  onChoose: (relative: string) => void
  onContext: (event: React.MouseEvent, relative: string, isDir: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="file-row"
      data-kind="file"
      data-relative={relative}
      onClick={() => onChoose(relative)}
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

/**
 * 预览体：按格式分派 ——
 *   - `.md` / `.markdown`：走 markdown 渲染器（内容仍来自文本通道）；
 *   - 图片 / `.pdf`：走字节通道，渲染端真画（data URL / pdfjs canvas）；
 *   - 其余：文本档原样（monospace、换行保留）；二进制/过大给人话。
 */
function PreviewBody({ state }: { state: PreviewState }): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-4">
        <Spinner label="加载中" className="text-ink-tertiary" />
      </div>
    )
  }
  if (state.status === 'error') {
    return <ToolError testId="file-preview-error" message={state.error ?? '读不了这个文件'} />
  }

  const value = state.value
  if (value === undefined) return <div />
  if (value.channel === 'bytes') {
    // key 绑文件名：换文件即重挂，免得上一个文件的状态（坏图标记 / 已画页数）跟过来
    return <BytesBody key={state.relative} mode={state.mode} result={value.bytes} />
  }
  return <TextBody mode={state.mode} preview={value.preview} />
}

/** 文本通道的那三种结果（markdown 只是把它们里的 `text` 过一遍渲染器） */
function TextBody({
  mode,
  preview
}: {
  mode: PreviewMode
  preview: FilePreview
}): React.JSX.Element {
  if (preview.kind === 'binary') {
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(preview.size)}）
      </p>
    )
  }
  if (preview.kind === 'too-large') {
    return (
      <p data-testid="file-preview-large" className="px-3 py-2 text-b2 text-ink-secondary">
        文件太大（{formatBytes(preview.size)}），不适合在这里预览
      </p>
    )
  }

  return (
    <div className="py-2">
      {mode === 'markdown' ? (
        <MarkdownPreview text={preview.text} />
      ) : (
        <div data-testid="file-preview-text" className="px-3">
          <pre className="font-mono text-b2 whitespace-pre-wrap break-all text-ink">
            {preview.text}
          </pre>
        </div>
      )}
      {preview.truncated ? (
        <p className="px-3 pt-2 text-b2 text-ink-tertiary">
          只显示前面一部分（共 {formatBytes(preview.size)}）
        </p>
      ) : null}
    </div>
  )
}

/** 字节通道：认得出的格式交给对应的渲染器；其余三种给人话（与文本档同口径） */
function BytesBody({
  mode,
  result
}: {
  mode: PreviewMode
  result: FileBytesResult
}): React.JSX.Element {
  if (result.kind === 'missing') {
    return (
      <p data-testid="file-preview-missing" className="px-3 py-2 text-b2 text-ink-secondary">
        这个文件不在磁盘上了（可能刚被删除或改名）
      </p>
    )
  }
  if (result.kind === 'too-large') {
    return (
      <p data-testid="file-preview-large" className="px-3 py-2 text-b2 text-ink-secondary">
        文件太大（{formatBytes(result.size)}），不适合在这里预览
      </p>
    )
  }
  if (result.kind === 'unsupported') {
    // 后缀认得、内容对不上暗号（或后缀不认得）：按二进制占位，不猜、不硬画
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(result.size)}）
      </p>
    )
  }

  return mode === 'pdf' ? (
    <PdfPreview bytes={result.bytes} />
  ) : (
    <ImagePreview format={result.format} bytes={result.bytes} />
  )
}
