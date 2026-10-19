import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { TextPart } from '../parts/TextPart'
import { nextFrame } from './next-frame'

/**
 * PB-045 / P1-C：流式 chunk 淡入策略（规格见
 * `.superpowers/dev-verify/20261019-0.1.6/design/pb041-flicker-decisions.md` §1）。
 *
 * 现状（red）：每次 shown 变化都 `last.animate([{opacity:0.4},{opacity:1}], 120ms)`，
 * 节流 120ms = 8.33Hz；被动画的是**同一段正在读的文字**（整段反复变暗）。
 * 目标（green）：只给「新出现的块」一次入场：0.6→1 / 150ms / 同一元素一生一次 / ≤1 次每 250ms；
 * 纯段落增长、首次挂载、streaming=false、reveal=off 一律 0 次。
 *
 * 这里把 `Element.animate` 换成记录器（jsdom 没有 Web Animations）——记录的是**真实调用**，
 * 再配合帧推进（nextFrame）复现「每个 chunk 一次」的时序。
 */
interface AnimateCall {
  element: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

const calls: AnimateCall[] = []
let now = 1_000
let originalAnimate: PropertyDescriptor | undefined

function fakeAnimation(): Animation {
  return {
    cancel: () => {},
    finished: Promise.resolve(),
    playState: 'running'
  } as unknown as Animation
}

function setReveal(reveal: 'on' | 'off'): void {
  const settings = defaultSettings()
  useSettingsStore.setState({
    settings: { ...settings, motion: { ...settings.motion, reveal } },
    loaded: true
  })
}

/** 推进一帧；时间每次 +200ms（越过 120/250ms 节流，复现「每 chunk 一发」的时序） */
async function frame(): Promise<void> {
  now += 200
  await nextFrame()
}

async function rerenderText(
  rerender: (ui: ReactElement) => void,
  text: string,
  streaming = true
): Promise<void> {
  act(() => {
    rerender(<TextPart text={text} streaming={streaming} />)
  })
  await frame()
}

beforeEach(() => {
  calls.length = 0
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (
      this: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes,
      options?: number | KeyframeAnimationOptions
    ): Animation {
      calls.push({
        element: this,
        keyframes: keyframes as Keyframe[],
        options: (options ?? {}) as KeyframeAnimationOptions
      })
      return fakeAnimation()
    }
  })
  setReveal('on')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalAnimate === undefined) delete (Element.prototype as { animate?: unknown }).animate
  else Object.defineProperty(Element.prototype, 'animate', originalAnimate)
})

describe('PB-045 P1-C：纯段落增长不淡入（整段反复变暗 = 闪烁）', () => {
  it('首次挂载 + 连续 chunk 增长：0 次 opacity 动画', async () => {
    const { rerender } = render(<TextPart text="第一段" streaming />)
    await frame()
    expect(calls).toHaveLength(0)

    for (const text of ['第一段继续', '第一段继续写', '第一段继续写下去']) {
      await rerenderText(rerender, text)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('PB-045 P1-C：跨块只给新块一次入场', () => {
  it('块数 1→2 时只动画最后一个新块一次：0.6→1 / 150ms；后续同块增长不再动画', async () => {
    const { rerender } = render(<TextPart text="第一段" streaming />)
    await frame()
    calls.length = 0 // 首挂载不计（目标口径本来就不淡入）

    // 标题是 splitBlocks 认的硬边界（普通段落之间空行不切块）
    await rerenderText(rerender, '第一段\n\n## 第二段')
    expect(calls).toHaveLength(1)
    const first = calls[0]

    // 同一块继续增长：同一元素不许再动（现状 red：每次 shown 变化都重启 0.4→1）
    await rerenderText(rerender, '第一段\n\n## 第二段继续')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.element).toBe(first?.element)
    expect(first?.keyframes[0]).toMatchObject({ opacity: 0.6 })
    expect(first?.keyframes[1]).toMatchObject({ opacity: 1 })
    expect(first?.options.duration).toBe(150)
  })
})

describe('PB-045 P1-C：不触发条件', () => {
  it('streaming=false：块增长也不淡入', async () => {
    const { rerender } = render(<TextPart text="第一段" streaming />)
    await frame()
    calls.length = 0
    await rerenderText(rerender, '第一段\n\n## 第二段', false)
    expect(calls).toHaveLength(0)
  })

  it('reveal=off：块增长也不淡入', async () => {
    setReveal('off')
    const { rerender } = render(<TextPart text="第一段" streaming />)
    await frame()
    calls.length = 0
    await rerenderText(rerender, '第一段\n\n## 第二段')
    expect(calls).toHaveLength(0)
  })
})
