import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { MessageList } from '@renderer/features/chat/MessageList'
import { mapStoredMessages } from '@renderer/lib/message-map'

/**
 * 用户消息里的 file part（模块 2）：图片随消息真发出去之后，气泡得看得见它——
 * 否则用户发完不知道到底发出去了什么。
 *
 * 0.1.3 / 006 返工：图片是**固定 96×96 的缩略图**（object-contain，不改变原图比例 /
 * 不裁切），点开走共用 lightbox；非图片仍是文件名 chip。历史回灌（message-map 的
 * mapFilePart）也产同一种 part，所以刷新后同样画得出来、点得开。
 */
function userWith(parts: UIMessage['parts'], id = 'u1'): UIMessage {
  return { id, role: 'user', parts }
}

function imagePart(
  url = 'data:image/png;base64,AAAA',
  filename = 'shot.png'
): UIMessage['parts'][number] {
  return { type: 'file', mediaType: 'image/png', url, filename }
}

describe('模块 2 · 用户消息的图片与文件', () => {
  it('图片 part 画成固定尺寸缩略图（src = data URL、object-contain）；非图片给文件名；文本照旧', () => {
    render(
      <MessageList
        messages={[
          userWith([
            imagePart(),
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
    // 缩略图尺寸由外框固定，图片自己 contain（原比例、不裁切、不被原图撑大）
    expect(image).toHaveClass('size-full', 'object-contain')
    const open = screen.getByTestId('message-image-open')
    expect(open.tagName).toBe('BUTTON')
    expect(open).toHaveClass('size-24')
    expect(open).toHaveAccessibleName('放大查看 shot.png')
    expect(open).toContainElement(image)

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
    expect(screen.getByTestId('message-image-open')).toHaveAccessibleName('放大查看 图片')
  })

  it('点缩略图打开 lightbox：src 原样、居中 contain；关闭钮与 Esc 都能关，按钮可键盘聚焦', async () => {
    render(
      <MessageList
        messages={[userWith([imagePart('data:image/png;base64,VIEW', 'view.png')])]}
        status="ready"
      />
    )

    const open = screen.getByTestId('message-image-open')
    open.focus()
    expect(document.activeElement).toBe(open)

    fireEvent.click(open)
    const lightbox = screen.getByTestId('message-image-lightbox')
    const enlarged = within(lightbox).getByTestId('message-image-lightbox-img')
    // 放大用的是同一份真实 data URL，不是另存 / 重编码的副本
    expect(enlarged).toHaveAttribute('src', 'data:image/png;base64,VIEW')
    expect(enlarged).toHaveClass('max-h-[85vh]', 'max-w-[90vw]', 'object-contain')
    // 右键不吃原生菜单（与预览区同口径）
    expect(fireEvent.contextMenu(enlarged)).toBe(false)

    fireEvent.click(screen.getByTestId('message-image-lightbox-close'))
    await waitFor(() =>
      expect(screen.queryByTestId('message-image-lightbox')).not.toBeInTheDocument()
    )
    // 看过大图之后，原消息里的图片载荷仍是同一条 data URL
    expect(screen.getByTestId('message-image')).toHaveAttribute('src', 'data:image/png;base64,VIEW')

    fireEvent.click(open)
    expect(screen.getByTestId('message-image-lightbox')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('message-image-lightbox')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('message-image')).toHaveAttribute('src', 'data:image/png;base64,VIEW')
  })

  it('多张图片：各自一个固定缩略图，点哪张开哪张', () => {
    render(
      <MessageList
        messages={[
          userWith([
            imagePart('data:image/png;base64,FIRST', 'first.png'),
            imagePart('data:image/png;base64,SECOND', 'second.png')
          ])
        ]}
        status="ready"
      />
    )

    const thumbs = screen.getAllByTestId('message-image')
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0]).toHaveClass('object-contain')
    const opens = screen.getAllByTestId('message-image-open')
    fireEvent.click(opens[1])

    const enlarged = screen.getByTestId('message-image-lightbox-img')
    expect(enlarged).toHaveAttribute('src', 'data:image/png;base64,SECOND')
    expect(within(screen.getByTestId('message-image-lightbox')).getByAltText('second.png')).toBe(
      enlarged
    )
  })

  it('纯文件消息（没有文本 part）：文件名 chip 仍在，用户轮不丢', () => {
    render(
      <MessageList
        messages={[
          userWith([
            {
              type: 'file',
              mediaType: 'application/pdf',
              url: 'data:application/pdf;base64,BBBB',
              filename: 'doc.pdf'
            }
          ])
        ]}
        status="ready"
      />
    )

    expect(screen.getByTestId('message-u1')).toHaveAttribute('data-role', 'user')
    expect(screen.getByTestId('message-file')).toHaveTextContent('doc.pdf')
  })

  it('纯文件用户消息在导览轨里仍有节点（不丢轮次边界）', () => {
    render(
      <MessageList
        messages={[
          userWith([
            {
              type: 'file',
              mediaType: 'application/pdf',
              url: 'data:application/pdf;base64,BBBB',
              filename: 'doc.pdf'
            }
          ]),
          userWith([{ type: 'text', text: '第二问' }], 'u2'),
          {
            id: 'a1',
            role: 'assistant',
            parts: [{ type: 'text', text: '答' }]
          }
        ]}
        status="ready"
      />
    )

    expect(screen.getByTestId('rail-node-u1')).toBeInTheDocument()
    expect(screen.getByTestId('rail-node-u2')).toBeInTheDocument()
  })

  it('没有 file part 的用户消息不多画那一条（不空占位）', () => {
    render(<MessageList messages={[userWith([{ type: 'text', text: '只有字' }])]} status="ready" />)

    expect(screen.queryByTestId('message-files')).not.toBeInTheDocument()
  })

  it('历史回读（v4 file part）：图片仍画缩略图，点开是同一条 data URL', () => {
    const stored = [
      {
        id: 'u-history',
        role: 'user',
        content: {
          format: 2,
          parts: [
            { type: 'file', mimeType: 'image/png', data: 'HISTORY' },
            { type: 'text', text: '历史消息里的图' }
          ]
        }
      }
    ] as unknown as StoredMessage[]
    const [message] = mapStoredMessages(stored)
    render(<MessageList messages={[message]} status="ready" />)

    // 历史映射把裸 base64 还原成 data URL（与发送时同一种 file part 形状）
    const thumb = screen.getByTestId('message-image')
    expect(thumb).toHaveAttribute('src', 'data:image/png;base64,HISTORY')
    expect(thumb).toHaveClass('object-contain')

    fireEvent.click(screen.getByTestId('message-image-open'))
    expect(screen.getByTestId('message-image-lightbox-img')).toHaveAttribute(
      'src',
      'data:image/png;base64,HISTORY'
    )
  })
})
