import { useEffect, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextPart } from '../parts/TextPart'
import { splitBlocks } from '../parts/markdown-blocks'

/**
 * 流式正文的**行为**口径（round 73）—— 按帧合流 + 结束即终态。
 *
 * markdown 引擎这里换成计数替身（`vi.mock('react-markdown')`）：这一组用例要钉的是
 * "**当引擎被调用几次**"，不是 markdown 怎么解析（解析归 markdown.spec.tsx 管）。真引擎下的
 * 分块保真度在 text-part-blocks.spec.tsx 里钉。
 *
 * 帧用假 rAF 受控推进（`vi.advanceTimersByTime`），不做任何时间断言：
 *   "推进一帧"是确定的，"跑 16ms 后应该渲染 N 次"才是脆的。
 *
 * 推 delta 的方式：宿主订阅一个模块级的投递口（`publishStream`），用例往里投 —— 与线上
 * "外部系统推数据、组件在回调里 setState"同一形状，也不需要在渲染期改任何东西。
 */
const engine = vi.hoisted(() => ({ renders: 0 }))

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => {
    engine.renders += 1
    return <div data-testid="engine-out">{children}</div>
  }
}))

type StreamListener = (next: string, done: boolean) => void
const listeners = new Set<StreamListener>()

/** 投递一条 delta（`done` = 这一拍流结束） */
function publishStream(next: string, done = false): void {
  for (const listener of listeners) listener(next, done)
}

/** 受控推进的流式宿主：渲染路径与线上完全一致（TextPart） */
function Stream({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [streaming, setStreaming] = useState(true)
  useEffect(() => {
    const listener: StreamListener = (next, done) => {
      setText(next)
      if (done) setStreaming(false)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return <TextPart text={text} streaming={streaming} />
}

function push(text: string, done = false): void {
  act(() => {
    publishStream(text, done)
  })
}

/** 推进一帧（假 rAF 一次）—— 节流后的渲染就发生在这里 */
function advanceFrame(): void {
  act(() => {
    vi.advanceTimersByTime(20)
  })
}

/** 抹掉空白差异 —— 分块渲染会在块之间补换行（见 text-part-blocks.spec.tsx 的逐字节比对） */
function flat(text: string): string {
  return text.replace(/\s+/g, '')
}

function shownText(): string {
  return flat(screen.getByTestId('message-text').textContent ?? '')
}

function shownRaw(): string {
  return screen.getByTestId('message-text').textContent ?? ''
}

/** 造一条"多块"的增量序列：每节一个标题（硬边界），节内是正文 */
function deltas(count: number): string[] {
  const out: string[] = []
  let text = ''
  for (let index = 1; index <= count; index += 1) {
    text +=
      index % 8 === 1 ? `## 第 ${index} 节\n\n` : `第 ${index} 段正文，用来把内容撑长一点。\n\n`
    out.push(text)
  }
  return out
}

beforeEach(() => {
  engine.renders = 0
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
})

afterEach(() => {
  vi.useRealTimers()
  listeners.clear()
})

describe('流式正文：按帧合流（round 73）', () => {
  it('同一帧内的 N 条 delta 只触发一次上屏，稳定前缀块不再重解析', () => {
    const steps = deltas(200)
    render(<Stream />)
    const afterMount = engine.renders

    // 一口气推 200 条 delta：全落在同一帧里
    for (const text of steps) push(text)

    // 还没到帧：一次都没重渲染（内容仍是旧的）
    expect(engine.renders).toBe(afterMount)

    advanceFrame()

    const finalText = steps[steps.length - 1] ?? ''
    const blocks = splitBlocks(finalText)
    expect(blocks).not.toBeNull()
    // 一帧只画一次：首次上屏时按块渲染（每块一个 markdown 实例），画的是**最新**那一份
    expect(engine.renders - afterMount).toBe(blocks?.length)
    expect(shownText()).toBe(flat(finalText))

    // 继续推 200 条 delta —— 只往后长最后一块（没有新边界）
    let grown = finalText
    for (let index = 0; index < 200; index += 1) {
      grown += `追加第 ${index} 句。`
      push(grown)
    }
    const beforeGrowth = engine.renders
    advanceFrame()

    // 稳定前缀块的 text 没变 → 整棵跳过；这一帧只有**最后一块**重解析
    expect(engine.renders - beforeGrowth).toBe(1)
    expect(shownText()).toBe(flat(grown))

    // 总账：400 条 delta 一共只让引擎跑了"块数 + 1"次
    expect(engine.renders).toBeLessThan(40)
  })

  it('流式期间内容逐帧增长（不是憋到最后一次性出现）', () => {
    const steps = deltas(200)
    render(<Stream />)

    for (let index = 0; index < 40; index += 1) {
      push(steps[index] ?? '')
      advanceFrame()
      // 每一帧都该看到"到这一帧为止的全部内容"——不是空、也不是跳到最后
      expect(shownText()).toBe(flat(steps[index] ?? ''))
    }
  })

  it('结束时（streaming=false）立刻是最终文本，不留旧内容', () => {
    const steps = deltas(120)
    render(<Stream />)

    push(steps[0] ?? '')
    advanceFrame()
    expect(shownText()).toBe(flat(steps[0] ?? ''))

    // 末尾一大批 delta + 结束，全落在同一帧里（收尾那一拍）
    for (const text of steps.slice(1)) push(text)
    push(steps[steps.length - 1] ?? '', true)

    // 一帧都没推进：屏幕上也必须是最终文本
    expect(shownText()).toBe(flat(steps[steps.length - 1] ?? ''))
  })

  it('同帧内"delta 后又来一条 delta"只上屏一次，且是最后那一份', () => {
    render(<Stream initial="开头" />)
    advanceFrame()

    push('开头一')
    push('开头一二')
    push('开头一二三')
    advanceFrame()

    expect(shownRaw()).toBe('开头一二三')
  })

  it('正文被换掉（不是上屏那份的前缀）时立刻按 props 画，不等帧、不显示残留', () => {
    // 同一条消息上重开一条流（重新生成）：正文从上一轮的长文变成新的一段，
    // 合流值不再是当前 text 的前缀 —— 这一帧就该按 props 画，等下一帧再合流
    render(<Stream initial="上一轮的完整回答，很长很长" />)

    push('新的开头')
    expect(shownRaw()).toBe('新的开头')
  })

  it('卸载时撤掉排着的帧（不留悬挂的 rAF）', () => {
    const view = render(<Stream />)
    push('等着上屏的内容')
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('非流式：内容与 props 同步（不做任何延迟）', () => {
    render(<TextPart text="已经结束了" streaming={false} />)
    expect(shownRaw()).toBe('已经结束了')
    expect(vi.getTimerCount()).toBe(0)
  })
})
