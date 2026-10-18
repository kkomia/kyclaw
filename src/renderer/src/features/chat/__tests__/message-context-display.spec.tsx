import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { MessageList } from '@renderer/features/chat/MessageList'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { composeOutgoing } from '@renderer/features/chat/composer-attachments'
import type { PendingAttachment } from '@renderer/features/chat/composer-attachments'
import {
  buildUserMessageMetadata,
  forgetVerifiedSeals
} from '@renderer/features/chat/message-context'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 006 / 008 的**界面面**：气泡怎么画（**验过才藏**的追加段 + 下方图标项）、图片不重复、
 * 手写标记不误吃、核验不过/超时保持原文、发送时间（008 返工后的裸文字：hover / 键盘焦点 /
 * 记录时间限定；无背景、无边框、无气泡）。
 *
 * 上半段直接渲染 MessageList（纯展示题）；下半段走**真 ChatSession + 真 Composer + 假 transport**，
 * 在请求体里钉住"发给模型的那份正文一个字节没变、metadata 挂的是展示上下文 + 自有时间键"
 * （真链路 → libsql 的落库回读在 `src/mastra/__tests__/message-context-wire.spec.ts`）。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 2),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

/** 固定时刻：时间文案的期望值由测试用本机时区的日期部件拼出来（与实现独立） */
const SENT_AT = new Date(2026, 9, 16, 14, 5, 30).getTime()

function localLabel(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function attachment(text: string, name = 'note.md'): PendingAttachment {
  return { id: `${name}-1`, name, size: text.length, text }
}

/** 长到摘录盖不住中段的附件（复核用例要改"中间那一小截"） */
const LONG_BODY = Array.from(
  { length: 40 },
  (_, index) => `第 ${index + 1} 行内容：abcdefghij`
).join('\n')

/** 一条"真发出去过"的用户消息：正文与 metadata 都走真组装（不是手写的理想串） */
async function sentUserMessage(
  text: string,
  attachments: PendingAttachment[],
  options: { at?: number | null; id?: string } = {}
): Promise<UIMessage> {
  const outgoing = composeOutgoing({ text, attachments })
  const metadata =
    options.at === null
      ? undefined
      : await buildUserMessageMetadata({
          at: options.at ?? SENT_AT,
          text: outgoing.text,
          context: outgoing.context
        })
  return {
    id: options.id ?? 'u1',
    role: 'user',
    parts: [...outgoing.files, { type: 'text', text: outgoing.text }],
    ...(metadata === undefined ? {} : { metadata })
  }
}

/** 把一条用户消息的文本 part 换成别的（长度 / 头尾都不动，只有中段不同） */
function withText(message: UIMessage, text: string): UIMessage {
  return { ...message, parts: [{ type: 'text', text }] }
}

function textOf(message: UIMessage): string {
  const part = message.parts.find((item) => item.type === 'text')
  return part?.type === 'text' ? part.text : ''
}

beforeEach(() => {
  // 模块级的"已通过"缓存不随 render 重置：用例之间必须清（否则第二条会少掉 pending 那一段）
  forgetVerifiedSeals()
})

afterEach(() => {
  cleanup()
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('006 · 用户气泡：验过才藏，图标项排在下方', () => {
  it('pending 先按原文；摘要复核通过后才藏掉追加段、下方出现图标项', async () => {
    const message = await sentUserMessage('看这个文件', [attachment('第一行\n第二行')])
    render(<MessageList messages={[message]} status="ready" />)

    // pending（复核还没回来）：一个字节都不藏 —— 不接受"先藏后验"
    const article = screen.getByTestId('message-u1')
    expect(article).toHaveTextContent('【附件】')
    expect(article).toHaveTextContent('第一行')
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()

    // 复核通过：藏掉追加段，下方一枚图标项写着文件名
    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    expect(screen.getByTestId('message-u1')).toHaveTextContent('看这个文件')
    expect(screen.getByTestId('message-u1')).not.toHaveTextContent('【附件】')
    expect(screen.getByTestId('message-u1')).not.toHaveTextContent('第一行')

    // 图标项在气泡**下方**：气泡与它在同一列里，且它排在气泡之后
    const item = screen.getByTestId('message-context-item')
    const bubble = screen.queryByTestId('message-bubble')
    expect(bubble).not.toBeNull()
    if (bubble === null) return
    expect(bubble.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('摘选：条目写文件名 + 行号，tooltip 给来源路径', async () => {
    const quote: PendingAttachment = {
      id: 'q1',
      name: 'notes.md',
      size: 6,
      text: '选中两行',
      quote: true,
      relative: 'docs/notes.md',
      lines: { start: 3, end: 4 }
    }
    const message = await sentUserMessage('', [quote])
    render(<MessageList messages={[message]} status="ready" />)

    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    const item = screen.getByTestId('message-context-item')
    expect(item).toHaveAttribute('data-kind', 'quote')
    expect(item).toHaveTextContent('notes.md')
    expect(item).toHaveTextContent('第 3–4 行')
    expect(item).toHaveAttribute('title', 'docs/notes.md（第 3–4 行）')
  })

  it('图片不重复：缩略图照旧（固定尺寸 + 点击放大），下方不再画一枚同样的图标项', async () => {
    const outgoing = composeOutgoing({
      text: '看看',
      attachments: [
        {
          id: 'i1',
          name: 'shot.png',
          size: 3,
          image: { url: 'data:image/png;base64,AAA', mediaType: 'image/png' }
        },
        attachment('PDF 抽出来的正文'.repeat(4), 'doc.pdf')
      ]
    })
    const metadata = await buildUserMessageMetadata({
      at: SENT_AT,
      text: outgoing.text,
      context: outgoing.context
    })
    render(
      <MessageList
        messages={[
          {
            id: 'u1',
            role: 'user',
            parts: [...outgoing.files, { type: 'text', text: outgoing.text }],
            metadata
          }
        ]}
        status="ready"
      />
    )

    const image = screen.getByTestId('message-image')
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAA')
    expect(image).toHaveClass('size-full', 'object-contain')
    expect(screen.getByTestId('message-image-open')).toHaveClass('size-24')
    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    const items = screen.getAllByTestId('message-context-item')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('doc.pdf')
  })

  it('混合图片 / 文件 / 摘选：图片只占缩略图，文件与摘选统一排在下方图标项', async () => {
    const outgoing = composeOutgoing({
      text: '一起看看',
      attachments: [
        {
          id: 'i1',
          name: 'shot.png',
          size: 3,
          image: { url: 'data:image/png;base64,AAA', mediaType: 'image/png' }
        },
        attachment('PDF 抽出来的正文'.repeat(4), 'doc.pdf'),
        {
          id: 'q1',
          name: 'notes.md',
          size: 6,
          text: '选中两行',
          quote: true,
          relative: 'docs/notes.md',
          lines: { start: 3, end: 4 }
        }
      ]
    })
    const metadata = await buildUserMessageMetadata({
      at: SENT_AT,
      text: outgoing.text,
      context: outgoing.context
    })
    render(
      <MessageList
        messages={[
          {
            id: 'u1',
            role: 'user',
            // 再挂一个非图片 file part：和 006 的 metadata 图标项分开走（普通文件 pill）
            parts: [
              ...outgoing.files,
              {
                type: 'file',
                mediaType: 'application/pdf',
                url: 'data:application/pdf;base64,MANUAL',
                filename: 'manual.pdf'
              },
              { type: 'text', text: outgoing.text }
            ],
            metadata
          }
        ]}
        status="ready"
      />
    )

    // 图片：真实 file payload 的 data URL 原样显示，尺寸由缩略图外框固定
    const image = screen.getByTestId('message-image')
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAA')
    expect(screen.getByTestId('message-image-open')).toHaveClass('size-24')

    // 等 006 的 SHA-256 复核通过：追加段藏掉，文件 / 摘选落到下方统一图标项
    await waitFor(() => expect(screen.getAllByTestId('message-context-item')).toHaveLength(2))
    const items = screen.getAllByTestId('message-context-item')
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual(['file', 'quote'])
    expect(screen.getByTestId('message-file')).toHaveTextContent('manual.pdf')
    const context = screen.getByTestId('message-context')
    expect(context).toHaveTextContent('doc.pdf')
    expect(context).toHaveTextContent('notes.md')
    // 图片不在下方重复画成文件 pill / 图标项
    expect(context).not.toHaveTextContent('shot.png')
    expect(context.querySelector('[data-testid="message-image"]')).toBeNull()

    const article = screen.getByTestId('message-u1')
    expect(article).toHaveTextContent('一起看看')
    expect(article).not.toHaveTextContent('【附件】')
    expect(article).not.toHaveTextContent('【引用】')
    expect(article).not.toHaveTextContent('PDF 抽出来的正文')
    expect(article).not.toHaveTextContent('选中两行')
  })

  it('只有附件、用户没打字：pending 时原文还在（气泡在），复核通过后只留下方图标项', async () => {
    const message = await sentUserMessage('', [attachment('内容')])
    render(<MessageList messages={[message]} status="ready" />)

    expect(screen.getByTestId('message-u1')).toHaveTextContent('【附件】')
    expect(screen.queryByTestId('message-bubble')).not.toBeNull()

    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    expect(screen.getByTestId('message-u1')).not.toHaveTextContent('【附件】')
    expect(screen.queryByTestId('message-bubble')).toBeNull()
  })

  it('没有 metadata（用户自己手写【附件】）：原文照旧，不误吃、不画图标项', async () => {
    const handwritten = '我自己写的\n\n【附件】note.md\n```\n我自己打的\n```'
    render(
      <MessageList
        messages={[{ id: 'u1', role: 'user', parts: [{ type: 'text', text: handwritten }] }]}
        status="ready"
      />
    )

    expect(screen.getByTestId('message-u1')).toHaveTextContent('【附件】note.md')
    expect(screen.getByTestId('message-u1')).toHaveTextContent('我自己打的')
    // 等一拍也不该冒出图标项（没有 metadata = 没有可核验的东西）
    await act(async () => {})
    expect(screen.getByTestId('message-u1')).toHaveTextContent('我自己打的')
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()
  })

  it('同步一阶对不上（用户内容变了）：整条原文，且永远不会藏', async () => {
    const message = await sentUserMessage('看', [attachment('内容')])
    const tampered = withText(message, textOf(message).replace('看\n\n', '看'))
    render(<MessageList messages={[tampered]} status="ready" />)

    expect(screen.getByTestId('message-u1')).toHaveTextContent('【附件】')
    await waitFor(() => expect(screen.getByTestId('message-u1')).toHaveTextContent('内容'))
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()
  })

  it('中段被改（头尾与长度都对得上）：摘要复核拦住 —— 从头到尾按原文', async () => {
    const message = await sentUserMessage('看', [attachment(LONG_BODY)])
    const tampered = withText(message, textOf(message).replace('第 20 行内容', '第 贰拾 行内容'))
    render(<MessageList messages={[tampered]} status="ready" />)

    // 渲染的那一刻就是原文（不是"先藏一帧再恢复"）
    expect(screen.getByTestId('message-u1')).toHaveTextContent('【附件】')
    expect(screen.getByTestId('message-u1')).toHaveTextContent('第 贰拾 行内容')
    await waitFor(() => expect(screen.getByTestId('message-u1')).toHaveTextContent('第 40 行内容'))
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()
  })

  it('同一条消息被编辑（id 不变、正文变了）：旧的"已验证"结论不许跟过去', async () => {
    const message = await sentUserMessage('看', [attachment(LONG_BODY)])
    const { rerender } = render(<MessageList messages={[message]} status="ready" />)
    // 先让它复核通过（缓存里也记一份）
    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())

    const tampered = withText(message, textOf(message).replace('第 20 行内容', '第 贰拾 行内容'))
    rerender(<MessageList messages={[tampered]} status="ready" />)

    // 身份换了 → 立刻回到原文，而且新身份复核不过 → 不再藏
    expect(screen.getByTestId('message-u1')).toHaveTextContent('【附件】')
    expect(screen.getByTestId('message-u1')).toHaveTextContent('第 贰拾 行内容')
    await waitFor(() => expect(screen.getByTestId('message-u1')).toHaveTextContent('第 40 行内容'))
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()
  })

  it('旧异步晚返回：前一条的"复核通过"不许把换掉之后的正文藏起来', async () => {
    const message = await sentUserMessage('看', [attachment(LONG_BODY)])
    const tampered = withText(message, textOf(message).replace('第 20 行内容', '第 贰拾 行内容'))
    const { rerender } = render(<MessageList messages={[message]} status="ready" />)
    // 第一条的摘要还在飞：立刻换成对不上的那条
    rerender(<MessageList messages={[tampered]} status="ready" />)

    expect(screen.getByTestId('message-u1')).toHaveTextContent('第 贰拾 行内容')
    await waitFor(() => expect(screen.getByTestId('message-u1')).toHaveTextContent('第 40 行内容'))
    expect(screen.queryByTestId('message-context-item')).not.toBeInTheDocument()
  })

  it('历史回读：存储里的图片 + kyclawContext 仍画缩略图，验过才藏照旧', async () => {
    const outgoing = composeOutgoing({
      text: '历史提问',
      attachments: [
        {
          id: 'i1',
          name: 'history.png',
          size: 3,
          image: { url: 'data:image/png;base64,HIST', mediaType: 'image/png' }
        },
        attachment('历史附件正文'.repeat(6), 'history.md')
      ]
    })
    const metadata = await buildUserMessageMetadata({
      at: SENT_AT,
      text: outgoing.text,
      context: outgoing.context
    })
    const [message] = mapStoredMessages([
      {
        id: 'u-history',
        role: 'user',
        content: {
          format: 2,
          parts: [
            { type: 'file', mimeType: 'image/png', data: 'HIST' },
            { type: 'text', text: outgoing.text }
          ],
          metadata
        }
      }
    ] as unknown as StoredMessage[])
    render(<MessageList messages={[message]} status="ready" />)

    // 图片：历史映射还原 data URL，缩略图与点击放大都还能用
    const thumb = screen.getByTestId('message-image')
    expect(thumb).toHaveAttribute('src', 'data:image/png;base64,HIST')
    expect(thumb).toHaveClass('size-full', 'object-contain')
    fireEvent.click(screen.getByTestId('message-image-open'))
    const enlarged = screen.getByTestId('message-image-lightbox-img')
    expect(enlarged).toHaveAttribute('src', 'data:image/png;base64,HIST')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('message-image-lightbox')).not.toBeInTheDocument()
    )

    // 006 的 metadata 回读：复核通过后藏掉追加段，文件项仍在下方；图片不重复
    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    expect(screen.getByTestId('message-context-item')).toHaveTextContent('history.md')
    const article = screen.getByTestId('message-u-history')
    expect(article).toHaveTextContent('历史提问')
    expect(article).not.toHaveTextContent('【附件】')
    expect(article).not.toHaveTextContent('历史附件正文')
    expect(screen.getByTestId('message-context')).not.toHaveTextContent('history.png')
  })
})

describe('008 · 发送时间（返工：裸文字，无气泡）', () => {
  it('精确发送时刻（自有键）：裸文字显示本地时间、不带限定，且没有背景 / 边框 / tooltip 容器', async () => {
    const message = await sentUserMessage('看这个文件', [attachment('内容')])
    render(<MessageList messages={[message]} status="ready" />)

    // 时间一直在 DOM 里（靠 hover / focus 显形），不再是"打开 tooltip 才挂出来"
    const sentAt = screen.getByTestId('message-sent-at')
    expect(sentAt).toHaveTextContent(localLabel(SENT_AT))
    expect(sentAt.textContent).not.toContain('记录时间')
    // 裸文字：无背景、无边框、无圆角，也不是 tooltip 气泡里的一段
    expect(sentAt.className).not.toMatch(/\bbg-/)
    expect(sentAt.className).not.toMatch(/\bborder/)
    expect(sentAt.className).not.toMatch(/\brounded/)
    expect(sentAt.closest('[role="tooltip"]')).toBeNull()
    // 悬停 / 聚焦的显隐钩子仍挂在消息这一组上
    expect(sentAt.className).toContain('group-hover:opacity-100')
    expect(sentAt.className).toContain('group-focus-within:opacity-100')

    fireEvent.focus(screen.getByTestId('message-body'))
    expect(screen.getByTestId('message-sent-at')).toHaveTextContent(localLabel(SENT_AT))
  })

  it('只有记录时间（旧消息回读）：文案带一句限定，不冒充精确发送', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: '旧消息' }],
            metadata: { createdAt: SENT_AT }
          }
        ]}
        status="ready"
      />
    )

    fireEvent.focus(screen.getByTestId('message-body'))
    expect(screen.getByTestId('message-sent-at')).toHaveTextContent(
      `${localLabel(SENT_AT)}（记录时间）`
    )
  })

  it('没有可靠时间：不画时间、也不占 tab 位（不编造）', async () => {
    const message = await sentUserMessage('旧消息', [], { at: null })
    render(<MessageList messages={[message]} status="ready" />)

    fireEvent.focus(screen.getByTestId('message-body'))
    expect(screen.queryByTestId('message-sent-at')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-body')).not.toHaveAttribute('tabindex')
  })
})

const THREAD_ID = 'thread-context'

function settings(): ReturnType<typeof defaultSettings> {
  return {
    ...defaultSettings(),
    providers: [
      { id: 'p1', type: 'openai-compatible', model: 'm', isDefault: true, baseUrl: 'http://x/v1' }
    ]
  }
}

async function renderSession(control: MockTransport): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        runtime={{ transport: control.transport, loadHistory: async () => [], onTurnEnd: () => {} }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

/** 通过 ＋ 上传加一个 .md（测试桥没有 pathForFile → 走文本内联那条兜底路，正文进围栏） */
async function attachNote(): Promise<void> {
  const body = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行内容：abcdefghij`).join(
    '\n'
  )
  fireEvent.change(screen.getByTestId('composer-file-input'), {
    target: { files: [new File([body], 'note.md', { type: 'text/markdown' })] }
  })
  await screen.findByTestId('composer-attachment-note.md')
}

function lastUser(control: MockTransport, index: number): UIMessage | undefined {
  return control.requests[index].messages.filter((message) => message.role === 'user').at(-1)
}

function sentTextOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
}

describe('006 · 真发送路径（ChatSession + Composer + 假 transport）', () => {
  beforeEach(() => {
    resetThreadChats()
    installKyclawBridge(settings())
    useSettingsStore.setState({ settings: settings(), loaded: true })
  })

  it('正文一个字没变；metadata 带自有时间键与展示上下文；界面复核通过后按 metadata 隐藏', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await attachNote()
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '看这个文件' } })
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })

    await waitFor(() => expect(control.requests).toHaveLength(1))
    const sent = lastUser(control, 0)
    // 模型正文不变：与组装产物逐字一致（围栏 + 附件正文都在）
    expect(sentTextOf(sent)).toContain('【附件】note.md')
    expect(sentTextOf(sent)).toContain('第 30 行内容')
    expect(sentTextOf(sent)).toBe(
      composeOutgoing({
        text: '看这个文件',
        attachments: [
          attachment(
            Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行内容：abcdefghij`).join(
              '\n'
            )
          )
        ]
      }).text
    )

    const metadata = sent?.metadata as
      | {
          createdAt?: unknown
          kyclawSentAt?: unknown
          kyclawContext?: { v?: number; entries?: unknown[] }
        }
      | undefined
    // 自己写的时间键：两个槽同值，且都是可解析的 ISO 串
    expect(typeof metadata?.createdAt).toBe('string')
    expect(metadata?.kyclawSentAt).toBe(metadata?.createdAt)
    expect(Number.isNaN(Date.parse(String(metadata?.kyclawSentAt)))).toBe(false)
    expect(metadata?.kyclawContext?.v).toBe(1)
    expect(metadata?.kyclawContext?.entries).toHaveLength(1)
    // 不复制大段正文：摘录之外的中段一个字都不在 metadata 里
    expect(JSON.stringify(metadata)).not.toContain('第 15 行内容')
    expect(JSON.stringify(metadata).length).toBeLessThan(sentTextOf(sent).length)

    // 界面：复核通过后气泡只剩那句话，下方是文件名图标项
    await waitFor(() => expect(screen.getByTestId('message-context-item')).toBeInTheDocument())
    const article = screen.getByTestId(`message-${sent?.id ?? ''}`)
    expect(article).toHaveTextContent('看这个文件')
    expect(article).not.toHaveTextContent('【附件】')
  })

  it('排队补发同样带 metadata（metadata 随 OutgoingMessage 一起排队，不丢）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    // 第一条（流式中）→ 第二条进队列
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第一问' } })
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })
    await attachNote()
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第二问' } })
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await waitFor(() => expect(control.requests).toHaveLength(2))

    const queued = lastUser(control, 1)
    expect(sentTextOf(queued)).toContain('【附件】note.md')
    const metadata = queued?.metadata as
      | { createdAt?: unknown; kyclawSentAt?: unknown; kyclawContext?: { entries?: unknown[] } }
      | undefined
    expect(metadata?.kyclawContext?.entries).toHaveLength(1)
    expect(metadata?.kyclawSentAt).toBe(metadata?.createdAt)
  })

  it('编辑重发：只改自己的字 → 沿用原上下文，并带上新的发送时刻', { timeout: 40_000 }, async () => {
    const control = createMockTransport()
    await renderSession(control)

    await attachNote()
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '原问题' } })
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })
    await waitFor(() => expect(control.requests).toHaveLength(1))
    const first = lastUser(control, 0)
    expect(first).toBeDefined()
    // 一轮跑完（动作行只在空闲时出现）再编辑
    await act(async () => {
      control.push('答一')
      control.finish()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('message-edit'))
    })
    await act(async () => {
      const editor = screen.getByTestId('message-edit-input') as HTMLTextAreaElement
      fireEvent.change(editor, { target: { value: editor.value.replace('原问题', '改过的问题') } })
      fireEvent.click(screen.getByTestId('message-edit-save'))
    })

    await waitFor(() => expect(control.requests).toHaveLength(2))
    const resent = lastUser(control, 1)
    expect(sentTextOf(resent)).toContain('【附件】note.md')
    const metadata = resent?.metadata as
      | { createdAt?: unknown; kyclawSentAt?: unknown; kyclawContext?: { entries?: unknown[] } }
      | undefined
    expect(metadata?.kyclawContext?.entries).toHaveLength(1)
    expect(metadata?.kyclawSentAt).toBe(metadata?.createdAt)
  })
})
