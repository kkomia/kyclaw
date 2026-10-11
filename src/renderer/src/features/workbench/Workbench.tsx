/**
 * 工作台（右栏内容）：标签页 + 头部图标簇（新建 / 全屏 / 收起面板）+ 面板容器。
 *
 * 挂载策略（round 39 起是标签页模型）：**`tabs` 里的每个标签都挂着**，切标签只隐藏不卸载 ——
 * 终端切走必须保活（PTY 还在跑），浏览器切走也不该整页重载；**关掉标签才卸载**（终端的
 * dispose 因此跟着 Tag 卸载走到 TerminalTool 的收尾里，不泄漏）。隐藏走 `invisible + opacity-0`
 * （`transition-[opacity,visibility]`）：visibility 在过渡结束时才翻，所以淡出是完整的、不硬切（雷点 5）。
 *
 * 标签标题：浏览器 = 页面标题（webview 的 page-title-updated）→ 网址主机名兜底；文件 = 根目录名；
 * Git = 「改动」；终端 = 「终端」。过长的 CSS 截断（ellipsis + title 属性）。
 *
 * 面板底铺 `bg-surface`（与内容区同色，看不出差别）：万一 `<webview>` 这种原生客人不吃祖先的
 * visibility，后画的工具面板仍能把它盖住（浏览器是第一个标签，DOM 顺序在最后）。
 *
 * 空态（标签全关光）是居中一列动作条目，见 EmptyActions；那一列键帽与这里的窗口级快捷键
 * 共用 workbench-actions 的同一张表 —— 显示了就必须能用。监听挂在 window 上（面板收起也生效：
 * Workbench 随 WorkPanel 常驻，收起只是宽 0），但**焦点在 `<webview>` 里时收不到**（客人是
 * 独立上下文），不承诺跨 webview 生效。
 */
import {
  FolderTree,
  GitBranch,
  Globe,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  SquareTerminal,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { useShellStore } from '@renderer/lib/shell-store'
import { EmptyActions } from './EmptyActions'
import { matchWorkbenchShortcut } from './workbench-actions'
import { useWorkbenchRoot, type WorkbenchRoot } from './use-workbench-root'
import {
  browserTabTitle,
  useWorkbenchStore,
  WORKBENCH_KINDS,
  type WorkbenchTab,
  type WorkbenchTabKind
} from './workbench-store'
import type { WebviewNavigateEvent, WebviewTitleEvent } from './webview-element'
import { BrowserTool } from './BrowserTool'
import { FilesTool } from './FilesTool'
import { GitTool } from './GitTool'
import { TerminalTool } from './TerminalTool'

/** 工具的正式名（新建菜单与面板 aria-label 用；标签标题见 tabLabel） */
const TOOL_LABEL: Record<WorkbenchTabKind, string> = {
  browser: '浏览器',
  files: '文件',
  git: 'Git',
  terminal: '终端'
}

const TAB_ICON: Record<WorkbenchTabKind, LucideIcon> = {
  browser: Globe,
  files: FolderTree,
  git: GitBranch,
  terminal: SquareTerminal
}

export function Workbench(): React.JSX.Element {
  const tabs = useWorkbenchStore((state) => state.tabs)
  const activeTabId = useWorkbenchStore((state) => state.activeTabId)
  const openTab = useWorkbenchStore((state) => state.openTab)
  const closeTab = useWorkbenchStore((state) => state.closeTab)
  const selectTab = useWorkbenchStore((state) => state.selectTab)
  const resetWorkbench = useWorkbenchStore((state) => state.resetWorkbench)
  const fullscreen = useShellStore((state) => state.workPanelFullscreen)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const toggleFullscreen = useShellStore((state) => state.toggleWorkPanelFullscreen)
  const setWorkPanelOpen = useShellStore((state) => state.setWorkPanelOpen)
  const root = useWorkbenchRoot()
  const rootPath = root.rootPath

  // A5（用户实报）：**变根**（切项目 / 移至项目 / 默认工作区变化）→ 面板收起 + 标签回默认。
  // 同根内切会话不走这里（面板不关；文件/Git/终端靠下面带根路径的 key 重挂清态）。
  // 首次渲染不触发（初始值就是当前根），否则会平白把用户刚打开的面板关掉。
  const lastRootRef = useRef(rootPath)
  useEffect(() => {
    if (lastRootRef.current === rootPath) return
    lastRootRef.current = rootPath
    setWorkPanelOpen(false)
    resetWorkbench()
  }, [rootPath, resetWorkbench, setWorkPanelOpen])

  // 空态那列键帽对应的快捷键（表在 workbench-actions：显示的组合就是这里接的组合）。
  // 挂在 window 上而不是面板容器上：面板收起也生效（Workbench 常驻，收起只是宽 0）。
  // 命中就吞掉事件，别再冒到别处（Electron 里也避免触发默认动作）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const kind = matchWorkbenchShortcut(event)
      if (kind === null) return
      event.preventDefault()
      openTab(kind)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openTab])

  return (
    <div data-testid="workbench" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline pr-2 pl-1">
        <div
          role="tablist"
          aria-label="工作台标签页"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTabId
            const label = tabLabel(tab, root)
            const Icon = TAB_ICON[tab.kind]
            return (
              <div
                key={tab.id}
                role="presentation"
                className="group relative flex h-7 shrink-0 items-center"
              >
                <button
                  type="button"
                  id={`workbench-tab-${tab.id}`}
                  role="tab"
                  aria-selected={active}
                  aria-controls={`workbench-panel-${tab.id}`}
                  data-testid="workbench-tab"
                  title={label}
                  onClick={() => selectTab(tab.id)}
                  className={cn(
                    'flex h-7 max-w-44 min-w-0 cursor-default items-center gap-1.5 rounded-control pr-6 pl-2 text-b2 transition-colors duration-(--motion-fast) ease-main',
                    active ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
                  )}
                >
                  <Icon aria-hidden="true" className="size-(--icon-size-sm) shrink-0" />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
                {/* 关闭 ×：激活或 hover 时可见（也可键盘 Tab 到它 —— focus-visible 同样显出来） */}
                <button
                  type="button"
                  data-testid="workbench-tab-close"
                  aria-label={`关闭 ${label}`}
                  onClick={() => closeTab(tab.id)}
                  className={cn(
                    'absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-control text-ink-tertiary transition-[opacity,background-color,color] duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink focus-visible:opacity-100',
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Menu
            trigger={
              <IconButton
                data-testid="workbench-new-tab"
                label="新建标签页"
                icon={<Plus />}
                className="border-transparent hover:bg-hover"
              />
            }
            items={newTabItems(openTab)}
            align="end"
            tooltip="新建标签页"
          />
          <IconButton
            data-testid="workbench-fullscreen"
            label={fullscreen ? '回到窗口化' : '面板全屏'}
            icon={fullscreen ? <Minimize2 /> : <Maximize2 />}
            onClick={toggleFullscreen}
            className="border-transparent hover:bg-hover"
          />
          {/* 收起面板。面板**没开**时这里不画：那时"工作台开关"是内容卡右上角的浮动 ▯（AppShell）。
              外层 span 只为延续既有 e2e 契约（walkthrough 用 work-panel-toggle 收起面板）——
              它和浮动 ▯ 是同一个开关的两种摆法，所以沿用同一 testid（Playwright 点容器中心 =
              点到里面的按钮）；关面板时全屏的复位在 store 的 setWorkPanelOpen 里 */}
          {workPanelOpen ? (
            <span data-testid="work-panel-toggle" className="inline-flex">
              <IconButton
                data-testid="workbench-close"
                label="收起工作台"
                icon={<PanelRight />}
                onClick={() => setWorkPanelOpen(false)}
                className="border-transparent hover:bg-hover"
              />
            </span>
          ) : null}
        </div>
      </div>

      {tabs.length === 0 ? (
        <EmptyActions openTab={openTab} />
      ) : (
        <div className="relative min-h-0 flex-1">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId
            return (
              <section
                // 依赖会话根的三件（文件/Git/终端）按**会话 + 根路径**重挂：换会话是现状（状态自然清空、
                // 终端的 cwd 跟到新会话的根），换根（"移至项目"：threadId 不变而根变了）也重挂 ——
                // 只按会话号缓存会留下旧目录的清单，就是用户报的"这个文件夹不在磁盘上"。
                // 浏览器与根无关，按标签 id 保活。
                key={
                  tab.kind === 'browser'
                    ? tab.id
                    : `${tab.kind}:${rootPath ?? 'none'}:${root.threadId ?? 'none'}`
                }
                id={`workbench-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`workbench-tab-${tab.id}`}
                data-testid="workbench-panel"
                data-kind={tab.kind}
                data-tab-id={tab.id}
                data-active={active ? 'true' : 'false'}
                inert={!active}
                className={cn(
                  'absolute inset-0 flex min-h-0 flex-col bg-surface transition-[opacity,visibility] duration-(--motion-main) ease-main',
                  active ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
                )}
              >
                {tab.kind === 'browser' ? <BrowserTabTitle tabId={tab.id} /> : null}
                {renderTool(tab.kind, root, active)}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 标签标题：文件 = 根目录名（拿不到给「文件」），其余见 workbench-store 的说明 */
function tabLabel(tab: WorkbenchTab, root: WorkbenchRoot): string {
  switch (tab.kind) {
    case 'browser':
      return tab.title ?? TOOL_LABEL.browser
    case 'files':
      return root.rootName ?? TOOL_LABEL.files
    case 'git':
      return '改动'
    case 'terminal':
      return TOOL_LABEL.terminal
  }
}

function newTabItems(openTab: (kind: WorkbenchTabKind) => void): MenuEntry[] {
  return WORKBENCH_KINDS.map((kind) => {
    const Icon = TAB_ICON[kind]
    return {
      id: kind,
      label: TOOL_LABEL[kind],
      icon: <Icon aria-hidden="true" />,
      testId: `workbench-new-${kind}`,
      onSelect: () => openTab(kind)
    }
  })
}

function renderTool(
  kind: WorkbenchTabKind,
  root: WorkbenchRoot,
  active: boolean
): React.JSX.Element {
  switch (kind) {
    case 'browser':
      return <BrowserTool />
    case 'files':
      return <FilesTool root={root} />
    case 'git':
      return <GitTool root={root} />
    case 'terminal':
      return <TerminalTool root={root} active={active} />
  }
}

/**
 * 浏览器标签的标题桥：webview 的 `page-title-updated` → 页面标题，导航事件 → 网址主机名兜底，
 * 报给 store 供标签显示（BrowserTool 自己那份标题不动，两处互不干涉）。
 * 只会读、不写 DOM：宿主 section 里找那一个 webview（同一标签只有它一个客人）。
 */
function BrowserTabTitle({ tabId }: { tabId: string }): React.JSX.Element {
  const setTabTitle = useWorkbenchStore((state) => state.setTabTitle)
  const anchorRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const webview = anchorRef.current?.closest('section')?.querySelector('webview')
    if (webview === null || webview === undefined) return

    let title = ''
    let url = ''
    const publish = (): void => setTabTitle(tabId, browserTabTitle(title, url))
    const onTitle = (event: Event): void => {
      title = (event as WebviewTitleEvent).title ?? ''
      publish()
    }
    const onNavigate = (event: Event): void => {
      url = (event as WebviewNavigateEvent).url ?? ''
      publish()
    }

    // 挂上时先读一遍现况（切走再切回、或整个面板重挂时的补读；客人还没挂上就静默跳过）
    try {
      const node = webview as HTMLElement & { getTitle?: () => string; getURL?: () => string }
      title = node.getTitle?.() ?? ''
      url = node.getURL?.() ?? ''
    } catch {
      // 环境里没有 webview 实现：保持空标题（显示兜底名）
    }
    publish()

    webview.addEventListener('page-title-updated', onTitle)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      webview.removeEventListener('page-title-updated', onTitle)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [tabId, setTabTitle])

  return <span ref={anchorRef} className="hidden" />
}
