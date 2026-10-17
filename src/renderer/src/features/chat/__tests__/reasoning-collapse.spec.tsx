import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { ReasoningPart } from '@renderer/features/chat/parts/ReasoningPart'
import { TraceBlock } from '@renderer/features/chat/parts/TraceBlock'

/**
 * 思考块的自动折叠（round 88，用户现场口径）：
 *   一段思考后面**已经出现别的内容**（工具行 / 正文 / 下一段思考）→ 这一段自动收起，把版面让开；
 *   判据是"后面有东西上屏"，不是"整轮跑完"；正在写的那一段（后面什么都没有）不收；
 *   只收一次 —— 用户之后点开就听用户的，不因为每次 rerender 再压回去。
 *
 * 两条渲染路径都要管：Message 里"纯思考的 run"直接渲染的那一份（独立 ReasoningPart），
 * 与 TraceBlock 里"思考 + 工具"那一份（过程块内的思考行）。
 */
const ENGLISH = 'Let me read the config first.'

function reasoningMessage(parts: UIMessage['parts'], id = 'a1'): UIMessage {
  return { id, role: 'assistant', parts }
}

function toolPart(state: string): UIMessage['parts'][number] {
  return {
    type: 'tool-bash',
    toolCallId: 'call-1',
    state,
    input: { command: 'ls' }
  } as UIMessage['parts'][number]
}

function foldOf(): HTMLElement {
  return screen.getByTestId('trace-fold')
}

/** 当前这一份思考块是开是收（以容器上的 data-open 为准；按钮的 aria-expanded 只是它的一面） */
function openState(): string | null {
  return screen.getByTestId('reasoning-toggle').getAttribute('aria-expanded')
}

describe('思考块自动折叠（独立 ReasoningPart）', () => {
  it('后面出现别的内容（settled）就收起；还没出现时保持展开', () => {
    const { rerender } = render(<ReasoningPart text={ENGLISH} streaming />)
    expect(openState()).toBe('true')

    // 后面还是空的（这一段就是最后一条）→ 不收
    rerender(<ReasoningPart text={ENGLISH} streaming settled={false} />)
    expect(openState()).toBe('true')

    // 工具行 / 正文上屏 → 收
    rerender(<ReasoningPart text={ENGLISH} streaming={false} settled />)
    expect(openState()).toBe('false')
    // 内容仍在 DOM（TraceFold 的容器级折叠，不做条件渲染）
    expect(screen.getByTestId('reasoning-text')).toBeInTheDocument()
  })

  it('正在写的那一段（streaming、后面没有内容）不收 —— 整轮 live 还挂着也不收', () => {
    render(<ReasoningPart text={ENGLISH} streaming live settled={false} />)
    expect(openState()).toBe('true')
  })

  it('只收一次：收掉之后用户点开，后续 rerender 不再把他压回去', () => {
    const { rerender } = render(<ReasoningPart text={ENGLISH} streaming settled />)
    expect(openState()).toBe('false')

    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(openState()).toBe('true')
    expect(foldOf()).toHaveAttribute('data-open', 'true')

    // 同一段继续重渲染（流式增量、翻译状态翻旗都算）：用户开着就开着
    rerender(<ReasoningPart text={`${ENGLISH} more`} streaming settled />)
    expect(openState()).toBe('true')
    rerender(<ReasoningPart text={`${ENGLISH} more`} streaming={false} settled />)
    expect(openState()).toBe('true')
  })

  it('用户先手动收起 / 先手动点开过：自动折叠不覆盖用户的选择', () => {
    const { rerender } = render(<ReasoningPart text={ENGLISH} streaming />)
    // 用户先自己收起来 → 保持收着（不受自动折叠影响）
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(openState()).toBe('false')
    rerender(<ReasoningPart text={ENGLISH} streaming={false} settled />)
    expect(openState()).toBe('false')

    // 另一份：用户先点开（还没 settled）→ 后面内容来了也不收（听用户的）
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(openState()).toBe('true')
    rerender(<ReasoningPart text={ENGLISH} streaming={false} settled />)
    expect(openState()).toBe('true')
  })
})

describe('思考块自动折叠（TraceBlock 内的思考行）', () => {
  const REASONING = {
    part: { type: 'reasoning', text: ENGLISH } as UIMessage['parts'][number],
    index: 0,
    streaming: false,
    settled: false
  }
  const TOOL = { part: toolPart('input-available'), index: 1, streaming: true, settled: false }

  it('块内思考后面来了工具行（这一段已 settled）→ 思考行收起，过程块本身照旧展开', () => {
    const { rerender } = render(<TraceBlock entries={[REASONING]} running />)
    expect(openState()).toBe('true')

    rerender(<TraceBlock entries={[{ ...REASONING, settled: true }, TOOL]} running />)
    expect(openState()).toBe('false')
    // 整轮还在跑，过程块（工具行那一层）不能跟着收
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
  })

  it('正在写的那一段（streaming）不收：后面还没有别的条目', () => {
    render(
      <TraceBlock
        entries={[
          {
            part: { type: 'reasoning', text: ENGLISH } as UIMessage['parts'][number],
            index: 0,
            streaming: true,
            settled: false
          }
        ]}
        running
      />
    )
    expect(openState()).toBe('true')
  })
})

describe('思考块自动折叠（整条消息：正文到达）', () => {
  it('工具跑完、正文开始写：前面的思考块自动收起（思考在过程块里）', () => {
    const parts: UIMessage['parts'] = [
      { type: 'reasoning', text: ENGLISH },
      toolPart('output-available'),
      { type: 'text', text: '答案在这里' }
    ]
    render(<Message message={reasoningMessage(parts)} streaming />)

    // task-83：最终正文一开始，整个过程块自动折叠（汇总行仍在）
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    // 展开后：块内思考行因后面已有内容仍是收起的
    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('message-text')).toHaveTextContent('答案在这里')
  })

  it('只有一段思考、后面什么都没有（还在写）→ 保持展开', () => {
    render(<Message message={reasoningMessage([{ type: 'reasoning', text: ENGLISH }])} streaming />)
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('自动折叠的边界：空正文 / 空占位 / 手动重开', () => {
  it('SSE 只落了 text-start（空正文、界面上只有一枚光标）→ 思考不收', () => {
    render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '' }
        ])}
        streaming
      />
    )

    // 空正文不是"内容出现"：只有一个容器 + 流式光标，一个字都没有
    expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument()
    expect(screen.getByTestId('message-text')).toHaveTextContent('')
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('第一个可见字到了（text-delta）→ 这时才收', async () => {
    const { rerender } = render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '' }
        ])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '答' }
        ])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    // 正文按帧上屏（TextPart 的合流），断言等到那一帧
    await waitFor(() => expect(screen.getByTestId('message-text')).toHaveTextContent('答'))
  })

  it('空白正文（只有换行）也不算内容 → 不收', () => {
    render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '\n\n  ' }
        ])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('工具行一出现（哪怕参数还在准备）就算内容 → 思考收起来', () => {
    render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          toolPart('input-streaming')
        ])}
        streaming
      />
    )
    // 工具卡上屏就有名字与状态行（"准备参数"），思考让版面
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('空正文之后用户手动重开 → 正文写出字来也不许再压回去', () => {
    const { rerender } = render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '' }
        ])}
        streaming
      />
    )
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: ENGLISH },
          { type: 'text', text: '答案' }
        ])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('过程块内：工具行插到两段思考之间时，第二段的序号平移不许把它重挂（手动展开保住）', () => {
    const first = { type: 'reasoning', text: '第一段' } as UIMessage['parts'][number]
    const tool = toolPart('output-available')
    const second = { type: 'reasoning', text: '第二段' } as UIMessage['parts'][number]

    const { rerender } = render(<Message message={reasoningMessage([first, second])} streaming />)
    // 第一段后面已有内容 → 自动收起；第二段是最后一条 → 开着
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['false', 'true'])
    // 用户把第二段收起来（它本来开着，点一下 = 手动收起）
    fireEvent.click(screen.getAllByTestId('reasoning-toggle')[1])
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['false', 'false'])

    // 工具行插进两段之间：按块内序号算 key 的话第二段会整棵重挂 → 用户的选择被丢掉
    rerender(<Message message={reasoningMessage([first, tool, second])} streaming />)
    console.log(
      'DBG labels=',
      JSON.stringify(
        screen.getAllByTestId('reasoning-part').map((node) => ({
          label: node.querySelector('[data-testid="reasoning-toggle"]')?.textContent,
          aria: node
            .querySelector('[data-testid="reasoning-toggle"]')
            ?.getAttribute('aria-expanded')
        }))
      ),
      'parts=',
      'aria=',
      JSON.stringify(
        screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
      ),
      'toggles=',
      screen.getAllByTestId('reasoning-toggle').length,
      'tools=',
      screen.queryAllByTestId('tool-card').length
    )
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['false', 'false'])
  })
})

describe('自动折叠之后重新展开 → 后续工具到达不许再压回去（重挂边界）', () => {
  const first = { type: 'reasoning', text: '先想一段' } as UIMessage['parts'][number]

  it('纯思考块里重开（自动折叠后）→ 工具到达换过程块，仍保持用户的选择（展开）', () => {
    const { rerender } = render(
      <Message message={reasoningMessage([first, { type: 'text', text: '答' }])} streaming />
    )
    // 正文一到就自动折叠
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    // 用户重新展开（内容随之进 DOM）
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先想一段')

    // 工具到达：这段思考从"直接挂在消息下"换成过程块里的思考行 —— 组件类型一变整棵重挂
    rerender(
      <Message
        message={reasoningMessage([
          first,
          toolPart('output-available'),
          { type: 'text', text: '答' }
        ])}
        streaming
      />
    )
    // task-83：正文已开始 → 整个过程块自动折叠；用户展开过程块后，思考行的手动展开选择仍在
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先想一段')
  })

  it('反向：用户在自动折叠前后手动收起 → 工具到达后仍是收起的', () => {
    const { rerender } = render(
      <Message message={reasoningMessage([first, { type: 'text', text: '答' }])} streaming />
    )
    // 从"自动折叠"这一档再点一次 = 手动展开，再点 = 手动收起（显式选择）
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <Message
        message={reasoningMessage([
          first,
          toolPart('output-available'),
          { type: 'text', text: '答' }
        ])}
        streaming
      />
    )
    // task-83：正文开始 → 过程块自动折叠；展开过程块后思考行保持用户手动收起
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('两段思考：各自的手动选择互不串（收的那段仍是收的，开的那段仍是开的）', () => {
    const second = { type: 'reasoning', text: '再想一段' } as UIMessage['parts'][number]
    const tool = toolPart('output-available')
    const { rerender } = render(<Message message={reasoningMessage([first, second])} streaming />)
    // 第一段后面已有内容（第二段）→ 自动收起；第二段是最后一条 → 开着
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['false', 'true'])
    // 用户手动把第一段展开
    fireEvent.click(screen.getAllByTestId('reasoning-toggle')[0])
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['true', 'true'])

    // 工具到达：两段的手动选择各自守住（第一段仍是用户展开的，第二段仍自动开着）
    rerender(<Message message={reasoningMessage([first, tool, second])} streaming />)
    expect(
      screen.getAllByTestId('reasoning-toggle').map((node) => node.getAttribute('aria-expanded'))
    ).toEqual(['true', 'true'])
  })

  it('换了消息 / 位置换成了另一段思考：旧选择不许跟过去', () => {
    const { rerender } = render(
      <Message message={reasoningMessage([first, { type: 'text', text: '答' }])} streaming />
    )
    // 起点是自动折叠档：点一次 = 手动展开（显式的用户选择）
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    // 同一个位置换成了另一段思考（重新生成）：新的一段按自动档走（后面有正文 → 收起）
    rerender(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: '另一段思考' },
          { type: 'text', text: '答' }
        ])}
        streaming
      />
    )
    // 新的一段按自己的自动档走（后面有正文 → 收起）；旧选择没跟过来
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'false')
  })

  it('换了消息 id（同一实例复用）：手动展开不跟到另一条消息上', () => {
    const parts = [
      { type: 'reasoning', text: '第一轮的想法' },
      { type: 'text', text: '答' }
    ] as UIMessage['parts']
    const { rerender } = render(<Message message={reasoningMessage(parts, 'a1')} streaming />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    rerender(
      <Message
        message={reasoningMessage(
          [
            { type: 'reasoning', text: '另一条消息的想法' },
            { type: 'text', text: '另一条消息的答' }
          ] as UIMessage['parts'],
          'a2'
        )}
        streaming
      />
    )
    expect(screen.getByTestId('message-a2')).toBeInTheDocument()
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('流式追加正文时的手动开合（同一段继续长，选择不丢）', () => {
  it('手动收起正在生成的思考 → 后面又追加 token，仍是收起的', () => {
    const { rerender } = render(
      <Message message={reasoningMessage([{ type: 'reasoning', text: '先看' }])} streaming />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')

    // 同一段继续长（前缀追加）：手动收起不许被当成"换了一段"而重置
    rerender(
      <Message
        message={reasoningMessage([{ type: 'reasoning', text: '先看目录结构' }])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')

    rerender(
      <Message
        message={reasoningMessage([{ type: 'reasoning', text: '先看目录结构再核对调用链' }])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('手动展开 → 继续追加仍是展开的（自动折叠不许再压回）', () => {
    const { rerender } = render(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: '想法' },
          { type: 'text', text: '答' }
        ])}
        streaming
      />
    )
    // 正文已到 → 自动折叠
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    // 这一段又长了（正文也在长，形态不变）
    rerender(
      <Message
        message={reasoningMessage([
          { type: 'reasoning', text: '想法又补了两句' },
          { type: 'text', text: '答案' }
        ])}
        streaming
      />
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('同一个组件实例换成另一条消息：手动展开不跟过去', () => {
    const parts = [
      { type: 'reasoning', text: '第一轮的想法' },
      { type: 'text', text: '答' }
    ] as UIMessage['parts']
    const { rerender } = render(<Message message={reasoningMessage(parts, 'a1')} streaming />)
    fireEvent.click(screen.getByTestId('reasoning-toggle'))
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')

    // 同一位置换成另一条消息（列表复用）：新消息里的这段思考按自己的自动档走（正文已到 → 收起）
    rerender(
      <Message
        message={reasoningMessage(
          [
            { type: 'reasoning', text: '另一条消息的想法' },
            { type: 'text', text: '另一条消息的答' }
          ] as UIMessage['parts'],
          'a2'
        )}
        streaming
      />
    )
    expect(screen.getByTestId('message-a2')).toBeInTheDocument()
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})
