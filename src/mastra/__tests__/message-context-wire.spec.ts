// @vitest-environment node
/**
 * 006 / 008 的 **wire 级回归**（真 HTTP/SSE + 真 libsql 落库回读）：
 *
 * 这一条补的是单测之间那条缝：单测只钉"渲染端算对了"，这里钉**过了一遍真服务与真存储之后**——
 *   1. 发给模型的正文**一个字节没变**（假 provider 收到的请求体里就是 composeOutgoing 的产物）；
 *   2. 展示 metadata **随消息落进 libsql、又原样读回来**（`content.metadata.kyclawContext`）；
 *   3. 发送时刻走**自有键 `kyclawSentAt`**：带 image file part 的消息也原样落库、逐毫秒读回来
 *      （那条路正是 Mastra 的 v5 UI 消息适配会剔掉 `metadata.createdAt` 的地方，见 @shared/message-context）；
 *   4. metadata **不进模型请求体**（旁注不变成上下文开销）；
 *   5. 回读出来的那份还能被展示层用：`mapStoredMessages` → `resolveUserDisplay` 给出候选、
 *      正文只剩用户自己写的那句（隐藏仍要渲染端再算一遍摘要，见 message-context 的"验过才藏"）。
 *
 * 假端点（stub）：收下请求体原样记着，回一段固定 SSE —— 不碰真模型、不读任何密钥。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { FileUIPart, UIMessage } from 'ai'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody, type StoredMessage } from '@shared/threads'
import { mapStoredMessages } from '../../renderer/src/lib/message-map'
import { composeOutgoing } from '../../renderer/src/features/chat/composer-attachments'
import type { PendingAttachment } from '../../renderer/src/features/chat/composer-attachments'
import {
  MESSAGE_CONTEXT_KEY,
  SENT_AT_KEY,
  buildUserMessageMetadata,
  readSentAt,
  resolveUserDisplay
} from '../../renderer/src/features/chat/message-context'

/** 假端点收下的请求体（每次 POST /v1/chat/completions 追加一条） */
const requests: Array<Record<string, unknown>> = []

function sseBody(text: string): string {
  const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
  return (
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'context-probe',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    }) +
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'context-probe',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

const TEXT_BODY = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行：探针内容`).join(
  '\n'
)

const ATTACHMENTS: PendingAttachment[] = [
  { id: 'f1', name: 'note.md', size: TEXT_BODY.length, text: TEXT_BODY },
  {
    id: 'f2',
    name: 'tool.exe',
    size: 123,
    path: 'bin/tool.exe',
    absolute: 'D:\\ws\\bin\\tool.exe'
  }
]

/** 1x1 红点 PNG（真字节，不是占位串） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

let dir: string
let server: AgentServerHandle
let stub: Server

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-context-wire-'))

  stub = createServer((request, response) => {
    if (request.method !== 'POST' || !(request.url ?? '').startsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"not found"}}')
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        requests.push({ raw: body })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseBody('收到。'))
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address()
  if (address === null || typeof address === 'string') throw new Error('假端点监听失败')

  const model = createOpenAICompatible({
    name: 'kyclaw-openai-compatible',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'stub-key'
  }).chatModel('context-probe')

  server = await startAgentServer({ dataDir: dir, model, workspaces: () => [], projects: () => [] })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => stub?.close(() => resolve()))
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

/** 等这一轮收尾（与 vision-wire 同一条轮询） */
async function settled(chat: Chat<UIMessage>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 30_000
    const tick = (): void => {
      if (chat.status === 'ready') return resolve()
      if (chat.status === 'error') return reject(chat.error ?? new Error('chat error'))
      if (Date.now() > deadline) return reject(new Error('等待收尾超时'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function readStored(threadId: string): Promise<StoredMessage[]> {
  const response = await fetch(
    `${server.baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`,
    { headers: { authorization: `Bearer ${server.token}` } }
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { messages: StoredMessage[] }
  return payload.messages
}

/** 发一条用户消息（可带 image file part）并把它从 libsql 里读回来 */
async function converse(input: {
  threadId: string
  text: string
  metadata: unknown
  files?: FileUIPart[]
}): Promise<StoredMessage[]> {
  const chat = new Chat({
    transport: new DefaultChatTransport({
      api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
      headers: { Authorization: `Bearer ${server.token}` }
    })
  })
  await chat.sendMessage(
    {
      text: input.text,
      metadata: input.metadata,
      ...(input.files === undefined ? {} : { files: input.files })
    },
    { body: threadMemoryBody(input.threadId) }
  )
  await settled(chat)
  return readStored(input.threadId)
}

function storedUserOf(stored: readonly StoredMessage[]): StoredMessage {
  const found = stored.find((message) => message.role === 'user')
  expect(found).toBeDefined()
  if (found === undefined) throw new Error('没有用户消息')
  return found
}

describe('006 / 008 wire：展示 metadata 过真服务与 libsql 一圈', () => {
  it('正文进 provider 一字未改；metadata 落库回读一致、不进模型请求；时间走自有键', async () => {
    requests.length = 0
    const outgoing = composeOutgoing({ text: '看这两个', attachments: ATTACHMENTS })
    const at = Date.now()
    const metadata = await buildUserMessageMetadata({
      at,
      text: outgoing.text,
      context: outgoing.context
    })
    expect(metadata.kyclawContext?.entries).toHaveLength(2)

    const threadId = 'thread-context-wire'
    const stored = await converse({ threadId, text: outgoing.text, metadata })

    // ── 1. provider 请求体：正文原样、metadata 不在里面 ────────────────────────────────
    expect(requests.length).toBeGreaterThan(0)
    const providerBody = JSON.stringify(requests)
    expect(providerBody).toContain('看这两个')
    expect(providerBody).toContain('【附件】note.md')
    expect(providerBody).toContain('第 30 行：探针内容')
    expect(providerBody).toContain('【附件】bin/tool.exe')
    expect(providerBody).not.toContain(MESSAGE_CONTEXT_KEY)
    expect(providerBody).not.toContain(SENT_AT_KEY)
    expect(providerBody).not.toContain(
      metadata.kyclawContext?.entries[0].append?.sha256 ?? 'x'.repeat(64)
    )

    // ── 2. libsql 回读：正文逐字相同、metadata 原样、自有时间键在 ───────────────────────
    const userStored = storedUserOf(stored)
    const content = userStored.content as {
      parts: Array<{ type: string; text?: string }>
      metadata?: Record<string, unknown>
    }
    const storedText = content.parts
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('\n\n')
    expect(storedText).toBe(outgoing.text)
    expect(content.metadata?.[MESSAGE_CONTEXT_KEY]).toEqual(metadata.kyclawContext)
    // 自有时间键：**必须原样在**（精确发送时刻就靠它；惯例槽 createdAt 可能被适配器剔掉，断言放宽）
    expect(content.metadata?.[SENT_AT_KEY]).toBe(metadata.kyclawSentAt)
    const conventionSlot = content.metadata?.createdAt
    expect(conventionSlot === undefined || conventionSlot === metadata.createdAt).toBe(true)
    const storedTop = (userStored as { createdAt?: unknown }).createdAt
    expect(typeof storedTop === 'string' || storedTop instanceof Date).toBe(true)

    // ── 3. 回读 → 展示：候选隐藏追加段，只剩用户那句话 + 两条上下文条目 ──────────────────
    const [mappedUser] = mapStoredMessages(stored)
    expect(mappedUser.role).toBe('user')
    // 数字锚点 = 我们写的那一份（不是服务端落库时刻）；精确时刻原值透传
    expect((mappedUser.metadata as { createdAt?: unknown }).createdAt).toBe(
      Date.parse(metadata.kyclawSentAt)
    )
    expect((mappedUser.metadata as Record<string, unknown>)[SENT_AT_KEY]).toBe(
      metadata.kyclawSentAt
    )
    expect(readSentAt(mappedUser.metadata)).toEqual({
      at: Date.parse(metadata.kyclawSentAt),
      exact: true
    })

    const text = mappedUser.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n\n')
    const display = resolveUserDisplay({ text, metadata: mappedUser.metadata })
    expect(display.hidden).toBe(true)
    expect(display.text).toBe('看这两个')
    expect(display.entries.map((entry) => entry.name)).toEqual(['note.md', 'tool.exe'])

    // 助手那条也在（这一轮真跑完了，不是半截）
    expect(stored.some((message) => message.role === 'assistant')).toBe(true)
  }, 90_000)

  it('纯文本消息：自有时间键照样落库、回读不丢', async () => {
    requests.length = 0
    const at = Date.now()
    const metadata = await buildUserMessageMetadata({ at, text: '只有字' })
    expect(metadata.kyclawContext).toBeUndefined()

    const threadId = 'thread-context-wire-plain'
    const stored = await converse({ threadId, text: '只有字', metadata })
    const userStored = storedUserOf(stored)
    const content = userStored.content as { metadata?: Record<string, unknown> }
    expect(content.metadata?.[MESSAGE_CONTEXT_KEY]).toBeUndefined()
    expect(content.metadata?.[SENT_AT_KEY]).toBe(metadata.kyclawSentAt)

    const [mapped] = mapStoredMessages(stored)
    expect((mapped.metadata as { createdAt?: unknown } | undefined)?.createdAt).toBe(
      Date.parse(metadata.kyclawSentAt)
    )
    expect(readSentAt(mapped.metadata)).toEqual({ at, exact: true })
  }, 90_000)

  it('带 image file part 的消息：时间不丢、真到 provider、metadata 不泄漏', async () => {
    requests.length = 0
    const outgoing = composeOutgoing({
      text: '看图',
      attachments: [
        {
          id: 'i1',
          name: 'shot.png',
          size: PNG_BASE64.length,
          image: { url: PNG_DATA_URL, mediaType: 'image/png' }
        },
        { id: 'f1', name: 'note.md', size: TEXT_BODY.length, text: TEXT_BODY }
      ]
    })
    const files = outgoing.files as FileUIPart[]
    expect(files).toHaveLength(1)
    const at = Date.now()
    const metadata = await buildUserMessageMetadata({
      at,
      text: outgoing.text,
      context: outgoing.context
    })
    // 图片条目（无 append）+ 文件条目（有 append）
    expect(metadata.kyclawContext?.entries.map((entry) => entry.kind)).toEqual(['image', 'file'])

    const threadId = 'thread-context-wire-image'
    const stored = await converse({ threadId, text: outgoing.text, metadata, files })

    // ── 1. provider：图片以 image_url 真到端点；正文原样；旁注一个键都不在 ────────────────
    expect(requests.length).toBeGreaterThan(0)
    const providerBody = JSON.stringify(requests)
    expect(providerBody).toContain('image_url')
    expect(providerBody).toContain(PNG_BASE64)
    expect(providerBody).toContain('看图')
    expect(providerBody).toContain('【附件】note.md')
    expect(providerBody).not.toContain(SENT_AT_KEY)
    expect(providerBody).not.toContain(MESSAGE_CONTEXT_KEY)
    expect(providerBody).not.toContain(
      metadata.kyclawContext?.entries[1].append?.sha256 ?? 'x'.repeat(64)
    )

    // ── 2. libsql：file part 在、**时代不丢**（v5 适配会剔 createdAt，自有键不受影响）───────
    const userStored = storedUserOf(stored)
    const content = userStored.content as {
      parts: Array<Record<string, unknown>>
      metadata?: Record<string, unknown>
    }
    expect(JSON.stringify(content.parts)).toContain('image/png')
    // 实测（138 复核的关键证据，2026-10-16）：这条路上存储的 content.metadata 只有
    // ['kyclawSentAt', 'kyclawContext'] —— 惯例槽 createdAt 被 Mastra 的 v5 适配剔掉了。
    // 所以这里只硬断言**自有键**在（惯例槽那条断言在上面两条测试里是"要么没有、要么同值"的宽松口径）。
    expect(content.metadata?.[SENT_AT_KEY]).toBe(metadata.kyclawSentAt)
    expect(content.metadata?.[MESSAGE_CONTEXT_KEY]).toEqual(metadata.kyclawContext)

    // ── 3. 回读 → 展示：时间仍是"精确发送时刻"；候选隐藏的只有文件那一段 ──────────────────
    const [mappedUser] = mapStoredMessages(stored)
    expect(readSentAt(mappedUser.metadata)).toEqual({ at, exact: true })
    const text = mappedUser.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n\n')
    const display = resolveUserDisplay({ text, metadata: mappedUser.metadata })
    expect(display.hidden).toBe(true)
    expect(display.text).toBe('看图')
    // display.entries 只装**被藏掉的**（= 真追加进正文的）那些条目：图片不在正文里，
    // 它是气泡上方的缩略图（渲染层也不在下方重复画，见 message-context-display.spec.tsx）
    expect(display.entries.map((entry) => entry.kind)).toEqual(['file'])
    expect(display.entries.map((entry) => entry.name)).toEqual(['note.md'])
    // 隐藏的只有文件那一段（图片本来就不在正文里）
    expect(display.review).toHaveLength(1)
  }, 90_000)
})
