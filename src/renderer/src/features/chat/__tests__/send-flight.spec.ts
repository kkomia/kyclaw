import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SEND_FLIGHT_MS,
  animateSendFlight,
  flightKeyframes,
  planSendFlight,
  rememberComposerRect,
  resetComposerRectMemory,
  springProgressAt,
  takeComposerRect
} from '../send-flight'

afterEach(() => {
  resetComposerRectMemory()
})

describe('planSendFlight：Composer rect → 气泡目标位', () => {
  it('dx/dy 是从目标看起点的偏移；起点 scale .6（doc §2.6）', () => {
    const plan = planSendFlight(
      { left: 400, top: 700, width: 768, height: 120 },
      { left: 900, top: 300, width: 320, height: 60 }
    )
    expect(plan).toEqual({ dx: -500, dy: 400, startScale: 0.6 })
  })
})

describe('flight 曲线：弹簧采样成 linear keyframes', () => {
  it('springProgressAt：0→0、400ms 归一化到 1、中段有前进', () => {
    expect(springProgressAt(0)).toBe(0)
    expect(springProgressAt(0.4)).toBeCloseTo(1, 5)
    expect(springProgressAt(0.15)).toBeGreaterThan(0.35)
    expect(springProgressAt(0.15)).toBeLessThan(1)
  })

  it('keyframes：首帧从 Composer 偏移/scale .6 起，末帧 transform none', () => {
    const frames = flightKeyframes({ dx: 100, dy: 50, startScale: 0.6 }, 10)
    expect(frames).toHaveLength(11)
    expect(frames[0]?.offset).toBe(0)
    expect(String(frames[0]?.transform)).toContain('translate3d(100.00px, 50.00px, 0)')
    expect(String(frames[0]?.transform)).toContain('scale(0.6000)')
    expect(frames.at(-1)).toEqual({ offset: 1, transform: 'none', opacity: 1 })
  })
})

describe('rememberComposerRect / animateSendFlight', () => {
  it('取走一次即清空（避免下一条复用旧位置）', () => {
    rememberComposerRect({ left: 10, top: 20, width: 100, height: 40 } as DOMRect)
    expect(takeComposerRect()).toEqual({ left: 10, top: 20, width: 100, height: 40 })
    expect(takeComposerRect()).toBeNull()
  })

  it('有真实 rect：调用 WAAPI 400ms linear；第二次没有 rect 回 null', () => {
    const animate = vi.fn(() => ({}) as Animation)
    const bubble = {
      animate,
      getBoundingClientRect: () => ({ left: 200, top: 100, width: 300, height: 40 })
    } as unknown as HTMLElement
    rememberComposerRect({ left: 100, top: 700, width: 600, height: 120 } as DOMRect)

    const animation = animateSendFlight(bubble)
    expect(animation).not.toBeNull()
    expect(animate).toHaveBeenCalledTimes(1)
    const [frames, options] = animate.mock.calls[0] as unknown as [
      Keyframe[],
      KeyframeAnimationOptions
    ]
    expect(frames).toHaveLength(11)
    expect(options.duration).toBe(SEND_FLIGHT_MS)
    expect(options.easing).toBe('linear')

    // rect 已被取走：第二次不再飞（调用方退 grow）
    expect(animateSendFlight(bubble)).toBeNull()
  })

  it('量不到 rect（空会话/切窗）：回 null，不抛', () => {
    const bubble = {
      animate: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    } as unknown as HTMLElement
    rememberComposerRect({ left: 0, top: 0, width: 100, height: 20 } as DOMRect)
    expect(animateSendFlight(bubble)).toBeNull()
  })
})
