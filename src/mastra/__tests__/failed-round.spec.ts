// @vitest-environment node
/**
 * PB-035 C：失败轮 parts 持久化 + 下一轮上下文过滤（`src/mastra/failed-round.ts`）。
 *
 * 四条验收（Lead 口径）：
 *   1. 按流 `start` 的 messageId **upsert** 进已存在的 assistant 行（不新插）；
 *   2. `metadata.status='failed'`；
 *   3. 下一轮上下文过滤 failed 轮（重试 marker 只留最后一条并换中性内容，保住 user 结尾）；
 *   4. 自身失败降级为现状（只留 error part），不抛、不挂轮次。
 */
import { describe, expect, it } from 'vitest'
import {
  createFailedRoundFilter,
  withFailedRoundCapture,
  type FailedRoundMemory
} from '../failed-round'

type Chunk = Record<string, unknown>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

function memoryWith(stored: Record<string, unknown> | null): {
  memory: FailedRoundMemory
  saved: Record<string, unknown>[]
} {
  const saved: Record<string, unknown>[] = []
  const memory: FailedRoundMemory = {
    recall: async () => ({ messages: stored === null ? [] : [stored] }),
    settled: async () => undefined,
    saveMessages: async ({ messages }) => {
      saved.push(...(messages as Record<string, unknown>[]))
    }
  }
  return { memory, saved }
}

async function drain(stream: ReadableStream<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

const storedErrorRow = {
  id: 'msg-1',
  role: 'assistant',
  threadId: 't1',
  resourceId: 'local-user',
  createdAt: '2026-10-19T00:00:00.000Z',
  content: {
    format: 2,
    parts: [{ type: 'error', error: { name: 'Error', message: '上游断开' }, createdAt: 1 }],
    metadata: {}
  }
}

describe('withFailedRoundCapture：失败轮 parts 补进已存在的 assistant 行', () => {
  it('文本 + 工具（含结果）→ upsert 合并；原 error part 保留；metadata.status=failed', async () => {
    const { memory, saved } = memoryWith(storedErrorRow)
    const chunks: Chunk[] = [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '第一部分' },
      { type: 'text-delta', id: 't1', delta: '正文。' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'read', input: { path: 'a.ts' } },
      { type: 'tool-output-available', toolCallId: 'call-1', output: { text: 'ok' } },
      { type: 'error', errorText: '上游断开' }
    ]
    const passed = await drain(
      withFailedRoundCapture(streamOf(chunks), { memory, threadId: 't1' })
    )
    expect(passed).toHaveLength(chunks.length) // 旁路不改变流
    await sleep(20)

    expect(saved).toHaveLength(1)
    const savedRow = saved[0] as {
      id: string
      content: { parts: Array<Record<string, unknown>>; metadata: Record<string, unknown> }
    }
    expect(savedRow.id).toBe('msg-1')
    const types = savedRow.content.parts.map((part) => part.type)
    expect(types).toContain('text')
    expect(types).toContain('tool-invocation')
    expect(types).toContain('error') // 原有 error part 不被覆盖
    expect(savedRow.content.metadata.status).toBe('failed')
    const textPart = savedRow.content.parts.find((part) => part.type === 'text')
    expect(textPart?.text).toBe('第一部分正文。')
    const tool = savedRow.content.parts.find((part) => part.type === 'tool-invocation') as {
      toolInvocation: { state: string; result: unknown; args: unknown }
    }
    expect(tool.toolInvocation).toMatchObject({ state: 'result', result: { text: 'ok' } })
  })

  it('正常结束（有 finish、无 error）→ 不写库、不改消息', async () => {
    const { memory, saved } = memoryWith(storedErrorRow)
    await drain(
      withFailedRoundCapture(
        streamOf([
          { type: 'start', messageId: 'msg-1' },
          { type: 'text-delta', id: 't1', delta: '完成' },
          { type: 'text-end', id: 't1' },
          { type: 'finish' }
        ]),
        { memory, threadId: 't1' }
      )
    )
    await sleep(20)
    expect(saved).toHaveLength(0)
  })

  it('流中断（没有 finish 也没有 error）→ 也算失败，补已有 parts', async () => {
    const { memory, saved } = memoryWith(storedErrorRow)
    await drain(
      withFailedRoundCapture(
        streamOf([
          { type: 'start', messageId: 'msg-1' },
          { type: 'text-delta', id: 't1', delta: '半截' }
        ]),
        { memory, threadId: 't1' }
      )
    )
    await sleep(20)
    expect(saved).toHaveLength(1)
    expect((saved[0] as { content: { parts: Array<Record<string, unknown>> } }).content.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: '半截' }),
        expect.objectContaining({ type: 'error' })
      ])
    )
  })

  it('降级：recall 抛错 → 不抛、onError 收到；没有 messageId 或没有 parts → 不写库', async () => {
    const errors: unknown[] = []
    const failing: FailedRoundMemory = {
      recall: async () => {
        throw new Error('库锁住了')
      },
      saveMessages: async () => undefined
    }
    await expect(
      drain(
        withFailedRoundCapture(
          streamOf([
            { type: 'start', messageId: 'msg-1' },
            { type: 'text-delta', id: 't1', delta: 'x' },
            { type: 'text-end', id: 't1' },
            { type: 'error', errorText: '断' }
          ]),
          { memory: failing, threadId: 't1', onError: (error) => errors.push(error) }
        )
      )
    ).resolves.toBeDefined()
    await sleep(60)
    expect(errors).toHaveLength(1)

    const { memory, saved } = memoryWith(storedErrorRow)
    await drain(
      withFailedRoundCapture(streamOf([{ type: 'error', errorText: '一开始就断' }]), {
        memory,
        threadId: 't1'
      })
    )
    await sleep(20)
    expect(saved).toHaveLength(0)
  })
})

describe('createFailedRoundFilter：下一轮上下文过滤', () => {
  const user = (id: string, text: string, metadata: Record<string, unknown> = {}): Chunk => ({
    id,
    role: 'user',
    content: { format: 2, parts: [{ type: 'text', text }], metadata }
  })
  const assistant = (id: string, text: string, metadata: Record<string, unknown> = {}): Chunk => ({
    id,
    role: 'assistant',
    content: { format: 2, parts: [{ type: 'text', text }], metadata }
  })

  it('去掉 failed 的 assistant；历史 marker 只留最后一条并换成「继续。」；结尾仍是 user', async () => {
    const messages = [
      user('u1', '开始'),
      assistant('a1', '做到一半', { status: 'failed' }),
      user('r1', '从中断处继续', { kyclawRetryKeep: true }),
      assistant('a2', '又断了', { status: 'failed' }),
      user('r2', '从中断处继续', { kyclawRetryKeep: true })
    ]
    const processor = createFailedRoundFilter()
    const result = (await processor.processInput!({
      messages,
      // 其余字段处理器不用
      messageList: {},
      systemMessages: [],
      state: {}
    } as never)) as Chunk[]

    expect(result.map((message) => message.id)).toEqual(['u1', 'r2'])
    expect(result.at(-1)?.role).toBe('user')
    const last = result.at(-1) as { content: { parts: Array<{ text: string }>; metadata: unknown } }
    expect(last.content.parts[0].text).toBe('继续。')
    expect(last.content.metadata).toEqual({ kyclawRetryKeep: true }) // 元数据保留（前端仍能识别）
  })

  it('没有 failed/marker 的普通历史原样返回', async () => {
    const messages = [user('u1', '你好'), assistant('a1', '在的')]
    const processor = createFailedRoundFilter()
    const result = (await processor.processInput!({
      messages,
      messageList: {},
      systemMessages: [],
      state: {}
    } as never)) as Chunk[]
    expect(result).toEqual(messages)
  })
})

