/**
 * 工作台（右栏内容）：标签页 + 头部图标簇（新建 / 全屏 / 收起面板）+ 面板容器。
 *
 * 挂载策略（round 39 起是标签页模型）：**`tabs` 里的每个标签都挂着**，切标签只隐藏不卸载 ——
 * 终端切走必须保活（PTY 还在跑），浏览器切走也不该整页重载；**关掉标签才卸载**（终端的
 * dispose 因此跟着 Tag 卸载走到 TerminalTool 的收尾里，不泄漏）。隐藏走 `invisible + opacity-0`
 * （`transition-[opacity,visibility]`）：visibility 在过渡结束时才翻，所以淡出是完整的、不硬切（雷点 5）。
 *
 * 标签标题：浏览器 = 页面标题（webview 的 page-title-updated）→ 网址主机名兜底；文件 = 根目录名；
 * Git = 「改动」；终端 = 「终端」；预览 = 文件名（见 tabLabel）。过长的 CSS 截断（ellipsis + title 属性）。
 * 标签图标：四种工具各一个固定图标，**预览标签按文件类型**（见 tabIconOf / preview/file-icon.ts）。
 *
 * 面板底铺 `bg-surface`（与内容区同色，看不出差别）：万一 `<webview>` 这种原生客人不吃祖先的
 * visibility，后画的工具面板仍能把它盖住（浏览器是第一个标签，DOM 顺序在最后）。
 *
 * 空态（标签全关光）是居中一列动作条目，见 EmptyActions；那一列键帽与这里的窗口级快捷键
 * 共用 workbench-actions 的同一张表 —— 显示了就必须能用。监听挂在 window 上（面板收起也生效：
 * Workbench 随 WorkPanel 常驻，收起只是宽 0），但**焦点在 `<webview>` 里时收不到**（客人是
 * 独立上下文），不承诺跨 webview 生效。
 *
 * round 49：会话根由主进程按服务端映射解析，而渲染端的映射是**乐观**的（本地先补、PUT 在飞）——
 * 那段窗口（`settling`）里三件按根开工的工具先不挂，只给一圈 spinner（见 renderTool）。
 * 同轮（用户补充口径）：启动不再兜底一个「文件」标签（空态 = EmptyActions）；变根时标签不是清空，
 * 而是**按根存取**（switchRoot：旧根存起来、新根取上次的样子）——"切走再切回来还要有"。
 *
 * round 50：第五种标签 `preview`（文件预览，双击文件 / 右键「在新标签页中查看」来开，见 FilesTool）
 * 也走上面那套 —— 按 `${kind}:${rootPath}:${threadId}:${path}` 重挂（换会话/换根即重读该文件，
 * 不留旧根的内容；带路径的缘由见 panelKeyOf），且同样受 settling 门约束（那段窗口里主进程还按
 * 兜底根解析，读回来的是别的文件夹里的同名文件）。
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
import { Spinner } from '@renderer/components/ui/spinner'
import { useShellStore } from '@renderer/lib/shell-store'
import { EmptyActions } from './EmptyActions'
import { fileIconOf } from './preview/file-icon'
import { matchWorkbenchShortcut, WORKBENCH_ACTIONS } from './workbench-actions'
import { useWorkbenchRoot, type WorkbenchRoot } from './use-workbench-root'
import {
  browserTabTitle,
  useWorkbenchStore,
  type WorkbenchTab,
  type WorkbenchTabKind
} from './workbench-store'
import type { WebviewNavigateEvent, WebviewTitleEvent } from './webview-element'
import { BrowserTool } from './BrowserTool'
import { FilesTool } from './FilesTool'
import { GitTool } from './GitTool'
import { PreviewTool } from './PreviewTool'
import { TerminalTool } from './TerminalTool'

/** 工具的正式名（新建菜单与面板 aria-label 用；标签标题见 tabLabel） */
const TOOL_LABEL: Record<WorkbenchTabKind, string> = {
  browser: '浏览器',
  files: '文件',
  git: 'Git',
  terminal: '终端',
  preview: '预览'
}

const TAB_ICON: Record<Exclude<WorkbenchTabKind, 'preview'>, LucideIcon> = {
  browser: Globe,
  files: FolderTree,
  git: GitBranch,
  terminal: SquareTerminal
}

/**
 * 标签图标：预览标签按**文件类型**给（`fileIconOf` 是唯一出处 —— 与预览头部那个图标块同一张表），
 * 其余四种各是各的固定图标。
 */
function tabIconOf(tab: WorkbenchTab): LucideIcon {
  return tab.kind === 'preview' ? fileIconOf(tab.path ?? '') : TAB_ICON[tab.kind]
}

export function Workbench(): React.JSX.Element {
  const tabs = useWorkbenchStore((state) => state.tabs)
  const activeTabId = useWorkbenchStore((state) => state.activeTabId)
  const openTab = useWorkbenchStore((state) => state.openTab)
  const closeTab = useWorkbenchStore((state) => state.closeTab)
  const selectTab = useWorkbenchStore((state) => state.selectTab)
  const switchRoot = useWorkbenchStore((state) => state.switchRoot)
  const fullscreen = useShellStore((state) => state.workPanelFullscreen)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const toggleFullscreen = useShellStore((state) => state.toggleWorkPanelFullscreen)
  const setWorkPanelOpen = useShellStore((state) => state.setWorkPanelOpen)
  const root = useWorkbenchRoot()
  const rootPath = root.rootPath

  // A5（用户实报）+ round 49（用户补充口径）：**变根**（切项目 / 移至项目 / 默认工作区变化）→
  // 面板收起 + 标签换到新根的存根（没有存根 = 空态；旧根的标签存起来，切回来还在）。
  // 同根内切会话不走这里（面板不关；文件/Git/终端靠下面带根路径的 key 重挂清态）。
  // 首次进入那一下只对齐 currentRoot（启动一律空态），不算"变根"——不收起面板。
  const lastRootRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (lastRootRef.current === rootPath) return
    const first = lastRootRef.current === undefined
    lastRootRef.current = rootPath
    switchRoot(rootPath)
    if (!first) setWorkPanelOpen(false)
  }, [rootPath, switchRoot, setWorkPanelOpen])

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
            const Icon = tabIconOf(tab)
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
                // 浏览器与根无关，按标签 id 保活；预览还要带上**看的哪份文件**（见 panelKeyOf）。
                key={panelKeyOf(tab, rootPath, root.threadId)}
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
                {renderTool(tab.kind, root, active, tab)}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 面板的重挂键（缘由见上面 section 那截注释）：浏览器与根无关，按标签 id 保活；其余按
 * **会话 + 根路径**重挂。预览标签还要带上**看的哪份文件** —— 同根同会话下开两份不同文件的
 * 预览时不带路径就撞 key（React 的 "two children with the same key"），切标签时两份面板互相顶。
 */
function panelKeyOf(tab: WorkbenchTab, rootPath: string | null, threadId: string | null): string {
  if (tab.kind === 'browser') return tab.id
  const base = `${tab.kind}:${rootPath ?? 'none'}:${threadId ?? 'none'}`
  return tab.kind === 'preview' ? `${base}:${tab.path ?? ''}` : base
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
    case 'preview':
      // round 50：预览标签看的是**一份文件**，名字就是文件名（开标签时记进 title）
      return tab.title ?? TOOL_LABEL.preview
  }
}

/**
 * ＋ 菜单里的"新建"项：**空态那四行工具**（workbench-actions 那张表），不含预览 ——
 * 预览不是"新建一个空标签"能开的东西，它得先有一份文件（双击文件 / 右键来开）。
 */
function newTabItems(openTab: (kind: WorkbenchTabKind) => void): MenuEntry[] {
  return WORKBENCH_ACTIONS.map(({ kind, label, icon: Icon }) => ({
    id: kind,
    label,
    icon: <Icon aria-hidden="true" />,
    testId: `workbench-new-${kind}`,
    onSelect: () => openTab(kind)
  }))
}

function renderTool(
  kind: WorkbenchTabKind,
  root: WorkbenchRoot,
  active: boolean,
  tab: WorkbenchTab
): React.JSX.Element {
  // 会话根由主进程按服务端映射解析，而渲染端的映射是乐观的：归属还在写（settling）时主进程
  // 还按兜底根解析 —— 按根开工的几件**先别挂**（文件树会列到别的文件夹、终端会把 cwd
  // 起在兜底根上、Git 读的不是这个会话的仓库、预览读回来的会是另一个文件夹里的同名文件），
  // 而且它们都不会自己重来一次。浏览器与根无关，照常挂。回执落地后 settling 翻假，
  // 这里换成真工具（一次干净的挂载）。
  if (root.settling && kind !== 'browser') return <ToolSettling />
  switch (kind) {
    case 'browser':
      return <BrowserTool />
    case 'files':
      return <FilesTool root={root} />
    case 'git':
      return <GitTool root={root} />
    case 'terminal':
      return <TerminalTool root={root} active={active} />
    case 'preview':
      return <PreviewTool root={root} relative={tab.path ?? ''} />
  }
}

/** 归属还在写期间的占位：与三件工具自己的加载态同一观感（面板正中一圈 spinner） */
function ToolSettling(): React.JSX.Element {
  return (
    <div
      data-testid="workbench-settling"
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <Spinner label="加载中" className="text-ink-tertiary" />
    </div>
  )
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
