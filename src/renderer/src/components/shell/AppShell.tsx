import { PanelRightOpen } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { Outlet, useLocation } from 'react-router'
import {
  isWorkPanelSpaceConstrained,
  shouldAutoCollapseSidebar,
  useShellStore
} from '@renderer/lib/shell-store'
import { startupMark } from '@renderer/lib/startup-timing'
import { OfficeQuitDialog } from '@renderer/features/office/OfficeQuitDialog'
import { useOfficeDirtyReporter } from '@renderer/features/office/use-office-dirty-reporter'
import { SettingsNav } from '@renderer/features/settings/SettingsNav'
import { SessionsController } from '@renderer/features/sessions/SessionsController'
import { useNewSessionShortcut } from '@renderer/features/sessions/use-new-session-shortcut'
import { Workbench } from '@renderer/features/workbench/Workbench'
import { IconButton } from '../ui/icon-button'
import { ContentRegion } from './ContentRegion'
import { MainColumn } from './MainColumn'
import { PrimaryNav } from './PrimaryNav'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { WorkPanel } from './WorkPanel'

/** jsdom 量不到布局（自定义属性为空）时的兜底值，与语义层 token 同值，见 tokens.spec 的钉死用例。 */
const SIDEBAR_WIDTH_FALLBACK = 240
const SHELL_EDGE_GAP_FALLBACK = 6
const CHAT_MIN_READABLE_FALLBACK = 480

/** 读一条长度型 token（未注册 / 量不到时退回兜底；只认 px 的数值部分） */
function readLengthToken(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 应用壳（spec §6.2 三栏骨架）：顶栏 42 + 一级导航（图标栏）+ 内容区（一张四角圆角卡）。
 *
 * 2026-10-17 用户拍板（参考 Codex 布局）的两条布局口径：
 *   A. 一级导航**只有图标栏一种形态**（--primary-nav-rail-width = 56，无展开态、无收放开关，
 *      见 PrimaryNav）；它仍是 flow 的一根竖栏，内容区从它右缘开始。
 *   B. 会话二级栏（Sidebar）**并进内容卡内部**：一张圆角卡（--bg-surface）里从左到右是
 *      二级栏 | 主列 | 工作台，会话侧栏与主对话之间只有一条 1px hairline 竖线；
 *      侧栏在设置页装设置菜单，笔记/知识库/Office 没有二级栏（见 showSidebar）。
 *      侧栏折叠（TitleBar 的开合钮，props 语义不变）在卡内做宽度动画收成 0 ——
 *      主列是它的 flex 兄弟，几何跟着 flow 变，不再需要覆盖层时代的"可见左缘"补丁
 *      （shell-notch / --content-safe-left 的 CSS 机制随之删除；token 仍留 0px 是因为
 *      ChatPage.tsx 还引用着 ml-/pl-(--content-safe-left)，值恒 0 无行为，属后续清理项）。
 *
 * 布局状态只从这里接 store 的分档，往下大多是 props —— Sidebar / MainColumn / ContentRegion /
 * WorkPanel 自身不订阅 store（好单测）；Workbench 是历史例外，它直接读 store 的全屏偏好与布局事实。
 * 内容区里的中列渲染当前路由（布局路由的 <Outlet/>）；一级模块共用 ModuleHost，主对话常驻不卸载。
 *
 * 两层"面"：壳 = 画布色（--bg-canvas，顶栏与一级导航同一层）；内容区 = 抬起来的一块面
 * （--bg-surface，四角圆角 + 右/底留缝）。右栏（工作台）就在这块面里面，靠分隔线分界，不是第三根柱子。
 *
 * 窄窗兜底（round 77 用户口径，替换 R2 D4 的"自动收面板"）：可用宽不够时**不关面板、也不挤压聊天**，
 * 而是让工作台临时铺满内容区（中列挂 `hidden` 让位但不卸载 —— 聊天状态、工作台标签、终端 PTY 都留着）。
 * 判据是实测的：内容卡宽 − 侧栏占宽（展开 240 / 收起 0）− 工作台**实际**宽（拖过的也算）
 * < --chat-min-readable-width(480) ⇒ 空间不足。所以没有"1120 那种固定阈值"：收侧栏、拖窄面板、
 * 拉宽窗口都会立刻重新判定；关面板回聊天，宽窗自动恢复分栏。这层结论只写 `workPanelFit`
 * （布局结果），**用户的全屏偏好一个字节都不动**。
 *
 * round 78（实机陷阱）：把面板拖到越界（如 1280 拖到 560）后既没有把手也按不动 ⤢，回不去并排。
 * 现在这套"铺满"由 Workbench 头部给出**真动作**：能并排就"恢复并排布局"（把宽度收到上限，见
 * store 的 restoreSideBySideLayout），确实太窄（< min 面板 280 + min 聊天 480）就"返回对话"关面板。
 *
 * round 48（用户口径）：工作台面板属于对话区——切到对话以外的页面（设置/插件等）自动收起，
 * 面板状态与标签保留，回到对话由用户再自己展开。
 *
 * round 64（用户口径）：全局快捷键 Ctrl+K / Cmd+K = 新建会话，挂在**壳**上
 * （useNewSessionShortcut）——它按路由无关，所以设置页/插件页按也生效，
 * 与侧栏顶部那个「新建会话」按钮同一个动作。
 *
 * W7（D4=A，2026-10-17 用户拍板）：窄窗自动降级会话二级栏。判据与 `workPanelFit` 同一套实测法：
 * 内容卡宽 − 侧栏标称宽 < --chat-min-readable-width(480) ⇒ 会话二级栏自动收成 0（布局事实，
 * 见 store 的 `sidebarAutoCollapsed` / `shouldAutoCollapseSidebar`），窗口变宽后按用户偏好恢复。
 * 720 最小窗（内容卡 658，658−240=418）会收，1280 窗（1218−240=978）不收。设置页的栏目菜单不降级。
 *
 * W7（设置往返丢草稿）：`/settings`、`/plugins`、`/memory`、`/usage` 已挪进 ModuleHost（见 App.tsx），
 * 切这些页面时 ChatPage 只 hidden+inert、不卸载 —— 草稿/滚动/页签都留着（此前它们挂在宿主之外，
 * 一进设置宿主连同聊天一起卸载，草稿随之丢失）。
 */
export function AppShell(): React.JSX.Element {
  // 全局快捷键（Ctrl+K / Cmd+K）：等价于点侧栏的「新建会话」——壳常驻，任何路由都收得到
  useNewSessionShortcut()
  // M3-S5-2：退出拦截的壳侧桥（脏计数上报 + 主进程退出请求订阅）；返回待决请求 → 条件渲染对话框。
  // 壳对所有路由常驻，所以退出确认在设置页/聊天页也能弹（Office 页不常驻在路由上没关系）。
  const officeQuitRequest = useOfficeDirtyReporter()
  const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed)
  const sidebarAutoCollapsed = useShellStore((state) => state.sidebarAutoCollapsed)
  const workPanelOpen = useShellStore((state) => state.workPanelOpen)
  const workPanelWidth = useShellStore((state) => state.workPanelWidth)
  const workPanelFullscreen = useShellStore((state) => state.workPanelFullscreen)
  const workPanelFit = useShellStore((state) => state.workPanelFit)
  const toggleSidebar = useShellStore((state) => state.toggleSidebar)
  const toggleWorkPanel = useShellStore((state) => state.toggleWorkPanel)
  const setWorkPanelOpen = useShellStore((state) => state.setWorkPanelOpen)
  const setWorkPanelWidth = useShellStore((state) => state.setWorkPanelWidth)
  const setWorkPanelFit = useShellStore((state) => state.setWorkPanelFit)
  const setSidebarAutoCollapsed = useShellStore((state) => state.setSidebarAutoCollapsed)
  const pathname = useLocation().pathname
  const inSettings = pathname.startsWith('/settings')
  // round 17（用户实拍）：工作台开关属于**对话区**，只在对话路由出现（设置/插件等页面右上角不再有它）
  const inChat = pathname.startsWith('/chat')
  // 会话二级栏只在主对话与沿用旧入口的页面显示；笔记/知识库/Office 是独立模块，不挂会话列表。
  // 插件/记忆/用量是旧深链，保留现状（插件入口仍在会话栏里，深链页面也还能看到它）。
  const showSidebar =
    inChat ||
    inSettings ||
    pathname.startsWith('/plugins') ||
    pathname.startsWith('/memory') ||
    pathname.startsWith('/usage')
  // 侧栏的**真实布局态** = 没有二级栏 || 用户手动收起 || 窄窗自动降级（W7 / D4=A）。
  // `data-sidebar` 与 TitleBar 开合钮的图标都跟它走（布局事实）；用户偏好 `sidebarCollapsed`
  // 不因自动降级被改写 —— 窗口变宽后按偏好恢复。
  // 2026-10-17 起侧栏在卡内 flow，CSS 不再按 data-sidebar 推 safe-left；这个属性留给 E2E/探针
  // 与单测读布局事实。
  const sidebarEffectiveCollapsed = !showSidebar || sidebarCollapsed || sidebarAutoCollapsed
  const rowRef = useRef<HTMLDivElement>(null)
  const spaceConstrained = isWorkPanelSpaceConstrained(workPanelFit)
  // 面板此刻是否铺满内容区：用户偏好 or 空间不足的临时形态（两者对布局完全同构）
  const effectiveFullscreen = workPanelFullscreen || spaceConstrained

  /**
   * 量一次壳宽 → 写两份布局事实（侧栏窄窗自动降级 + 工作台空间判定），共用同一套 token 与实测宽。
   *
   * 几何口径（2026-10-17 侧栏进卡后重算，结论与覆盖层时代同形）：
   *   - row 是一级导航右侧的整条可用区，**不含**一级导航（它是 row 的 flow 兄弟，见 render）；
   *   - 内容卡的宽 = row 宽 − 右缘留缝 --shell-edge-gap（左缘不留缝）；
   *   - 卡内三列是 flex 兄弟：二级栏（展开 240 / 收起 0）+ 主列 + 工作台（workPanelWidth）。
   *
   * W7 增补（D4=A 窄窗自动降级侧栏）：
   *   - 只降级**会话**二级栏（chat / plugins / memory / usage 的会话视图）；设置页的左列是栏目菜单
   *     （操作入口），窄窗也保留；
   *   - 判据用侧栏**标称宽**（--sidebar-width）而不是当前实际占宽 —— 收起后不会因为"空间又够了"
   *     翻回展开，所以不会收/展来回抖；
   *   - 优先级：用户手动收起（sidebarCollapsed）时 auto 直接不生效；用户手动展开但空间不足时
   *     auto 折叠（auto 只压"手动展开"，不改偏好）。
   *
   * 工作台部分不变：面板没开就不占宽，顺手把上一次的事实收掉；量不到宽（jsdom / 隐藏态）时
   * 维持现状 —— 单测里不该因为"量不出布局"把中列藏了、把侧栏收了。
   */
  const measureLayout = useCallback(
    (observedWidth: number): void => {
      const row = rowRef.current
      if (row === null) return
      const rowWidth = observedWidth > 0 ? observedWidth : row.clientWidth
      if (rowWidth <= 0) {
        // 量不到宽（jsdom / 隐藏态）：维持已有布局事实；但"面板已关"这种与宽度无关的事要收掉
        if (!workPanelOpen) setWorkPanelFit(null)
        return
      }
      const edgeGap = readLengthToken('--shell-edge-gap', SHELL_EDGE_GAP_FALLBACK)
      const sidebarWidth = readLengthToken('--sidebar-width', SIDEBAR_WIDTH_FALLBACK)
      const minChatWidth = readLengthToken('--chat-min-readable-width', CHAT_MIN_READABLE_FALLBACK)
      const contentWidth = Math.max(0, rowWidth - edgeGap)

      // 1) 会话二级栏窄窗自动降级（布局事实；不动 sidebarCollapsed 偏好）
      const autoCollapsed =
        showSidebar &&
        !inSettings &&
        !sidebarCollapsed &&
        shouldAutoCollapseSidebar({ contentWidth, sidebarWidth, minChatWidth })
      setSidebarAutoCollapsed(autoCollapsed)

      // 2) 工作台空间判定（判据里的侧栏占宽 = 卡内实际还有没有那 240）
      if (!workPanelOpen) {
        setWorkPanelFit(null)
        return
      }
      const sidebarShown = showSidebar && !sidebarCollapsed && !autoCollapsed
      setWorkPanelFit({
        contentWidth,
        // 卡内 flow 的侧栏占宽：展开 = --sidebar-width，收起 / 自动收起 / 无二级栏 = 0
        safeLeft: sidebarShown ? sidebarWidth : 0,
        panelWidth: workPanelWidth,
        minChatWidth
      })
    },
    [
      inSettings,
      setSidebarAutoCollapsed,
      setWorkPanelFit,
      showSidebar,
      sidebarCollapsed,
      workPanelOpen,
      workPanelWidth
    ]
  )

  // useLayoutEffect（不是 useEffect）：面板刚打开 / 侧栏刚收起 / 窗口刚变窄时，这一量必须在
  // **这一帧画出来之前**落地 —— 否则会先闪一帧"侧栏还占着 / 面板 400 + 聊天被挤扁"的构图。
  // 依赖里带上侧栏 / 面板态 / 面板宽 / 当前页面有没有二级栏：这几件任一变化都要重判
  // （行本身不变宽时 ResizeObserver 不响）。
  useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null) return
    measureLayout(row.clientWidth)
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      measureLayout(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(row)
    return () => {
      observer.disconnect()
    }
  }, [measureLayout])

  // round 48（用户口径）：工作台面板属于对话区——切到对话以外的页面（设置/插件/记忆等）一律收起；
  // 面板状态与标签保留，回到对话由用户再自己展开。
  useEffect(() => {
    if (!inChat) setWorkPanelOpen(false)
  }, [inChat, setWorkPanelOpen])

  // round 73：冷启动打点 —— 壳已挂载（DOM 出来了、路由开始渲染内容列）
  useEffect(() => {
    startupMark('外壳挂载')
  }, [])

  return (
    <div
      data-testid="app-root"
      data-sidebar={sidebarEffectiveCollapsed ? 'collapsed' : 'expanded'}
      className="flex h-full flex-col overflow-hidden bg-canvas text-ink"
    >
      {/* 开合钮显示**真实布局态**（自动降级时也是"已收起"的样子）。窄窗 auto 收起时点它改的仍是
          用户偏好（sidebarCollapsed），布局在空间恢复前保持自动收起 —— auto 只由实测宽度决定，
          不读点击结果，所以两者不会来回打架/闪跳。 */}
      <TitleBar
        sidebarCollapsed={sidebarCollapsed || sidebarAutoCollapsed}
        onToggleSidebar={toggleSidebar}
      />
      <div className="flex min-h-0 flex-1">
        {/* 一级导航是 flow：它占的宽度直接从内容区扣，不需要在 measureLayout 里二次折算 */}
        <PrimaryNav />
        {/* shell-row 只包住内容卡：宽度 = 一级导航右缘到窗口右缘。
            二级栏已经挪进卡内（ContentRegion 的 flex 子列），行本身不再需要为覆盖层做裁剪。 */}
        <div ref={rowRef} data-testid="shell-row" className="flex min-h-0 min-w-0 flex-1">
          <ContentRegion>
            {/* 会话二级栏：卡内左列（设置页换设置菜单；无二级栏的模块整列不渲染）。
                collapsed 传**真实布局态**（手动态 / 窄窗自动降级都算），用户偏好只由 store 保存。 */}
            {showSidebar ? (
              <Sidebar collapsed={sidebarEffectiveCollapsed}>
                {inSettings ? (
                  <SettingsNav />
                ) : (
                  // task-73：会话侧栏底部不再有第二个「设置」入口 —— 唯一入口是最左 rail 底部的
                  // PrimaryNav 齿轮（用户反馈：两处设置重复）。列表底部间距由 SessionsController
                  // 自己的滚动区 pb-2 负责，删掉 footer 后不留空档。
                  <SessionsController />
                )}
              </Sidebar>
            ) : null}
            <MainColumn className={effectiveFullscreen ? 'hidden' : undefined}>
              <Outlet />
            </MainColumn>
            <WorkPanel
              open={workPanelOpen}
              fullscreen={effectiveFullscreen}
              spaceConstrained={spaceConstrained}
              width={workPanelWidth}
              onWidthChange={setWorkPanelWidth}
            >
              <Workbench />
            </WorkPanel>
            {/* 工作台开关（round 4：从顶栏搬到这里 —— 用户裁决 R2 concern ①"右侧边栏属于 chat 的内容"，
              位置按 Kimi 实况 c828bba8：图标按钮钉在内容卡**内部**的右上角）。
              形态与顶栏窗控一致（36 图标钮、无外圈、hover 铺 Fills-F1）；testid / 可访问名不变。
              round 17：只在对话路由渲染（用户实拍：设置/插件页不该有"属于对话区"的按钮）。
              round 24：对话页顶部栏（40px）出来之后，按钮就是这条带的右端——上移 6px 与带对齐。
              round 39：面板开着时这个位置就是工作台自己的头部（＋ / ⤢ / ▯ 图标簇在那里），
              浮动钮让位、只保留"打开入口"这一半；关面板改用头部那个 ▯（`workbench-close`，
              容器沿用 work-panel-toggle 这一 e2e 契约，见 Workbench）。
              round 77：窄窗里点它就是"临时铺满"（空间不足 → 面板占整块内容区），
              用户不会再看到聊天被挤成逐字一列。 */}
            {inChat && !workPanelOpen ? (
              <IconButton
                data-testid="work-panel-toggle"
                label="展开工作台"
                icon={<PanelRightOpen />}
                className="absolute top-0.5 right-2 z-10 border-transparent hover:bg-hover"
                onClick={toggleWorkPanel}
              />
            ) : null}
          </ContentRegion>
        </div>
      </div>
      {/* M3-S5-2：退出确认（真退出 / 真关窗 + 有未保存文档时，主进程推 office:quit-request 触发）。
          无条件挂载点、空闲时不渲染；对话框自己管三态与回包（见 OfficeQuitDialog）。
          key=requestId：换一条请求就是一次新的确认（对话框状态从「确认」重新开始）。 */}
      {officeQuitRequest === null ? null : (
        <OfficeQuitDialog key={officeQuitRequest.requestId} request={officeQuitRequest} />
      )}
    </div>
  )
}
