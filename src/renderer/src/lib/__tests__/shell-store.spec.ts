import { beforeEach, describe, expect, it } from 'vitest'
import {
  canRestoreSplitLayout,
  clampWorkPanelWidth,
  dockedChatWidth,
  isWorkPanelSpaceConstrained,
  maxPanelWidthForSplit,
  restoredPanelWidth,
  shouldAutoCollapseSidebar,
  useShellStore,
  type WorkbenchFit
} from '../shell-store'

/** 1280 窗的真值：内容区 1274 = 1280 − 右缘留缝 6；侧栏展开遮 240 */
const fitAt1280 = (panelWidth: number): WorkbenchFit => ({
  contentWidth: 1274,
  safeLeft: 240,
  panelWidth,
  minChatWidth: 480
})

beforeEach(() => {
  // store 是模块级单例：每个用例前回到默认态
  useShellStore.setState({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false,
    workPanelFit: null
  })
})

describe('壳布局 store（zustand）', () => {
  it('默认：侧栏展开、工作台面板收起、宽 400、不全屏', () => {
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelWidth).toBe(400)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })

  it('toggleSidebar 翻转侧栏折叠态', () => {
    useShellStore.getState().toggleSidebar()
    expect(useShellStore.getState().sidebarCollapsed).toBe(true)

    useShellStore.getState().toggleSidebar()
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
  })

  it('toggleWorkPanel 翻转面板态，且不牵动侧栏', () => {
    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelOpen).toBe(true)
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)

    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelOpen).toBe(false)
  })
})

describe('工作台宽度（round 39 拖拽调宽）', () => {
  it('setWorkPanelWidth：夹在 280–760（容器宽未知时）', () => {
    useShellStore.getState().setWorkPanelWidth(100)
    expect(useShellStore.getState().workPanelWidth).toBe(280)

    useShellStore.getState().setWorkPanelWidth(1200)
    expect(useShellStore.getState().workPanelWidth).toBe(760)

    useShellStore.getState().setWorkPanelWidth(520.4)
    expect(useShellStore.getState().workPanelWidth).toBe(520)
  })

  it('拖动时按内容区实测宽再夹一层 70% 上限（这条优先于 280 下限）', () => {
    // 内容区 1000 → 70% = 700（比 760 更紧）
    useShellStore.getState().setWorkPanelWidth(900, 1000)
    expect(useShellStore.getState().workPanelWidth).toBe(700)

    // 内容区 1600 → 70% = 1120，比 760 松 → 取 760
    useShellStore.getState().setWorkPanelWidth(900, 1600)
    expect(useShellStore.getState().workPanelWidth).toBe(760)

    // 极窄内容区 300 → 70% = 210 < 280：宁可更窄，也不越界挤死内容列
    useShellStore.getState().setWorkPanelWidth(500, 300)
    expect(useShellStore.getState().workPanelWidth).toBe(210)
    expect(clampWorkPanelWidth(1200, 0)).toBe(760)
    expect(clampWorkPanelWidth(Number.NaN, 1000)).toBe(400)
  })
})

describe('工作台全屏（round 39）', () => {
  it('toggleWorkPanelFullscreen 翻转并保证面板是开的', () => {
    useShellStore.getState().toggleWorkPanelFullscreen()
    expect(useShellStore.getState().workPanelFullscreen).toBe(true)
    expect(useShellStore.getState().workPanelOpen).toBe(true)

    useShellStore.getState().toggleWorkPanelFullscreen()
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })

  it('关面板（▯ / 变根收起 / 离开对话区）都把全屏一并复位', () => {
    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: true })
    useShellStore.getState().setWorkPanelOpen(false)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)

    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: true })
    useShellStore.getState().toggleWorkPanel()
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })
})

/**
 * round 77（用户口径）：可用空间不够时不再"自动收面板"，而是让工作台临时铺满内容区 ——
 * 判据全是实测值（内容区宽 / 侧栏遮挡 / **拖过的**面板宽），所以下面这些用例刻意不用 1120 那种
 * 固定阈值来验：同一窗口宽度下收侧栏、拖宽面板都会翻转结论。
 */
describe('工作台空间判定（round 77：可用宽不够就临时铺满）', () => {
  it('dockedChatWidth：扣掉侧栏遮挡与面板宽，挤成负数按 0 算', () => {
    expect(
      dockedChatWidth({ contentWidth: 794, safeLeft: 240, panelWidth: 400, minChatWidth: 480 })
    ).toBe(154)
    expect(
      dockedChatWidth({ contentWidth: 300, safeLeft: 240, panelWidth: 400, minChatWidth: 480 })
    ).toBe(0)
  })

  it('中列正好留下最小可读宽就分栏，差 1px 就铺满', () => {
    const fit = { contentWidth: 1120, safeLeft: 240, panelWidth: 400, minChatWidth: 480 }
    expect(dockedChatWidth(fit)).toBe(480)
    expect(isWorkPanelSpaceConstrained(fit)).toBe(false)
    expect(isWorkPanelSpaceConstrained({ ...fit, contentWidth: 1119 })).toBe(true)
  })

  it('800×800 实况（.superpowers/ui-final 那张逐字排的截图）：侧栏展开摆不下，收起侧栏也还差一点', () => {
    const fit = { contentWidth: 794, safeLeft: 240, panelWidth: 400, minChatWidth: 480 }
    expect(isWorkPanelSpaceConstrained(fit)).toBe(true)
    // 实测聊天只剩 ~155（截图里就是逐字一行）；收起侧栏放出 240 也只有 394，仍不够
    expect(isWorkPanelSpaceConstrained({ ...fit, safeLeft: 0 })).toBe(true)
  })

  it('同一窗口宽度：收起侧栏会让出 240 → 分栏成立（不是固定阈值能判的）', () => {
    const base = { contentWidth: 1000, panelWidth: 400, minChatWidth: 480 }
    expect(isWorkPanelSpaceConstrained({ ...base, safeLeft: 240 })).toBe(true) // 360
    expect(isWorkPanelSpaceConstrained({ ...base, safeLeft: 0 })).toBe(false) // 600
  })

  it('拖宽过的面板参与判据：1280 的窗口拖到 760 也放不下', () => {
    expect(isWorkPanelSpaceConstrained(fitAt1280(760))).toBe(true)
    // 同一个窗口，默认 400 就够
    expect(isWorkPanelSpaceConstrained(fitAt1280(400))).toBe(false)
  })

  it('量不到布局（fit = null，面板关着 / jsdom）一律当不铺满', () => {
    expect(isWorkPanelSpaceConstrained(null)).toBe(false)
  })

  it('setWorkPanelFit 只写布局事实：同值不通知，用户的全屏偏好一个字节都不动', () => {
    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: false })
    useShellStore.getState().setWorkPanelFit(fitAt1280(560))
    expect(useShellStore.getState().workPanelFit).toEqual(fitAt1280(560))
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)

    // 同值不通知（resize 期间反复量到同一份事实不该引起重渲染）
    const before = useShellStore.getState()
    useShellStore.getState().setWorkPanelFit(fitAt1280(560))
    expect(useShellStore.getState()).toBe(before)

    useShellStore.getState().setWorkPanelFit(null)
    expect(useShellStore.getState().workPanelFit).toBeNull()
  })
})

/**
 * round 78（实机陷阱）：1280 把面板拖到 560 → auto，把手没了、⤢ 也没意义 —— 就地回不去并排。
 * 出口有两条，判据都在这里：能并排就把宽度收进上限（只往窄收，不动全屏偏好），
 * 太窄（800）就只能回对话（UI 侧换成"返回对话"这个真动作）。
 */
describe('"恢复并排布局"（round 78）', () => {
  it('贴边上限 = 内容区 − 侧栏遮挡 − 中列最小可读宽；留了余量才算了落点', () => {
    // 1274 − 240 − 480 = 554
    expect(maxPanelWidthForSplit(fitAt1280(560))).toBe(554)
    // 800 窗：794 − 240 − 480 = 74 < 面板下限 280 → 收窄也回不到并排
    const tooNarrow: WorkbenchFit = {
      contentWidth: 794,
      safeLeft: 240,
      panelWidth: 400,
      minChatWidth: 480
    }
    expect(maxPanelWidthForSplit(tooNarrow)).toBe(74)
    expect(canRestoreSplitLayout(tooNarrow)).toBe(false)
    expect(canRestoreSplitLayout(fitAt1280(560))).toBe(true)
    // 800 里收起侧栏：794 − 280 = 514 ≥ 480 → 收窄面板就能并排（同窗口，遮挡变了就不一样）
    expect(canRestoreSplitLayout({ ...tooNarrow, safeLeft: 0 })).toBe(true)
  })

  it('落点只往窄收：留余量（8）避免贴边被亚像素推回 auto，且夹在 280–760', () => {
    // 554 − 8 = 546（不越界：546 时聊天 488 ≥ 480）
    expect(restoredPanelWidth(fitAt1280(560), 560)).toBe(546)
    expect(
      isWorkPanelSpaceConstrained({
        ...fitAt1280(560),
        panelWidth: restoredPanelWidth(fitAt1280(560), 560)
      })
    ).toBe(false)
    // 用户只拖到 420（本来就放不下？不：420 时聊天 614 够）——落点绝不把宽度撑大
    expect(restoredPanelWidth(fitAt1280(420), 420)).toBe(420)
    // 落点低于下限就夹到 280
    expect(restoredPanelWidth({ ...fitAt1280(560), contentWidth: 1000 }, 560)).toBe(280)
  })

  it('restoreSideBySideLayout：按事实收窄，返回是否真的做了，且不碰全屏偏好', () => {
    useShellStore.setState({
      workPanelOpen: true,
      workPanelFullscreen: false,
      workPanelWidth: 560,
      workPanelFit: fitAt1280(560)
    })
    expect(useShellStore.getState().restoreSideBySideLayout()).toBe(true)
    expect(useShellStore.getState().workPanelWidth).toBe(546)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
    expect(useShellStore.getState().workPanelOpen).toBe(true)

    // 800 那种真窄窗：做不了就如实返回 false（UI 走"返回对话"那条路）
    useShellStore.setState({
      workPanelWidth: 400,
      workPanelFit: { contentWidth: 794, safeLeft: 240, panelWidth: 400, minChatWidth: 480 }
    })
    expect(useShellStore.getState().restoreSideBySideLayout()).toBe(false)
    expect(useShellStore.getState().workPanelWidth).toBe(400)

    // 量不到布局（面板关着 / jsdom）也不动
    useShellStore.setState({ workPanelFit: null })
    expect(useShellStore.getState().restoreSideBySideLayout()).toBe(false)
    expect(useShellStore.getState().workPanelWidth).toBe(400)
  })
})

/**
 * W7（D4=A，2026-10-17 用户拍板）：窄窗自动降级会话二级栏。
 * 判据 = 内容卡宽 − 侧栏**标称**宽(240) < 中列最小可读宽(480)；用标称宽是防自激（见函数注释）。
 */
describe('会话侧栏窄窗自动降级（W7 / D4=A）', () => {
  it('判据：内容卡 1218（1280 窗）不收、658（720 窗）收；正好等于最小可读宽也不收', () => {
    expect(
      shouldAutoCollapseSidebar({ contentWidth: 1218, sidebarWidth: 240, minChatWidth: 480 })
    ).toBe(false)
    expect(
      shouldAutoCollapseSidebar({ contentWidth: 658, sidebarWidth: 240, minChatWidth: 480 })
    ).toBe(true)
    // 720 − 240 = 480 = 最小可读宽：不够收的条件（严格小于）
    expect(
      shouldAutoCollapseSidebar({ contentWidth: 720, sidebarWidth: 240, minChatWidth: 480 })
    ).toBe(false)
    expect(
      shouldAutoCollapseSidebar({ contentWidth: 719, sidebarWidth: 240, minChatWidth: 480 })
    ).toBe(true)
  })

  it('默认不是自动收起；setSidebarAutoCollapsed 只写布局事实、不动用户偏好', () => {
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)

    useShellStore.getState().setSidebarAutoCollapsed(true)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(true)
    // 用户偏好（是否手动收起）一个字节都没动 —— 窗口变宽后要按它恢复
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)

    useShellStore.getState().setSidebarAutoCollapsed(false)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
  })

  it('同值不通知（resize 期间反复量到同一结论不该引起重渲染）', () => {
    useShellStore.getState().setSidebarAutoCollapsed(true)
    const before = useShellStore.getState()

    useShellStore.getState().setSidebarAutoCollapsed(true)
    expect(useShellStore.getState()).toBe(before)
  })
})
