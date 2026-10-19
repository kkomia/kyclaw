import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'

/**
 * PB-031（用户原话：「等所有轮次输出完之后再统一显示…不然上面思考行在新增，下面正文回答也在新增」）。
 *
 * 契约：流式中只实时渲染**最后一次过程之后**的正文（最终回答）；中间轮次正文等轮末
 * （`streaming=false`）按原顺序一次全出，内容不丢。
 * 纯文本回答（无工具、lastProcessIndex=-1）不受影响，仍照常流式（见 trace-block/chat-flow 原用例）。
 */
function assistant(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts } as unknown as UIMessage
}

const MIDDLE_TEXT = { type: 'text', text: '中间正文：我先检查一下仓库。' }
const TOOL_PART = {
  type: 'tool-read',
  toolCallId: 'c1',
  state: 'output-available',
  input: { path: 'a.txt' },
  output: '内容'
}
const FINAL_TEXT = { type: 'text', text: '最终回答：仓库是干净的。' }

describe('PB-031 中间轮次正文延迟到轮末显示', () => {
  it('流式中：中间正文不渲染（只有过程块在长）；轮末：中间正文 + 最终回答按原顺序出现', () => {
    const withFinal = assistant([MIDDLE_TEXT, TOOL_PART, FINAL_TEXT])
    const { rerender } = render(<Message message={withFinal} streaming />)

    const answer = screen.getByTestId('turn-answer')
    // B-精简版：工具轮里流式中正文区为空（连最终回答也不抢先显示，避免闪现）
    expect(answer).toHaveTextContent('')
    expect(answer).not.toHaveTextContent('中间正文')

    // 轮末：中间正文补进来（内容不丢、顺序保持：中间在前、最终在后）
    rerender(<Message message={withFinal} streaming={false} />)
    const texts = screen.getByTestId('turn-answer').textContent ?? ''
    expect(texts).toContain('中间正文')
    expect(texts).toContain('最终回答')
    expect(texts.indexOf('中间正文')).toBeLessThan(texts.indexOf('最终回答'))
  })

  it('流式中还没出最终回答：正文区为空（中间正文不抢先长），过程块仍在', () => {
    render(<Message message={assistant([MIDDLE_TEXT, TOOL_PART])} streaming />)

    expect(screen.getByTestId('turn-answer')).toHaveTextContent('')
    expect(screen.getByTestId('trace-block')).toBeInTheDocument()

    // 轮末同样补出中间正文
    render(<Message message={assistant([MIDDLE_TEXT, TOOL_PART])} streaming={false} />)
    const answers = screen.getAllByTestId('turn-answer')
    expect(answers[answers.length - 1]).toHaveTextContent('中间正文')
  })

  it('纯文本回答（无过程）仍照常流式显示', () => {
    render(<Message message={assistant([{ type: 'text', text: '直接回答' }])} streaming />)
    expect(screen.getByTestId('turn-answer')).toHaveTextContent('直接回答')
  })
})
