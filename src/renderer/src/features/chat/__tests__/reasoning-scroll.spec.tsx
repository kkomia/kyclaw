import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { ReasoningPart } from '@renderer/features/chat/parts/ReasoningPart'
import { resetReasoningTranslateCache } from '@renderer/lib/reasoning-translate'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import type { TranslateResult } from '@shared/translate'

/**
 * 思考块自身的滚动跟随（reasoning-text 是 max-h-[268px] + overflow-auto 的内滚容器，
 * MessageList 的外层跟随管不到它）：
 *   1. 贴底时新内容进来跟着走（含"第一次溢出"这一跳）；
 *   2. 用户上翻就停下，不许被新内容拽回底部；
 *   3. 用户自己滚回底部，重新贴上；
 *   4. 程序滚出来的 scroll 事件不算"用户上翻"；
 *   5. 内容没变、只是布局变了（折叠重开 / 译文切回原文）也要把位置收在合法范围内。
 *
 * jsdom 没有排版：几何（clientHeight / scrollHeight）用 stub 喂，scrollTop 自己记
 * （真实浏览器里它是"引擎按几何裁剪过的值"，stub 故意不裁剪，好断言"我们写了几何确认过的值"）。
 */
const MAX_HEIGHT = 268

interface Box {
  element: HTMLElement
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  /** 读到当前贴底位置（= scrollHeight - clientHeight） */
  bottom: () => number
  /** 模拟滚动条被拖到某个位置（真实浏览器里这会触发一次 scroll 事件） */
  scrollTo: (top: number) => void
}

function box(): Box {
  const element = screen.getByTestId('reasoning-text')
  const view = {
    element,
    clientHeight: MAX_HEIGHT,
    scrollHeight: 0,
    scrollTop: 0,
    bottom: () => Math.max(0, view.scrollHeight - view.clientHeight),
    scrollTo: (top: number) => {
      view.scrollTop = top
      fireEvent.scroll(element)
    }
  }
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      get: () => view.scrollHeight,
      set: (value: number) => {
        view.scrollHeight = value
      }
    },
    clientHeight: {
      configurable: true,
      get: () => view.clientHeight,
      set: (value: number) => {
        view.clientHeight = value
      }
    },
    scrollTop: {
      configurable: true,
      get: () => view.scrollTop,
      set: (value: number) => {
        view.scrollTop = value
      }
    }
  })
  // 几何喂进去之后，让观察者按真浏览器的次序跑一次（观察者在 effect 里挂，探针后挂）
  relayout()
  return view
}

/** 真浏览器里 ResizeObserver 是全局的；jsdom 没有，这里给一枚假的把布局变化喂给观察者 */
const observers: (() => void)[] = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    observers.push(this.callback)
  }
  observe(): void {
    // 观察对象就是我们自己记的那个回调，这里不需要真的登记
  }
  unobserve(): void {
    // 只观察一个节点，用例之间靠 disconnect 清
  }
  disconnect(): void {
    const index = observers.indexOf(this.callback)
    if (index >= 0) observers.splice(index, 1)
  }
}

/** 手动触发一次"布局又变了"（折叠过渡/窗口 resize 等） */
function relayout(): void {
  act(() => {
    for (const callback of [...observers]) callback()
  })
}

/** 实现写完位置后用微任务解掉"这次 scroll 是我自己写的"标记；测试里照真浏览器的次序等它跑过 */
async function flushWrites(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * jsdom 没有 ResizeObserver，这里自己装上、用完拆掉。
 * 不能用 `vi.stubGlobal`：它按 worker 记状态，同一 worker 里跑过的文件会把桩留给下一个
 * 文件（实测过：本文件先跑时 `typeof ResizeObserver` 是 function，后被复用时就变成 undefined）。
 */
const realResizeObserver = Reflect.get(globalThis, 'ResizeObserver')

beforeEach(() => {
  Reflect.set(globalThis, 'ResizeObserver', FakeResizeObserver)
  observers.length = 0
  resetReasoningTranslateCache()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

afterEach(() => {
  if (realResizeObserver === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver')
  else Reflect.set(globalThis, 'ResizeObserver', realResizeObserver)
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('思考块的内滚跟随', () => {
  it('贴底：新内容进来跟着走；第一次溢出就贴到底（不是停在顶部）', () => {
    const { rerender } = render(<ReasoningPart text="第一段" streaming />)
    const view = box()

    // 还没溢出：几何是"内容比容器矮"，没什么可滚的
    view.scrollHeight = 100
    rerender(<ReasoningPart text="第一段\n第二段" streaming />)
    expect(view.scrollTop).toBe(0)

    // 第一次溢出：应该直接贴到底，而不是停在顶部看老内容
    view.scrollHeight = 1200
    rerender(<ReasoningPart text="第一段\n第二段\n第三段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())

    // 继续流：每一段都把最后一行留在视野里
    view.scrollHeight = 1600
    rerender(<ReasoningPart text="第一段\n第二段\n第三段\n第四段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())
  })

  it('用户上翻：新内容不许把他拽回底部', async () => {
    const { rerender } = render(<ReasoningPart text="第一段" streaming />)
    const view = box()
    view.scrollHeight = 1600
    rerender(<ReasoningPart text="第一段\n第二段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())
    await flushWrites()

    // 拖到中间去读前面写的东西
    view.scrollTo(120)
    view.scrollHeight = 2000
    rerender(<ReasoningPart text="第一段\n第二段\n第三段" streaming />)
    expect(view.scrollTop).toBe(120)
  })

  it('用户滚回底部：重新贴上（后续内容继续跟着走）', async () => {
    const { rerender } = render(<ReasoningPart text="第一段" streaming />)
    const view = box()
    view.scrollHeight = 1600
    rerender(<ReasoningPart text="第一段\n第二段" streaming />)
    await flushWrites()
    view.scrollTo(100)

    view.scrollHeight = 2000
    rerender(<ReasoningPart text="第一段\n第二段\n第三段" streaming />)
    expect(view.scrollTop).toBe(100)

    // 自己滚回底（阈值内即算贴底）
    view.scrollTo(view.bottom() - 4)
    view.scrollHeight = 2400
    rerender(<ReasoningPart text="第一段\n第二段\n第三段\n第四段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())
  })

  it('程序滚出来的 scroll 事件不算"用户上翻"（贴底的人不该被自己写的值打断）', () => {
    const { rerender } = render(<ReasoningPart text="第一段" streaming />)
    const view = box()
    view.scrollHeight = 1600
    rerender(<ReasoningPart text="第一段\n第二段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())

    // 跟随自己写位置时带的那个 scroll 事件（还没解标记）：位置仍在底部，不算上翻
    view.scrollTop = view.bottom() - 2
    fireEvent.scroll(view.element)
    expect(view.scrollTop).toBe(view.bottom() - 2)

    view.scrollHeight = 2000
    rerender(<ReasoningPart text="第一段\n第二段\n第三段" streaming />)
    expect(view.scrollTop).toBe(view.bottom())
  })

  it('内容没变、只是布局变了（折叠重开）：位置收在合法范围内，不跳到顶部', () => {
    render(<ReasoningPart text="想完了" streaming />)
    const view = box()
    view.scrollHeight = 1600
    relayout()
    expect(view.scrollTop).toBe(view.bottom())

    // 折叠：容器高度归零（内容被 0fr 裁掉；真浏览器的 scrollTop 由引擎裁剪）
    view.clientHeight = 0
    view.scrollTop = 0
    relayout()

    // 重新展开：几何回来 → 上次确认的位置（底部）要收回到合法范围内，而不是停在中途/顶部
    view.clientHeight = MAX_HEIGHT
    relayout()
    expect(view.scrollTop).toBe(view.bottom())
  })

  it('上翻时被布局突变归零：按上次位置纠回，不跳到顶部', async () => {
    render(<ReasoningPart text="想完了" streaming />)
    const view = box()
    view.scrollHeight = 1600
    relayout()
    await flushWrites()
    view.scrollTo(120)

    // 折叠：容器被压到 0（0fr 裁掉，内容其实是看不见的），跟随在这一档**不写位置**
    // —— 写下去就是拿"0 高度的视口"算出来的值去挤用户的阅读位置
    view.clientHeight = 0
    view.scrollTop = 0
    let writes = 0
    Object.defineProperty(view.element, 'scrollTop', {
      configurable: true,
      get: () => view.scrollTop,
      set: (value: number) => {
        writes += 1
        view.scrollTop = value
      }
    })
    relayout()
    expect(writes).toBe(0)
    expect(view.scrollTop).toBe(0)

    // 重新展开：几何回来 → 用户读的那一段要留在视野里
    view.clientHeight = MAX_HEIGHT
    relayout()
    expect(view.scrollTop).toBe(120)
  })
})

describe('思考块的内滚跟随 × 译文切换', () => {
  const ENGLISH = 'Let me read the config file first, then write the patch.'
  const CHINESE = '我先读一下配置文件，然后写补丁。'

  it('切译文/切回原文都不抢阅读位置：贴底的人还在底部，上翻的人守住位置', async () => {
    const bridge = installKyclawBridge()
    bridge.translate.run.mockResolvedValue({ ok: true, text: CHINESE } as TranslateResult)
    const base = defaultSettings()
    useSettingsStore.setState({
      settings: {
        ...base,
        reasoningTranslate: { ...base.reasoningTranslate, enabled: true, mode: 'button' }
      },
      loaded: true
    })

    const root = render(<ReasoningPart text={ENGLISH} />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(root.getByTestId('reasoning-text')).toBeInTheDocument()
    const view = box()
    view.scrollHeight = 1600
    relayout()
    expect(view.scrollTop).toBe(view.bottom())

    fireEvent.click(screen.getByTestId('reasoning-translate-action'))
    await waitFor(() => expect(screen.getByTestId('reasoning-text')).toHaveTextContent(CHINESE))
    // 译文短一截：贴底的人应该还在底部（不是被顶到中途、更不是跳回顶部）
    view.scrollHeight = 900
    relayout()
    expect(view.scrollTop).toBe(view.bottom())

    // 用户上翻读译文 → 切回原文：位置守住，不许跳回顶部
    await flushWrites()
    view.scrollTo(300)
    fireEvent.click(screen.getByTestId('reasoning-show-original'))
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent(ENGLISH)
    view.scrollHeight = 3200
    relayout()
    expect(view.scrollTop).toBe(300)
  })
})
