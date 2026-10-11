/**
 * 「文件」工具：会话根的懒加载目录树 + 单击文件的内联预览 + 自绘右键菜单。
 *
 * 数据流：`workbench:list-dir` 一次只列**一层**（根 = `''`），子目录展开时再列 —— 目录内容按
 * 相对路径缓存在本组件里（展开过一次的路径不重复请求）。单击文件 → `workbench:read-file`
 * 拿有界预览（文本 64KB / 二进制 / 过大三种判别结果）。路径解析与 containment 全在主进程：
 * 这里只递相对路径，绝对路径只用来拼"复制路径"的文本。
 *
 * 会话切换（threadId 变）时整棵树清空重来，并用"代次"丢弃晚到的响应（旧会话的目录不会再画回来）。
 */
import {
  ChevronRight,
  Copy,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderSearch
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { DirEntry, FilePreview } from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/spinner'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { BottomSheet, RefreshButton, ToolBar, ToolEmpty, ToolError } from './bits'
import { ContextMenu, type ContextMenuState } from './ContextMenu'
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

interface PreviewState {
  /** 属于哪个线程（晚到的响应据此丢弃） */
  threadId: string
  relative: string
  status: 'loading' | 'ready' | 'error'
  value?: FilePreview
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
      setPreview({ threadId, relative, status: 'loading' })
      void workbench.readFile(threadId, relative).then(
        (value) => setPreview({ threadId, relative, status: 'ready', value }),
        (error: unknown) =>
          setPreview({ threadId, relative, status: 'error', error: unwrapIpcError(error) })
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
        <BottomSheet
          testId="file-preview"
          title={baseName(preview.relative)}
          onClose={() => setPreview(null)}
        >
          <PreviewBody state={preview} />
        </BottomSheet>
      )}

      {menu === null ? null : <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function baseName(relative: string): string {
  const index = relative.lastIndexOf('/')
  return index === -1 ? relative : relative.slice(index + 1)
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

/** 预览体：文本档原样（monospace、换行保留）；二进制/过大给人话 */
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
  if (value.kind === 'binary') {
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(value.size)}）
      </p>
    )
  }
  if (value.kind === 'too-large') {
    return (
      <p data-testid="file-preview-large" className="px-3 py-2 text-b2 text-ink-secondary">
        文件太大（{formatBytes(value.size)}），不适合在这里预览
      </p>
    )
  }

  return (
    <div data-testid="file-preview-text" className="px-3 py-2">
      <pre className="font-mono text-b2 whitespace-pre-wrap break-all text-ink">{value.text}</pre>
      {value.truncated ? (
        <p className="pt-2 text-b2 text-ink-tertiary">
          只显示前面一部分（共 {formatBytes(value.size)}）
        </p>
      ) : null}
    </div>
  )
}
