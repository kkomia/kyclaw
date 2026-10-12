/**
 * 「预览」标签（round 50）：右侧栏里**全幅**看一份文件 —— 与「文件」工具里单击的底部内联
 * 预览是**同一套预览管线**（格式分流在 `preview/modes.ts`，取内容走 `preview/fetch.ts`，
 * 渲染走 `preview/PreviewBody.tsx` 与它下面那批渲染器），数据走既有的
 * `workbench:read-file` / `workbench:read-bytes`（threadId + 工作区相对路径）。
 *
 * 顶部一行：文件名（点一下复制**绝对路径**）+ 重新读取（内容变了不用关标签重开）。
 *
 * 标签从哪来：`openPreviewTab(relPath)`（store 按 path 去重；见 workbench-store）。要看的相对路径
 * 由 Workbench 从标签上取下来传进来（**传进来的 `relative` 就是这份预览的根**：换个路径就是另一份
 * 预览状态，所以读回来的结果直接替换、不需要代次计数）。
 *
 * 归属还在写（settling）时先别读盘：与文件/Git/终端同一个道理 —— 主进程此刻还按兜底根解析，
 * 读回来的是另一个文件夹里的同名文件，而且不会重来（Workbench 的 renderTool 统一给占位）。
 * 换会话 / 换根由 Workbench 用 key 重挂（`preview:${rootPath}:${threadId}`）——重挂即重读，
 * 旧挂载的迟到响应落在已卸载的组件上（React 忽略）。
 */
import { FileText, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { ToolBar, ToolEmpty } from './bits'
import { PreviewBody } from './preview/PreviewBody'
import { baseNameOf, readPreview, type LoadedPreview } from './preview/fetch'
import { previewModeOf } from './preview/modes'
import { absoluteOf, type WorkbenchRoot } from './use-workbench-root'

export function PreviewTool({
  root,
  relative
}: {
  root: WorkbenchRoot
  /** 要看的文件（工作区相对路径；标签上的 `path`） */
  relative: string
}): React.JSX.Element {
  const { threadId, rootPath, ready, notice, workbench } = root
  // 初始就是"加载中"：挂载那次因此不用在 effect 里同步 setState（级联渲染）；
  // 渲染方式由路径算（纯函数），这里只放"读到什么了"
  const [state, setState] = useState<LoadedPreview>({
    mode: previewModeOf(relative),
    status: 'loading'
  })

  /** 拉数据（也用于刷新）；晚到的响应直接替换 —— 这个标签只看 `relative` 这一份文件 */
  const load = useCallback((): void => {
    if (workbench === null || threadId === null) return
    void readPreview(workbench, threadId, relative).then(setState, (error: unknown) =>
      setState({ mode: previewModeOf(relative), status: 'error', error: unwrapIpcError(error) })
    )
  }, [threadId, relative, workbench])

  useEffect(() => {
    if (ready) load()
  }, [ready, load])

  const reload = useCallback((): void => {
    setState({ mode: previewModeOf(relative), status: 'loading' })
    load()
  }, [relative, load])

  const copyPath = useCallback((): void => {
    if (rootPath === null) return
    void navigator.clipboard?.writeText(absoluteOf(rootPath, relative))
  }, [rootPath, relative])

  if (!ready) {
    return <ToolEmpty testId="preview-notice" icon={FileText} title={notice ?? '预览不可用'} />
  }

  const name = baseNameOf(relative)

  return (
    <div
      data-testid="preview-tool"
      data-relative={relative}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ToolBar className="justify-between">
        {/* 文件名（点一下复制绝对路径）——标题属性给全文，页内空间不够时不硬挤 */}
        <button
          type="button"
          data-testid="preview-name"
          title={rootPath === null ? relative : absoluteOf(rootPath, relative)}
          onClick={copyPath}
          className="min-w-0 cursor-default truncate rounded-control px-1 py-0.5 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
        >
          {name === '' ? '预览' : name}
        </button>
        <IconButton
          data-testid="preview-refresh"
          label="重新读取"
          icon={<RotateCw />}
          onClick={reload}
          className="border-transparent hover:bg-hover"
        />
      </ToolBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <PreviewBody relative={relative} state={state} mode={previewModeOf(relative)} />
      </div>
    </div>
  )
}
