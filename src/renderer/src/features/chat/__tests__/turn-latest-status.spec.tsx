import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '../Message'
import { formatChineseDuration, latestStepLabel } from '../parts/turn-latest-status-model'

const CSS = readFileSync(resolve(__dirname, '../turn-process.css'), 'utf8')

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

afterEach(() => {
  vi.useRealTimers()
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
    expect(screen.getByTestId('turn-latest-duration')).toHaveClass('tabular-nums')
    expect(screen.getByTestId('turn-latest-duration')).toHaveTextContent('0秒')

    act(() => {
      vi.advanceTimersByTime(129_000)
    })
    expect(screen.getByTestId('turn-latest-duration')).toHaveTextContent('2分9秒')

    rerender(<Message message={assistant([TOOL_PART])} streaming={false} />)
    expect(screen.queryByTestId('turn-latest-status')).not.toBeInTheDocument()
  })

  it('正文独立流式区：过程区内只剩工具/思考，正文在 turn-answer', () => {
    render(
      <Message message={assistant([TOOL_PART, { type: 'text', text: '正文内容' }])} streaming />
    )
    // 正文开始后过程自动折叠；过程/正文仍是两个容器（折叠时 body 不挂载也算分离）
    expect(screen.queryByTestId('turn-process-body')?.textContent ?? '').not.toContain('正文内容')
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('正文内容')
  })

  it('reduced：CSS 里脉冲/过渡有 prefers-reduced-motion 与 [data-motion=reduced] 两层静态', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CSS).toContain("[data-motion='reduced'] .three-body-orbit")
    expect(CSS).toMatch(/\.three-body-orbit\s*\{[^}]*animation:/)
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.three-body-orbit[^{]*\{[^}]*animation:\s*none/
    )
  })
})

describe('中文计时 / 最新步骤纯函数', () => {
  it('formatChineseDuration：0秒 / 9秒 / 2分9秒 / 1小时2分3秒', () => {
    expect(formatChineseDuration(0)).toBe('0秒')
    expect(formatChineseDuration(9_000)).toBe('9秒')
    expect(formatChineseDuration(129_000)).toBe('2分9秒')
    expect(formatChineseDuration(3_723_000)).toBe('1小时2分3秒')
  })

  it('latestStepLabel：尾部 reasoning / tool；空列表回「正在处理」', () => {
    const entries = [
      { part: { type: 'reasoning', text: '想一下' }, index: 0, streaming: false, settled: true },
      { part: TOOL_PART, index: 1, streaming: true, settled: false }
    ] as Parameters<typeof latestStepLabel>[0]
    expect(latestStepLabel(entries)).toBe('正在调用工具')
    expect(latestStepLabel([])).toBe('正在处理')
  })
})

describe('task-83 · 竖线/右缘/自动折叠/三体 SVG', () => {
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

  it('底部最新步骤用三体主题 inline SVG（无外链），文字/计时仍在', () => {
    render(<Message message={assistant([TOOL_PART])} streaming />)
    const svg = screen.getByTestId('three-body-glyph')
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0)
    expect(screen.getByTestId('turn-latest-status')).toHaveTextContent('正在调用工具')
    expect(screen.getByTestId('turn-latest-duration')).toHaveClass('tabular-nums')
  })
})
