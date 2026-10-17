import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficeAiPanel } from '../OfficeAiPanel'
import { OfficePage } from '../OfficePage'
import {
  OFFICE_AI_PANEL_AUTO_COLLAPSE_WIDTH,
  isAiPanelAutoCollapsed,
  resetOfficeUiStore,
  resolveAiPanelOpen,
  useOfficeUiStore
} from '../office-ui-store'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'

/**
 * A3：右侧 AI 面板 v1（诚实占位）。
 *
 * 三块契约：
 *   1. 纯逻辑：手动偏好 vs 自动收起（`resolveAiPanelOpen` / `isAiPanelAutoCollapsed`），
 *      优先级「手动关 > 自动」、窗口变宽回到用户偏好；
 *   2. 组件：320 面板结构/文案/disabled 占位（不产生假动作）；
 *   3. OfficePage 集成：默认开、手动收起/把手展开、窄窗自动收并禁用把手、变宽恢复。
 */

describe('office-ui-store：AI 面板开合的纯逻辑', () => {
  beforeEach(() => {
    resetOfficeUiStore()
  })

  it('默认开；toggle 只翻手动偏好；reset 回默认', () => {
    const store = useOfficeUiStore.getState()
    expect(store.aiPanelOpen).toBe(true)
    expect(store.aiPanelAutoCollapsed).toBe(false)

    act(() => useOfficeUiStore.getState().toggleAiPanel())
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(false)
    act(() => useOfficeUiStore.getState().toggleAiPanel())
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(true)

    act(() => useOfficeUiStore.setState({ aiPanelOpen: false, aiPanelAutoCollapsed: true }))
    resetOfficeUiStore()
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(true)
    expect(useOfficeUiStore.getState().aiPanelAutoCollapsed).toBe(false)
  })

  it('生效值 = 手动想开 && 没被自动收（手动关优先于自动，变宽后回到用户偏好）', () => {
    expect(resolveAiPanelOpen(true, false)).toBe(true)
    expect(resolveAiPanelOpen(true, true)).toBe(false)
    expect(resolveAiPanelOpen(false, false)).toBe(false)
    expect(resolveAiPanelOpen(false, true)).toBe(false)
  })

  it('自动收起阈值：< 1100 收；>= 1100 不收；宽未知/0 不误收（jsdom/隐藏态）', () => {
    expect(OFFICE_AI_PANEL_AUTO_COLLAPSE_WIDTH).toBe(1100)
    expect(isAiPanelAutoCollapsed(1099)).toBe(true)
    expect(isAiPanelAutoCollapsed(1100)).toBe(false)
    expect(isAiPanelAutoCollapsed(1280)).toBe(false)
    expect(isAiPanelAutoCollapsed(0)).toBe(false)
    expect(isAiPanelAutoCollapsed(-1)).toBe(false)
  })

  it('setAiPanelAutoCollapsed 幂等（同值不触发新引用，避免 ResizeObserver 抖动重渲）', () => {
    const before = useOfficeUiStore.getState()
    act(() => useOfficeUiStore.getState().setAiPanelAutoCollapsed(false))
    expect(useOfficeUiStore.getState()).toBe(before)
    act(() => useOfficeUiStore.getState().setAiPanelAutoCollapsed(true))
    expect(useOfficeUiStore.getState().aiPanelAutoCollapsed).toBe(true)
  })
})

describe('OfficeAiPanel：320px 诚实占位组件', () => {
  it('展开：header（AI 助手 + 即将接入 + 收起）、诚实说明、3 个 disabled chip、composer 与发送 disabled', () => {
    const onCollapse = vi.fn()
    render(<OfficeAiPanel open onCollapse={onCollapse} />)

    const panel = screen.getByTestId('office-ai-panel')
    expect(panel).toHaveAttribute('data-open', 'true')
    expect(panel).toHaveAttribute('data-auto-collapsed', 'false')
    expect(panel).not.toHaveAttribute('aria-hidden')
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveAccessibleName('AI 助手')

    expect(screen.getByText('AI 助手')).toBeInTheDocument()
    expect(screen.getByText('即将接入')).toBeInTheDocument()
    expect(screen.getByTestId('office-ai-collapse')).toHaveAccessibleName('收起 AI 助手')

    const placeholder = screen.getByTestId('office-ai-placeholder')
    expect(placeholder).toHaveTextContent('AI 编辑能力将在后续版本接入')
    expect(placeholder).toHaveTextContent('不会读取文档内容')

    const chips = screen.getAllByTestId('office-ai-chip')
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      // disabled 语义 + 文案可断言；点击不产生假动作（没有回调可被调用）
      expect(chip).toBeDisabled()
      expect(chip).toHaveAttribute('title', 'AI 编辑能力接入后可用')
      fireEvent.click(chip)
    }

    const composer = screen.getByTestId('office-ai-composer')
    expect(composer).toBeDisabled()
    expect(composer).toHaveAttribute('placeholder', 'AI 编辑能力接入后可用')
    expect(screen.getByTestId('office-ai-send')).toBeDisabled()

    // 收起按钮是唯一可用动作：只回调，不自己改状态（状态归 store / 父级）
    fireEvent.click(screen.getByTestId('office-ai-collapse'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('收起：data-open=false + aria-hidden + inert + 宽度 0，内容仍在 DOM（探针可查、不卸载 iframe 侧信息）', () => {
    const onCollapse = vi.fn()
    render(<OfficeAiPanel open={false} onCollapse={onCollapse} />)

    const panel = screen.getByTestId('office-ai-panel')
    expect(panel).toHaveAttribute('data-open', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveAttribute('inert')
    expect(panel).toHaveStyle({ width: '0px' })
    // 仍是同一棵 DOM（只是宽度裁掉/透明），占位文案与 chip 都还在
    expect(screen.getByTestId('office-ai-placeholder')).toBeInTheDocument()
    expect(screen.getAllByTestId('office-ai-chip')).toHaveLength(3)
  })

  it('自动收起时透传 data-auto-collapsed（供 OfficePage 把手/文案与截图断言）', () => {
    render(<OfficeAiPanel open={false} autoCollapsed onCollapse={vi.fn()} />)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-auto-collapsed', 'true')
  })
})

/** OfficePage 集成：需要一个可打开的 docx 标签（office:read 回包喂字节） */
function installDocxBridge(): KyclawBridgeStubs {
  const bridge = installKyclawBridge()
  const document = officeDocumentFixture({ documentId: 'doc-ai', displayName: 'AI.docx' })
  bridge.office.read.mockResolvedValue({ ok: true, document, bytes: new Uint8Array([1, 2, 3]) })
  useOfficeTabsStore.getState().openDocument(document)
  return bridge
}

describe('OfficePage：AI 面板默认开 / 手动开合 / 窄窗自动收', () => {
  let bridge: KyclawBridgeStubs
  let resizeCallback: ((entries: ResizeObserverEntry[]) => void) | null
  let width = 1280

  beforeEach(() => {
    resetOfficeTabsStore()
    resetOfficeUiStore()
    bridge = installDocxBridge()
    width = 1280
    resizeCallback = null
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverStub {
        constructor(callback: (entries: ResizeObserverEntry[]) => void) {
          resizeCallback = callback
        }
        observe(): void {
          // 桩不做真实订阅：用例直接用 constructor 里存的回调触发
          void 0
        }
        disconnect(): void {
          resizeCallback = null
        }
        unobserve(): void {
          void 0
        }
      }
    )
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width,
          height: 800,
          top: 0,
          left: 0,
          right: width,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({})
        }) as DOMRect
    )
  })

  afterEach(() => {
    clearKyclawBridge()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetOfficeTabsStore()
    resetOfficeUiStore()
  })

  /** 让 ResizeObserver 报一个可用宽（模拟内容卡宽度变化） */
  function resizeTo(nextWidth: number): void {
    width = nextWidth
    act(() => {
      resizeCallback?.([{ contentRect: { width: nextWidth } } as ResizeObserverEntry])
    })
  }

  it('默认 320 面板展开：画布 + 面板同排，无 AI 把手', () => {
    render(<OfficePage />)

    const panel = screen.getByTestId('office-ai-panel')
    expect(panel).toHaveAttribute('data-open', 'true')
    expect(panel).toHaveStyle({ width: 'var(--office-ai-panel-width)' })
    expect(screen.queryByTestId('office-ai-handle')).not.toBeInTheDocument()
    // 既有 testid 不被面板破坏
    expect(screen.getByTestId('office-surface-iframe')).toBeInTheDocument()
    expect(bridge.office.read).toHaveBeenCalledWith('doc-ai')
  })

  it('手动收起 → 面板收 + 出现 AI 把手；点把手再展开（手动偏好）', () => {
    render(<OfficePage />)

    fireEvent.click(screen.getByTestId('office-ai-collapse'))
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(false)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'false')
    const handle = screen.getByTestId('office-ai-handle')
    expect(handle).toHaveAttribute('aria-expanded', 'false')
    expect(handle).toHaveAttribute('aria-controls', 'office-ai-panel')
    expect(handle).toHaveAccessibleName('展开 AI 助手')
    expect(handle).toBeEnabled()

    fireEvent.click(handle)
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(true)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'true')
    expect(screen.queryByTestId('office-ai-handle')).not.toBeInTheDocument()
  })

  it('窄窗（可用宽 < 1100）自动收 + 把手禁用；变宽恢复用户偏好（默认开）', () => {
    render(<OfficePage />)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'true')

    resizeTo(900)
    expect(useOfficeUiStore.getState().aiPanelAutoCollapsed).toBe(true)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-auto-collapsed', 'true')
    const handle = screen.getByTestId('office-ai-handle')
    expect(handle).toBeDisabled()
    expect(handle).toHaveAccessibleName('AI 助手（窗口过窄已自动收起）')

    resizeTo(1280)
    expect(useOfficeUiStore.getState().aiPanelAutoCollapsed).toBe(false)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'true')
  })

  it('手动关优先于自动：宽窗手动收 → 变窄变宽都保持收起', () => {
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-ai-collapse'))
    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(false)

    resizeTo(900)
    resizeTo(1280)

    expect(useOfficeUiStore.getState().aiPanelOpen).toBe(false)
    expect(screen.getByTestId('office-ai-panel')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('office-ai-handle')).toBeEnabled()
  })
})
