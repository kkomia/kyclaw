/**
 * 「预览」标签（round 50）：右侧栏里**全幅**看一份文件 —— 与「文件」工具里单击的底部内联
 * 预览是**同一套预览管线**（格式分流在 `preview/modes.ts`，取内容走 `preview/fetch.ts`，
 * 渲染走 `preview/PreviewBody.tsx` 与它下面那批渲染器），数据走既有的
 * `workbench:read-file` / `workbench:read-bytes`（threadId + 工作区相对路径）。
 *
 * 顶部一条（round 52 重做，对齐"别再是一行光文件名"那条用户要求）：**文件类型图标块 + 文件名 +
 * 相对路径**——图标按后缀走 `preview/file-icon.ts`（与预览标签的 tab 图标同一张表，唯一出处）；
 * 文件名点一下复制**绝对路径**；右侧「用本地应用打开」（`workbench:open`，round 77）、
 * 「在文件资源管理器中定位」（既有 `workbench:reveal` 通道）与「重新读取」（内容变了不用关标签重开）。
 *
 * round 55：**根目录文件不画那行相对路径**。此时 relative === 文件名（`baseNameOf` 就是它自己），
 * 两行逐字同名，加上标签页标题就是三处重复（用户实拍）。深层文件照旧显示整条相对路径（那才有
 * "在根的哪儿"这层信息）。
 *
 * 标签从哪来：`openPreviewTab(relPath)`（store 按 path 去重；见 workbench-store）。要看的相对路径
 * 由 Workbench 从标签上取下来传进来（**传进来的 `relative` 就是这份预览的根**：换个路径就是另一份
 * 预览状态，所以读回来的结果直接替换、不需要代次计数）。
 *
 * 归属还在写（settling）时先别读盘：与文件/Git/终端同一个道理 —— 主进程此刻还按兜底根解析，
 * 读回来的是另一个文件夹里的同名文件，而且不会重来（Workbench 的 renderTool 统一给占位）。
 * 换会话 / 换根由 Workbench 用 key 重挂（`preview:${rootPath}:${threadId}:${path}`）——重挂即重读，
 * 旧挂载的迟到响应落在已卸载的组件上（React 忽略）。
 *
 * round 53：选中文字的自绘右键菜单与内联预览那一路**同一份共享件**
 * （`preview/SelectionContextMenu`）：整块预览区（头部 + 正文）的原生右键都拦下，
 * 「添加到上下文（摘选）」发布的路径就是本标签的 `relative`。
 */
import { FileText, FolderSearch, RotateCw, SquareArrowOutUpRight } from 'lucide-react'
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { ToolEmpty } from './bits'
import { PreviewBody } from './preview/PreviewBody'
import { baseNameOf, readPreview, sourceTextOf, type LoadedPreview } from './preview/fetch'
import { fileIconOf } from './preview/file-icon'
import { previewModeOf } from './preview/modes'
import { SelectionContextMenu } from './preview/SelectionContextMenu'
import { absoluteOf, type WorkbenchRoot } from './use-workbench-root'

/**
 * 头部图标块那个图标：按后缀走唯一那张表（`preview/file-icon.ts`，与标签页图标同表）。
 * 这里用 `createElement` 而不是 `const Icon = fileIconOf(...)`：`react-hooks/static-components`
 * （React 编译器那套规则）会把"直接拿 `fileIconOf(...)` 的返回值当 JSX 组件用"判成
 * "渲染中造组件"—— 它看不穿跨模块的映射表；`createElement` 传的是元素类型，不是新造的组件。
 */
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

  /** 「全选」的落点：正文滚动区（头部那两行文件名 / 路径不算 —— 与内联预览的口径一致） */
  const bodyRef = useRef<HTMLDivElement>(null)

  /** 在资源管理器里定位（既有 `workbench:reveal` 通道）。失败与"读不了这个文件"共用一个收口 */
  const reveal = useCallback((): void => {
    if (workbench === null || threadId === null) return
    void workbench.reveal(threadId, relative).then(
      () => undefined,
      (error: unknown) =>
        setState({ mode: previewModeOf(relative), status: 'error', error: unwrapIpcError(error) })
    )
  }, [threadId, relative, workbench])

  /**
   * 用本机的默认应用打开这份文件（`workbench:open`）—— 用户个人 PC 上通常装了 Word / WPS / Excel 之一，
   * 想看/想改就直接交给它们。失败与上面两条共用一个收口（把话露在预览区里，不假装打开）。
   */
  const openWithApp = useCallback((): void => {
    if (workbench === null || threadId === null) return
    void workbench.open(threadId, relative).then(
      () => undefined,
      (error: unknown) =>
        setState({ mode: previewModeOf(relative), status: 'error', error: unwrapIpcError(error) })
    )
  }, [threadId, relative, workbench])

  if (!ready) {
    return <ToolEmpty testId="preview-notice" icon={FileText} title={notice ?? '预览不可用'} />
  }

  const name = baseNameOf(relative)
  // 根目录文件（相对路径里没有分隔符）：路径与文件名逐字相同，不重复画（见头注 round 55）
  const inSubdirectory = /[\\/]/.test(relative)
  const icon = createElement(fileIconOf(relative), {
    'aria-hidden': true,
    className: 'size-(--icon-size-md)'
  })

  return (
    <div
      data-testid="preview-tool"
      data-relative={relative}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* 整块（头部 + 正文）包进选区菜单：原生右键一律拦掉，选中文字后右键多一档
          「添加到上下文（摘选）」——与文件树里单击的内联预览同一份共享件 */}
      <SelectionContextMenu
        threadId={threadId}
        relative={relative}
        sourceText={sourceTextOf(state)}
        bodyRef={bodyRef}
      >
        {/* 文件类型图标块 + 文件名（醒目档）+ 相对路径（次要色、截断；根目录文件没有这一行 ——
            它与文件名逐字相同）：一块圆角底色托图标，两层文字靠字号与颜色分层 —— 不叠框线（雷点 7） */}
        <div className="flex shrink-0 items-center gap-2.5 px-3 py-2">
          <span
            data-testid="preview-icon"
            className="flex size-9 shrink-0 items-center justify-center rounded-button-lg bg-secondary text-ink-secondary"
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            {/* 文件名（点一下复制绝对路径）——标题属性给全文，页内空间不够时不硬挤 */}
            <button
              type="button"
              data-testid="preview-name"
              title={rootPath === null ? relative : absoluteOf(rootPath, relative)}
              onClick={copyPath}
              className="block max-w-full cursor-default truncate rounded-control text-left text-b1 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
            >
              {name === '' ? '预览' : name}
            </button>
            {inSubdirectory ? (
              <p
                data-testid="preview-path"
                title={relative}
                className="truncate text-b2 text-ink-tertiary"
              >
                {relative}
              </p>
            ) : null}
          </div>
          <IconButton
            data-testid="preview-open"
            label="用本地应用打开"
            icon={<SquareArrowOutUpRight />}
            onClick={openWithApp}
            className="border-transparent hover:bg-hover"
          />
          <IconButton
            data-testid="preview-reveal"
            label="在文件资源管理器中定位"
            icon={<FolderSearch />}
            onClick={reveal}
            className="border-transparent hover:bg-hover"
          />
          <IconButton
            data-testid="preview-refresh"
            label="重新读取"
            icon={<RotateCw />}
            onClick={reload}
            className="border-transparent hover:bg-hover"
          />
        </div>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto pb-2">
          <PreviewBody relative={relative} state={state} mode={previewModeOf(relative)} />
        </div>
      </SelectionContextMenu>
    </div>
  )
}
