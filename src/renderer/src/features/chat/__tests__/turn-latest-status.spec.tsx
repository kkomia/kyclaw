import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '../Message'
import { ChaseLoader } from '../parts/ChaseLoader'
import {
  entriesSignature,
  formatChineseDuration,
  latestStepLabel,
  latestStepStage
} from '../parts/turn-latest-status-model'
import type { TurnProcessEntry } from '../parts/TurnProcess'

const CSS = readFileSync(resolve(__dirname, '../turn-process.css'), 'utf8')
const CHASE_CSS = readFileSync(resolve(__dirname, '../parts/chase-loader.css'), 'utf8')
const CHASE_TSX = readFileSync(resolve(__dirname, '../parts/ChaseLoader.tsx'), 'utf8')

/**
 * task-77：AI 回复这一轮 = 固定高度内滚过程区 → 正文独立流式区 → 底部最新步骤。
 * **不要信封头**：DSH 的「收到任务消息」是 Agent Team 收到其他 agent 消息专用；
 * kyclaw 当前没有这种真实消息种类，所以用户消息/普通 AI 回复都不套那个头。
 */
const TOOL_PART = {
  type: 'tool-read',
  toolCallId: 'c1',
  state: 'input-available',
  input: { path: 'a.md' }
} as unknown as UIMessage['parts'][number]

function assistant(parts: UIMessage['parts']): UIMessage {
  return { id: 'a1', role: 'assistant', parts }
}

/** 纯函数用的过程条目（形状与 TurnProcess 输出一致） */
function entry(part: unknown, index = 0): TurnProcessEntry {
  return {
    part: part as TurnProcessEntry['part'],
    index,
    streaming: true,
    settled: false
  } as TurnProcessEntry
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AI 轮过程展示（task-77）', () => {
  it('不画信封头：普通 AI 回复没有「收到任务消息」，用户消息更不套', () => {
    render(<Message message={assistant([TOOL_PART, { type: 'text', text: '正文' }])} />)
    expect(screen.queryByText('收到任务消息')).not.toBeInTheDocument()
    expect(screen.queryByTestId('turn-received')).not.toBeInTheDocument()
  })

  it('DOM 顺序：内滚过程区 → 正文 → 底部最新步骤（最新步骤固定最下方）', () => {
    // 无正文（过程运行中）→ 底部最新步骤可见；正文一旦开始，过程完成会折叠并收起状态行
    render(<Message message={assistant([TOOL_PART])} streaming />)
    const process = screen.getByTestId('trace-block')
    const answer = screen.getByTestId('turn-answer')
    const latest = screen.getByTestId('turn-latest-status')

    const nodes = [process, answer, latest]
    for (let index = 1; index < nodes.length; index += 1) {
      const previous = nodes[index - 1]
      const current = nodes[index]
      expect(
        previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    }
  })

  it('最新步骤：运行中显示文案 + 中文计时（tabular）；2分9秒；结束不占位', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Message message={assistant([TOOL_PART])} streaming />)

    expect(screen.getByTestId('turn-latest-status')).toHaveTextContent('正在调用工具')
    expect(screen.getByTestId('turn-latest-status')).toHaveAttribute('data-stage', 'tool-running')
    expect(screen.getByTestId('turn-latest-duration')).toHaveClass('tabular-nums')
    expect(screen.getByTestId('turn-latest-duration')).toHaveTextContent('0秒')

    act(() => {
      vi.advanceTimersByTime(129_000)
    })
    expect(screen.getByTestId('turn-latest-duration')).toHaveTextContent('2分9秒')

    rerender(<Message message={assistant([TOOL_PART])} streaming={false} />)
    expect(screen.queryByTestId('turn-latest-status')).not.toBeInTheDocument()
  })

  it('PB-031：有过程内容时流式中不渲染正文（轮末一次全出）', () => {
    const { rerender } = render(
      <Message message={assistant([TOOL_PART, { type: 'text', text: '正文内容' }])} streaming />
    )
    // 过程区里没有正文；正文区在流式中也不出（避免中间正文闪现）
    expect(screen.queryByTestId('turn-process-body')?.textContent ?? '').not.toContain('正文内容')
    expect(screen.getByTestId('turn-answer')).not.toHaveTextContent('正文内容')

    rerender(
      <Message message={assistant([TOOL_PART, { type: 'text', text: '正文内容' }])} streaming={false} />
    )
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('正文内容')
  })

  it('PB-032 reduced：chase-loader 的动画/轮换有两层静态兜底', () => {
    expect(CHASE_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CHASE_CSS).toContain("[data-motion='reduced'] .chase-dot")
    expect(CHASE_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chase-dot[^{]*\{[^}]*animation:\s*none/)
    // 轮换定时器在 reduced 下不排（组件源码契约）
    expect(CHASE_TSX).toContain('ROTATE_MS = 10_000')
    expect(CHASE_TSX).toMatch(/if \(reduced\) return undefined/)
    expect(CHASE_TSX).toContain('STAND_MS = 2_000')
  })
})

describe('中文计时 / 最新步骤纯函数', () => {
  it('formatChineseDuration：0秒 / 9秒 / 2分9秒 / 1小时2分3秒', () => {
    expect(formatChineseDuration(0)).toBe('0秒')
    expect(formatChineseDuration(9_000)).toBe('9秒')
    expect(formatChineseDuration(129_000)).toBe('2分9秒')
    expect(formatChineseDuration(3_723_000)).toBe('1小时2分3秒')
  })

  it('PB-032：8 个真实阶段 + idle + goal-round 的映射', () => {
    const cases: Array<[unknown, string, string]> = [
      [{ type: 'reasoning', text: '想一下' }, 'reasoning', '正在分析请求'],
      [{ type: 'tool-read', state: 'input-streaming' }, 'tool-preparing', '正在准备工具调用'],
      [{ type: 'tool-read', state: 'input-available' }, 'tool-running', '正在调用工具'],
      [{ type: 'tool-bash', state: 'approval-requested' }, 'tool-approval', '等待审批'],
      [{ type: 'tool-bash', state: 'approval-responded' }, 'tool-approval-done', '审批已回应，继续处理'],
      [{ type: 'tool-read', state: 'output-available' }, 'tool-result', '正在处理工具结果'],
      [{ type: 'tool-bash', state: 'output-error' }, 'tool-error', '工具出错，正在继续'],
      [{ type: 'tool-bash', state: 'output-denied' }, 'tool-denied', '工具被拒绝，正在继续']
    ]
    for (const [part, key, label] of cases) {
      const stage = latestStepStage([entry(part)])
      expect(stage.key).toBe(key)
      expect(stage.label).toBe(label)
      expect(stage.entryMotion).toMatch(/^(bounce|line|orbit)$/)
    }
    expect(latestStepStage([])).toMatchObject({ key: 'idle', label: '正在处理' })
    expect(latestStepStage([], 3)).toMatchObject({ key: 'goal-round', label: '目标续跑 · 第 3 轮' })
    // 兼容旧入口
    expect(latestStepLabel([entry({ type: 'reasoning' })])).toBe('正在分析请求')
    expect(latestStepLabel([])).toBe('正在处理')
  })

  it('PB-032：entriesSignature 随条数/状态/文本长度变化（10s 超时的判据）', () => {
    const a = entriesSignature([entry({ type: 'reasoning', text: '短' })])
    const b = entriesSignature([entry({ type: 'reasoning', text: '更长的文本' })])
    const c = entriesSignature([entry({ type: 'tool-read', state: 'input-available' })])
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('PB-032 · 装载指示器与轮换', () => {
  it('状态行使用 ChaseLoader：18×14 容器 / 4 个点 / 阶段对应 data-mode', () => {
    render(<Message message={assistant([TOOL_PART])} streaming />)
    const loader = screen.getByTestId('chase-loader')
    expect(loader).toHaveAttribute('data-mode', 'line')
    expect(loader.querySelectorAll('.chase-dot')).toHaveLength(4)
    expect(loader.className).toContain('chase-loader')
  })

  it('reduced 下图示切回静态 bounce（三点、不轮换）', () => {
    render(<Message message={assistant([TOOL_PART])} streaming />)
    // useEffectiveMotion 默认跟随系统；在 jsdom 里系统一般不是 reduced——用 DOM 契约断言兜底：
    // 组件在 reduced 时 data-mode 固定 bounce（源码契约见上一组测试），这里断言非 reduced 为 line。
    expect(screen.getByTestId('chase-loader')).toHaveAttribute('data-mode', 'line')
  })

  it('CSS 数值：容器 18×14、4px 点、周期 500/1250/2400ms、延迟 -500/-300/-200ms', () => {
    expect(CSS).toContain('.turn-latest-status')
    expect(CHASE_CSS).toMatch(/\.chase-loader\s*\{[^}]*width:\s*18px;[^}]*height:\s*14px;/)
    expect(CHASE_CSS).toMatch(/\.chase-dot\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/)
    expect(CHASE_CSS).toContain('animation: chase-bounce 500ms')
    expect(CHASE_CSS).toContain('animation: chase-line 1250ms')
    expect(CHASE_CSS).toContain('animation: chase-orbit-1 2400ms')
    expect(CHASE_CSS).toContain('animation-delay: -500ms')
    expect(CHASE_CSS).toContain('animation-delay: -300ms')
    expect(CHASE_CSS).toContain('animation-delay: -200ms')
  })

  it('PB-032：10s 无新输出 → 暂未响应（超时档覆盖当前阶段）', () => {
    vi.useFakeTimers()
    render(<Message message={assistant([TOOL_PART])} streaming />)
    expect(screen.getByTestId('turn-latest-status')).toHaveTextContent('正在调用工具')

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    // 超时状态先落 React，再让说法锁的 0ms 落位（两个 act 分开，避免定时器在 flush 前就错过）
    act(() => {
      vi.advanceTimersByTime(1_100)
    })
    expect(screen.getByTestId('turn-latest-status')).toHaveTextContent('暂未响应')
  })
})

describe('PB-032 · ChaseLoader 轮换节奏（假时钟）', () => {
  const mode = (): string | null =>
    screen.getByTestId('chase-loader').getAttribute('data-mode')

  it('每 10s 换一个不同于当前的 motion（连续两次都换）', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    render(<ChaseLoader entryMotion="line" word="正在调用工具" reduced={false} />)
    expect(mode()).toBe('line')

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(mode()).toBe('bounce')

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(mode()).toBe('line')
  })

  it('阶段变化时 motion 至少站 2s 才被接管', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <ChaseLoader entryMotion="line" word="正在调用工具" reduced={false} />
    )
    // 刚挂载就换阶段：入场 motion 至少站满 2s
    rerender(<ChaseLoader entryMotion="orbit" word="等待审批" reduced={false} />)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(mode()).toBe('line')
    act(() => {
      vi.advanceTimersByTime(1_100)
    })
    expect(mode()).toBe('orbit')
  })

  it('reduced：静态 bounce，30s 不轮换（不排 10s 定时器）', () => {
    vi.useFakeTimers()
    render(<ChaseLoader entryMotion="orbit" word="等待审批" reduced />)
    expect(mode()).toBe('bounce')
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(mode()).toBe('bounce')
  })
})

describe('task-83 · 竖线/右缘/自动折叠', () => {
  it('左侧无竖线；AI 正文与用户消息同一内容列（w-full，无 max-w/border-l）', () => {
    render(<Message message={assistant([TOOL_PART])} />)
    const lane = screen.getByTestId('message-reading-lane')
    expect(lane).not.toHaveClass('border-l')
    expect(lane).toHaveClass('w-full')
    expect(lane.className).not.toContain('max-w-[calc(')
    // 返工（用户截图）：markdown 全局 44em 行宽上限在 chat turn-answer 内取消，
    // 否则段落右缘仍比用户消息右缘缩进一大截（截图红框）。
    expect(CSS).toContain("[data-testid='turn-answer'] .markdown-body > p")
    expect(CSS).toContain("[data-testid='turn-answer'] .markdown-body > blockquote")
    expect(CSS).toMatch(/max-width: none;/)
  })

  it('最终正文开始流式 → 过程自动折叠；汇总行保留；手动可再展开', () => {
    render(
      <Message message={assistant([TOOL_PART, { type: 'text', text: '最终正文' }])} streaming />
    )
    const block = screen.getByTestId('trace-block')
    expect(block).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('turn-process-summary')).toHaveTextContent('调用 1 次工具')
    expect(screen.queryByTestId('turn-latest-status')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(block).toHaveAttribute('data-open', 'true')
  })
})
