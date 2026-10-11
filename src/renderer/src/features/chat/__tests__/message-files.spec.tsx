import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '@renderer/features/chat/MessageList'

/**
 * 用户消息里的 file part（模块 2）：图片随消息真发出去之后，气泡得看得见它——
 * 否则用户发完不知道到底发出去了什么。最小实现：图片给缩略图，非图片给一条文件名。
 * 历史回灌（message-map 的 mapFilePart）也产同一种 part，所以刷新后同样画得出来。
 */
function userWith(parts: UIMessage['parts']): UIMessage {
  return { id: 'u1', role: 'user', parts }
}

describe('模块 2 · 用户消息的图片与文件', () => {
  it('图片 part 画成缩略图（src = data URL）；非图片给文件名；文本照旧', () => {
    render(
      <MessageList
        messages={[
          userWith([
            {
              type: 'file',
              mediaType: 'image/png',
              url: 'data:image/png;base64,AAAA',
              filename: 'shot.png'
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              url: 'data:application/pdf;base64,BBBB',
              filename: 'doc.pdf'
            },
            { type: 'text', text: '看看这个' }
          ])
        ]}
        status="ready"
      />
    )

    const image = screen.getByTestId('message-image')
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(image).toHaveAttribute('alt', 'shot.png')

    expect(screen.getByTestId('message-file')).toHaveTextContent('doc.pdf')
    expect(screen.getByTestId('message-u1')).toHaveTextContent('看看这个')
  })

  it('纯图片消息（没有文本 part）：气泡仍是一条用户消息，图片在里面', () => {
    render(
      <MessageList
        messages={[
          userWith([{ type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,CCCC' }])
        ]}
        status="ready"
      />
    )

    expect(screen.getByTestId('message-u1')).toHaveAttribute('data-role', 'user')
    expect(screen.getByTestId('message-image')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,CCCC'
    )
  })

  it('没有 file part 的用户消息不多画那一条（不空占位）', () => {
    render(<MessageList messages={[userWith([{ type: 'text', text: '只有字' }])]} status="ready" />)

    expect(screen.queryByTestId('message-files')).not.toBeInTheDocument()
  })
})
