// @vitest-environment node
/**
 * round 19 上下文压缩：三层。
 *
 *   1. 压缩服务（假 memory + 假模型）：保留最近 N 条 / 旧消息被裁 / 素材只含旧段 /
 *      记录落库 / 摘要为空与模型失败不炸（也不删消息）/ keep 夹取 / 摘要调用记 usage；
 *      round 58：保留窗口自适应（4 条也能压、只剩 ≤2 条才无操作）+ 重压携带旧摘要；
 *   2. 注入处理器：有记录 → 加一条系统前缀（含摘要）；无记录 / 无会话 → 什么都不加；
 *   3. 真服务集成（startAgentServer：chat 路由 v7 + libsql + Memory + mock 模型）：
 *      多轮对话 → POST /compact → 旧消息从存储消失、记录可读、**下一轮请求的 prompt 带摘要**
 *      （mock 捕获 prompt 断言，不是只看回包）、压缩后继续对话 / 截断（编辑重发半边）正常。
 *
 * 口径细节见 src/mastra/compaction.ts 头注（保留窗口、重压携带、先落记录后删消息、注入时序）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { LibSQLStore } from '@mastra/libsql'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import {
  compactThreadResponseSchema,
  LOCAL_USER_RESOURCE_ID,
  threadCompactionResponseSchema,
  threadMemoryBody,
  type ThreadCompaction
} from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import {
  COMPACTION_PREFIX_TAG,
  COMPACTION_TABLE,
  COMPACTION_PROCESSOR_ID,
  COMPACT_PREVIOUS_SUMMARY_TAG,
  compactionPrefix,
  compactionSqlClient,
  createCompactionProcessor,
  createCompactionService,
  createCompactionStore,
  DEFAULT_KEEP_MESSAGES,
  estimateTokens,
  KEEP_MIN,
  transcriptLine,
  type CompactionStore,
  type CompactionMemory
} from '../compaction'
import { createThreadsRouter } from '../routes/threads'
import { pricingFor, type UsageRun, type UsageStore } from '../usage'

const CHAT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
/** 摘要调用的 usage：与 chat 的区分开，好断言"这行是摘要花的" */
const SUMMARY_USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 111, text: 111, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }

/** 存储消息的最小形状（v2 parts；服务只读 role/content） */
function storedMessage(
  id: string,
  role: string,
  text: string
): {
  id: string
  role: string
  content: { parts: { type: string; text: string }[] }
} {
  return { id, role, content: { parts: [{ type: 'text', text }] } }
}

function fakeMemory(messages: ReadonlyArray<{ id: string }>): {
  memory: CompactionMemory
  recall: ReturnType<typeof vi.fn>
  deleteMessages: ReturnType<typeof vi.fn>
} {
  const recall = vi.fn(async () => ({ messages }))
  const deleteMessages = vi.fn(async () => undefined)
  return {
    memory: { recall, deleteMessages } as unknown as CompactionMemory,
    recall,
    deleteMessages
  }
}

/** 内存版 store（服务单测用；真实现走 libsql 那条在下面的路由用例里） */
function memoryStore(seed: ThreadCompaction[] = []): CompactionStore & {
  records: Map<string, ThreadCompaction>
} {
  const records = new Map(seed.map((record) => [record.threadId, record]))
  return {
    records,
    ensureTable: () => Promise.resolve(),
    async save(record) {
      records.set(record.threadId, record)
    },
    async get(threadId) {
      return records.get(threadId) ?? null
    },
    async clear(threadId) {
      records.delete(threadId)
    }
  }
}

function fakeUsageStore(): UsageStore & { runs: UsageRun[] } {
  const runs: UsageRun[] = []
  return {
    runs,
    ensureTable: () => Promise.resolve(),
    async insert(run) {
      runs.push(run)
    },
    async listSince() {
      return runs
    },
    async listByThread(threadId) {
      return runs.filter((run) => run.threadId === threadId)
    }
  }
}

describe('压缩服务（假 memory + 假模型）', () => {
  const model = { modelId: 'deepseek-flash', provider: 'deepseek' } as never
  const resolveModel = async (): Promise<never> => model

  it('保留最近 N 条：只把更早的部分交模型摘要，素材不含保留段；旧消息从存储删除；记录落库', async () => {
    const messages = [
      storedMessage('m1', 'user', '第一轮的问题'),
      storedMessage('m2', 'assistant', '第一轮的回答'),
      storedMessage('m3', 'user', '第二轮的问题'),
      storedMessage('m4', 'assistant', '第二轮的回答'),
      storedMessage('m5', 'user', '第三轮的问题'),
      storedMessage('m6', 'assistant', '第三轮的回答')
    ]
    const { memory, deleteMessages } = fakeMemory(messages)
    const store = memoryStore()
    const generate = vi.fn(async (model: unknown, options: { prompt: string }) => ({
      // 摘要里带上模型 id 与素材长度：断言顺带确认两者都真到了生成函数
      text: `## 要点\n- 前三轮聊过的东西（${String((model as { modelId?: unknown }).modelId)}，素材 ${options.prompt.length} 字）`
    }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-a', 2)

    expect(outcome.compacted).toBe(true)
    expect(outcome.compaction).toMatchObject({ threadId: 'thread-a', summarized: 4, kept: 2 })
    // 素材 = 旧的四条；保留段（m5/m6）不在素材里
    const prompt = generate.mock.calls[0]?.[1]?.prompt ?? ''
    expect(prompt).toContain('第一轮的问题')
    expect(prompt).toContain('第二轮的回答')
    expect(prompt).not.toContain('第三轮的问题')
    expect(prompt).not.toContain('第三轮的回答')
    // 旧消息被裁：删除的正是 m1–m4
    expect(deleteMessages).toHaveBeenCalledTimes(1)
    expect(deleteMessages.mock.calls[0]?.[0]).toEqual(['m1', 'm2', 'm3', 'm4'])
    // 记录落库（覆盖式：同一会话只留最新一条）
    expect(await store.get('thread-a')).toEqual(outcome.compaction)
  })

  it('keep 缺省 = 最近 10 条；超范围会被夹到 2–40', async () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      storedMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `第 ${index + 1} 条`)
    )
    const { memory, deleteMessages } = fakeMemory(messages)
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      generate: async () => ({ text: '摘要' })
    })

    // round 58：长会话（条数 > requested）窗口与旧口径完全一致——策略没变
    const byDefault = await service.compact('thread-b')
    expect(byDefault.compaction).toMatchObject({ summarized: 2, kept: DEFAULT_KEEP_MESSAGES })

    const clamped = await service.compact('thread-b', 1)
    expect(clamped.compaction).toMatchObject({ summarized: 12 - KEEP_MIN, kept: KEEP_MIN })
    expect(deleteMessages).toHaveBeenCalledTimes(2)
  })

  it('只剩 ≤2 条：无可压缩，不调模型、不删消息，回现有记录（round 58 的自适应下界）', async () => {
    const existing: ThreadCompaction = {
      threadId: 'thread-c',
      summary: '上一次的摘要',
      summarized: 5,
      kept: 2,
      level: 'summary',
      createdAt: new Date(2026, 9, 10, 12, 0, 0).toISOString(),
      // round 59：老记录（round 58 之前压的）没有 token 读数——两个字段就是 null
      tokensBefore: null,
      tokensAfter: null
    }
    const { memory, deleteMessages } = fakeMemory([
      storedMessage('m1', 'user', 'a'),
      storedMessage('m2', 'assistant', 'b')
    ])
    const generate = vi.fn()
    const service = createCompactionService({
      memory,
      store: memoryStore([existing]),
      resolveModel,
      generate
    })

    // 保留窗口收窄到 max(2, 2-2)=2 = 条数，所以没得压（4 条起就压得动，见下一条）
    const outcome = await service.compact('thread-c', 4)
    expect(outcome).toEqual({ compacted: false, compaction: existing })
    expect(generate).not.toHaveBeenCalled()
    expect(deleteMessages).not.toHaveBeenCalled()
  })

  it('round 58 自适应：4 条（2 轮、条数少但体量大）也能压——保留 2、压 2、旧消息被删', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ]
    const { memory, deleteMessages } = fakeMemory(messages)
    const store = memoryStore()
    // 摘要里带上模型 id：顺带确认模型真到了生成函数（与上面第一条用例同风格）
    const generate = vi.fn(async (model: unknown, options: { prompt: string }) => ({
      text: `摘要正文（${String((model as { modelId?: unknown }).modelId)}，素材 ${options.prompt.length} 字）`
    }))
    // keep 都不传：用户"单独命令一按"就是这条路（缺省 10 > 4，窗口自适应到 2）
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-adaptive4')

    expect(outcome.compacted).toBe(true)
    expect(outcome.compaction).toMatchObject({ summarized: 2, kept: 2 })
    // 素材 = 最旧两条；保留段（m3/m4）不在里面
    const prompt = generate.mock.calls[0]?.[1]?.prompt ?? ''
    expect(prompt).toContain('旧问题')
    expect(prompt).not.toContain('新问题')
    expect(deleteMessages).toHaveBeenCalledTimes(1)
    expect(deleteMessages.mock.calls[0]?.[0]).toEqual(['m1', 'm2'])
    expect(await store.get('thread-adaptive4')).toEqual(outcome.compaction)
  })

  it('round 58 自适应：3 条 → 压 1、留最后 2 条兜底', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题')
    ]
    const { memory, deleteMessages } = fakeMemory(messages)
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      generate: async () => ({ text: '摘要正文' })
    })

    const outcome = await service.compact('thread-adaptive3')

    expect(outcome.compacted).toBe(true)
    expect(outcome.compaction).toMatchObject({ summarized: 1, kept: 2 })
    expect(deleteMessages).toHaveBeenCalledWith(['m1'])
  })

  it('round 58 重压携带旧摘要：旧摘要拼在素材最前面（折叠进新摘要）；计数只数本轮消息', async () => {
    const previous: ThreadCompaction = {
      threadId: 'thread-carry',
      summary: '## 要点\n- 上一轮定下用 libsql 存摘要',
      summarized: 4,
      kept: 2,
      level: 'summary',
      createdAt: new Date(2026, 9, 10, 12, 0, 0).toISOString(),
      tokensBefore: 41_000,
      tokensAfter: 6_500
    }
    const { memory, deleteMessages } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ])
    const store = memoryStore([previous])
    const generate = vi.fn(async (model: unknown, options: { prompt: string }) => ({
      text: `合并后的摘要（${String((model as { modelId?: unknown }).modelId)}，素材 ${options.prompt.length} 字）`
    }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-carry')

    expect(outcome.compacted).toBe(true)
    // 计数只数本轮真实消息（旧摘要不算一条消息）
    expect(outcome.compaction).toMatchObject({ summarized: 2, kept: 2 })
    const prompt = generate.mock.calls[0]?.[1]?.prompt ?? ''
    expect(prompt.startsWith(COMPACT_PREVIOUS_SUMMARY_TAG)).toBe(true)
    expect(prompt).toContain('上一轮定下用 libsql 存摘要')
    expect(prompt).toContain('旧问题')
    expect(deleteMessages.mock.calls[0]?.[0]).toEqual(['m1', 'm2'])
  })

  it('模型失败：错误照抛、不删消息、记录不变（先落记录后删消息的反向保护）', async () => {
    const { memory, deleteMessages } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ])
    const store = memoryStore()
    const service = createCompactionService({
      memory,
      store,
      resolveModel,
      generate: async () => {
        throw new Error('network down')
      }
    })

    await expect(service.compact('thread-d', 2)).rejects.toThrow('network down')
    expect(deleteMessages).not.toHaveBeenCalled()
    expect(await store.get('thread-d')).toBeNull()
  })

  it('摘要为空：按失败处理（不落记录、不删消息）', async () => {
    const { memory, deleteMessages } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ])
    const store = memoryStore()
    const service = createCompactionService({
      memory,
      store,
      resolveModel,
      generate: async () => ({ text: '   \n  ' })
    })

    await expect(service.compact('thread-e', 2)).rejects.toThrow('没有返回摘要内容')
    expect(deleteMessages).not.toHaveBeenCalled()
    expect(await store.get('thread-e')).toBeNull()
  })

  it('素材不可摘要（旧段没有任何文本）：给一行人话，不动消息', async () => {
    const { memory, deleteMessages } = fakeMemory([
      { id: 'm1' } as { id: string },
      storedMessage('m2', 'user', '新问题'),
      storedMessage('m3', 'assistant', '新回答')
    ])
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      generate: async () => ({ text: '不该被调到' })
    })

    await expect(service.compact('thread-f', 2)).rejects.toThrow('没有可摘要的文本内容')
    expect(deleteMessages).not.toHaveBeenCalled()
  })

  /**
   * round 62（P0）：`compact()` 是"读快照 → 调模型 → 落记录 → 按快照删消息"一长串，中途没有互斥。
   * 两次并发（双击手动入口 / 自动预压与手动撞上）会各自按同一份旧快照跑：两次 save 覆盖同一行、
   * 两次 deleteMessages 删同一批 id —— 白跑一轮，前一次的摘要还可能被挤掉。这里钉住 single-flight：
   * 同会话并发合并到同一个 Promise。
   */
  it('同会话并发压缩：single-flight 合并成一轮 —— recall / 摘要 / 删除各只跑一次，两次拿到同一结果', async () => {
    const { memory, recall, deleteMessages } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '旧问题二'),
      storedMessage('m4', 'assistant', '旧回答二'),
      storedMessage('m5', 'user', '新问题'),
      storedMessage('m6', 'assistant', '新回答')
    ])
    const store = memoryStore()
    const generate = vi.fn(async () => ({ text: '合并后的摘要' }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const [first, second] = await Promise.all([
      service.compact('thread-flight', 2),
      service.compact('thread-flight', 2)
    ])

    expect(recall).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(deleteMessages).toHaveBeenCalledTimes(1)
    expect(deleteMessages.mock.calls[0]?.[0]).toEqual(['m1', 'm2', 'm3', 'm4'])
    // 两次调用拿到的是同一份结果（同一个 Promise）
    expect(second).toBe(first)
    expect(await store.get('thread-flight')).toEqual(first.compaction)
  })

  it('single-flight 跑完就清账（下一次照常重跑）；跨会话互不影响', async () => {
    const { memory, recall } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '旧问题二'),
      storedMessage('m4', 'assistant', '旧回答二'),
      storedMessage('m5', 'user', '新问题')
    ])
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      generate: async () => ({ text: '摘要正文' })
    })

    await service.compact('thread-a', 2)
    await service.compact('thread-a', 2)
    // 不是永久缓存：上一轮跑完（finally 清账）后，下一次调用真的重跑
    expect(recall).toHaveBeenCalledTimes(2)

    await Promise.all([service.compact('thread-x', 2), service.compact('thread-y', 2)])
    // 跨会话各跑各的（不串行、也不合并）
    expect(recall).toHaveBeenCalledTimes(4)
  })

  it('摘要调用记 usage（threadId 照记、按价目算钱）——并入 round 18 口径', async () => {
    const { memory } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ])
    const usage = fakeUsageStore()
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      usage,
      generate: async () => ({
        text: '摘要正文',
        usage: { inputTokens: 11, outputTokens: 111, totalTokens: 122, cachedInputTokens: 3 }
      })
    })

    await service.compact('thread-g', 2)
    expect(usage.runs).toHaveLength(1)
    const run = usage.runs[0]
    expect(run).toMatchObject({
      threadId: 'thread-g',
      model: 'deepseek-flash',
      provider: 'deepseek',
      tokens: { input: 11, output: 111, total: 122 },
      cachedInput: 3
    })
    expect(run.cost).not.toBeNull()
    expect(pricingFor('deepseek-flash')).not.toBeNull()
  })

  it('round 59：记录带压缩前后 token——before = 最近一轮实测输入，after = 基线 + 摘要与保留段的字符折算', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ]
    const { memory } = fakeMemory(messages)
    const store = memoryStore()
    const summary = '## 要点\n- 前两轮聊过天气'
    const asked: string[] = []
    const service = createCompactionService({
      memory,
      store,
      resolveModel,
      usageOf: async (threadId) => {
        asked.push(threadId)
        return { lastInput: 527_000, baselineInput: 12_000 }
      },
      generate: async () => ({ text: summary })
    })

    const outcome = await service.compact('thread-token')

    expect(outcome.compacted).toBe(true)
    expect(asked).toEqual(['thread-token'])
    // 期望值在断言里按同一口径重算一遍：保留段（m3/m4）用素材同一套抽取口径逐条取字符数
    const keptChars = messages
      .slice(2)
      .map((message) => transcriptLine(message) ?? '')
      .join('\n\n').length
    expect(outcome.compaction).toMatchObject({
      summarized: 2,
      kept: 2,
      tokensBefore: 527_000,
      tokensAfter: 12_000 + estimateTokens(summary.length + keptChars)
    })
  })

  it('round 59：读数在摘要用量落库**之前**取（否则会把摘要那一轮当成"最近一轮"）', async () => {
    const { memory } = fakeMemory([
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ])
    const usage = fakeUsageStore()
    const order: string[] = []
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      usage: {
        ...usage,
        insert: async (run) => {
          order.push('usage.insert')
          await usage.insert(run)
        }
      },
      usageOf: async () => {
        order.push('usageOf')
        return { lastInput: 100, baselineInput: 10 }
      },
      generate: async () => ({
        text: '摘要正文',
        usage: { inputTokens: 11, outputTokens: 111 }
      })
    })

    await service.compact('thread-order', 2)
    expect(order).toEqual(['usageOf', 'usage.insert'])
  })

  it('round 59：读数拿不到（未注入 / 回 null / 抛错）→ 两个字段都落 null，压缩照常', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ]
    const compactWith = async (
      usageOf?: (threadId: string) => Promise<{
        lastInput: number | null
        baselineInput: number | null
      } | null>
    ): Promise<ThreadCompaction | null> => {
      const { memory } = fakeMemory(messages)
      const service = createCompactionService({
        memory,
        store: memoryStore(),
        resolveModel,
        generate: async () => ({ text: '摘要正文' }),
        ...(usageOf === undefined ? {} : { usageOf })
      })
      return (await service.compact('thread-null', 2)).compaction
    }

    // 没注入读数（测试里的窄构造、未来的别的调用方）
    expect(await compactWith()).toMatchObject({ tokensBefore: null, tokensAfter: null })
    // 读数是 null（例如这张会话在 usage_runs 里一行都没有）
    expect(await compactWith(async () => null)).toMatchObject({
      tokensBefore: null,
      tokensAfter: null
    })
    // 读数抛错：只留空这两个字段，不让压缩跟着挂（告警静音掉，免得刷测试输出）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const thrown = await compactWith(async () => {
      throw new Error('查库炸了')
    })
    warn.mockRestore()
    expect(thrown).toMatchObject({
      summary: '摘要正文',
      tokensBefore: null,
      tokensAfter: null
    })
  })

  it('round 59：lastInput 拿不到而基线有值 → before null、after 照算', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ]
    const { memory } = fakeMemory(messages)
    const summary = '## 要点\n- 旧的'
    const service = createCompactionService({
      memory,
      store: memoryStore(),
      resolveModel,
      usageOf: async () => ({ lastInput: null, baselineInput: 9_000 }),
      generate: async () => ({ text: summary })
    })

    const outcome = await service.compact('thread-half', 2)

    const keptChars = messages
      .slice(2)
      .map((message) => transcriptLine(message) ?? '')
      .join('\n\n').length
    expect(outcome.compaction).toMatchObject({
      tokensBefore: null,
      tokensAfter: 9_000 + estimateTokens(summary.length + keptChars)
    })
  })
})

describe('摘要素材渲染（transcriptLine / buildTranscript）', () => {
  it('工具调用与结果进素材；思考过程不进', () => {
    const line = transcriptLine({
      role: 'assistant',
      content: {
        parts: [
          { type: 'reasoning', reasoning: '内心戏' },
          { type: 'text', text: '我来看下文件' },
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'read',
              toolCallId: 'c1',
              args: { path: 'src/a.ts' },
              state: 'result',
              result: 'export const a = 1'
            }
          }
        ]
      }
    })
    expect(line).toContain('我来看下文件')
    expect(line).toContain('工具调用 read')
    expect(line).toContain('src/a.ts')
    expect(line).toContain('export const a = 1')
    expect(line).not.toContain('内心戏')
  })
})

describe('注入处理器（输入处理器）', () => {
  const record: ThreadCompaction = {
    threadId: 'thread-h',
    summary: '## 要点\n- 之前聊过缓存',
    summarized: 4,
    kept: 10,
    level: 'summary',
    createdAt: new Date(2026, 9, 11, 9, 0, 0).toISOString(),
    tokensBefore: 88_000,
    tokensAfter: 21_000
  }

  it('有记录：把摘要加成系统消息（前缀 = COMPACTION_PREFIX_TAG + 摘要原文，普通消息不动）', async () => {
    const added: string[] = []
    const messageList = {
      addSystem: (text: string): void => {
        added.push(text)
      }
    }
    const processor = createCompactionProcessor({ get: async () => record })
    expect(processor.id).toBe(COMPACTION_PROCESSOR_ID)
    const processInput = processor.processInput as unknown as (args: unknown) => Promise<unknown>
    await processInput({
      messageList,
      requestContext: {
        get: (key: string) => (key === 'MastraMemory' ? { thread: { id: 'thread-h' } } : undefined)
      }
    })

    expect(added).toHaveLength(1)
    expect(added[0]).toBe(compactionPrefix(record.summary))
    expect(added[0]?.startsWith(COMPACTION_PREFIX_TAG)).toBe(true)
    expect(added[0]).toContain('之前聊过缓存')
  })

  it('无记录 / 取不到会话 id：什么都不加', async () => {
    const call = async (requestContext: unknown): Promise<string[]> => {
      const added: string[] = []
      const messageList = {
        addSystem: (text: string): void => {
          added.push(text)
        }
      }
      const processor = createCompactionProcessor({ get: async () => null })
      const processInput = processor.processInput as unknown as (args: unknown) => Promise<unknown>
      await processInput({ messageList, requestContext })
      return added
    }
    expect(await call({ get: () => ({ thread: { id: 't' } }) })).toHaveLength(0)
    expect(await call({ get: () => undefined })).toHaveLength(0)
    expect(await call(undefined)).toHaveLength(0)
  })
})

describe('压缩存储（真 libsql）', () => {
  let dir: string
  let storage: LibSQLStore

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-compaction-store-'))
    storage = new LibSQLStore({
      id: 'kyclaw-compaction-store',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
  })

  afterAll(async () => {
    await storage?.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it(`建表 / upsert / 读回 / 清理（表名 ${COMPACTION_TABLE}）`, async () => {
    const store = createCompactionStore(compactionSqlClient(storage))
    await store.ensureTable()
    expect(await store.get('t1')).toBeNull()

    const first: ThreadCompaction = {
      threadId: 't1',
      summary: '第一次摘要',
      summarized: 4,
      kept: 10,
      level: 'summary',
      createdAt: new Date(2026, 9, 11, 10, 0, 0).toISOString(),
      // round 59：两个 token 列真的落库、真的读回来（不是只在内存里）
      tokensBefore: 527_000,
      tokensAfter: 53_700
    }
    await store.save(first)
    expect(await store.get('t1')).toEqual(first)

    const second: ThreadCompaction = { ...first, summary: '第二次摘要', summarized: 8 }
    await store.save(second)
    expect(await store.get('t1')).toEqual(second)

    await store.clear('t1')
    expect(await store.get('t1')).toBeNull()
  })

  // round 59：老库（round 58 及更早）没有 tokens_before / tokens_after 两列——ensureTable 要补上，
  // 旧行读出来归一成 null（不编造 0）。这里手工造一张老形状的表来走这条路。
  it('round 59/72 列迁移：老表补 token 与 level 两列、旧行读出 null / summary、迁移后的表能读写新列（重复迁移不报错）', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'kyclaw-compaction-legacy-'))
    const legacyStorage = new LibSQLStore({
      id: 'kyclaw-compaction-legacy',
      url: `file:${join(legacyDir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    try {
      const client = compactionSqlClient(legacyStorage)
      await client.execute(
        `CREATE TABLE "${COMPACTION_TABLE}" (
          "thread_id" TEXT PRIMARY KEY,
          "summary" TEXT NOT NULL,
          "summarized" INTEGER NOT NULL,
          "kept" INTEGER NOT NULL,
          "created_at" TEXT NOT NULL
        )`
      )
      await client.execute({
        sql: `INSERT INTO "${COMPACTION_TABLE}"
          ("thread_id", "summary", "summarized", "kept", "created_at") VALUES (?, ?, ?, ?, ?)`,
        args: ['legacy', '老摘要', 4, 2, new Date(2026, 9, 11, 10, 0, 0).toISOString()]
      })

      const store = createCompactionStore(client)
      await store.ensureTable() // 迁移在这一步发生
      expect(await store.get('legacy')).toEqual({
        threadId: 'legacy',
        summary: '老摘要',
        summarized: 4,
        kept: 2,
        // round 75：老行没有 level 列（那时只有摘要这一条路）→ 归一成 summary，不编造档位
        level: 'summary',
        createdAt: new Date(2026, 9, 11, 10, 0, 0).toISOString(),
        tokensBefore: null,
        tokensAfter: null
      })

      // 迁移后的表：新列能写能读
      const fresh: ThreadCompaction = {
        threadId: 'legacy',
        summary: '新摘要',
        summarized: 6,
        kept: 2,
        level: 'snip',
        createdAt: new Date(2026, 9, 11, 11, 0, 0).toISOString(),
        tokensBefore: 120_000,
        tokensAfter: 30_000
      }
      await store.save(fresh)
      expect(await store.get('legacy')).toEqual(fresh)

      // 再建一个 store 走一遍 ensureTable（列已存在的那条分支）：不该报错，数据也不动
      await createCompactionStore(client).ensureTable()
      expect(await store.get('legacy')).toEqual(fresh)
    } finally {
      await legacyStorage.close()
      try {
        rmSync(legacyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn(
          '[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：',
          legacyDir
        )
      }
    }
  })
})

describe('压缩路由（Hono + 压缩服务：多数假件，一条真接线）', () => {
  const THREAD_ID = 'thread-route'
  const threadRow = {
    id: THREAD_ID,
    resourceId: LOCAL_USER_RESOURCE_ID,
    title: null,
    updatedAt: new Date()
  }

  function makeApp(options: {
    thread?: typeof threadRow | null
    compact?: (
      threadId: string,
      keep?: number
    ) => Promise<{ compacted: boolean; compaction: ThreadCompaction | null }>
    of?: (threadId: string) => Promise<ThreadCompaction | null>
    withService?: boolean
  }): Hono {
    const memory = {
      getThreadById: vi.fn(async () => (options.thread === null ? null : threadRow)),
      recall: vi.fn(async () => ({ messages: [] })),
      deleteMessages: vi.fn(async () => undefined)
    }
    return new Hono().route(
      '/api/threads',
      createThreadsRouter({
        memory: memory as never,
        resolveModel: (async () => ({})) as never,
        ...(options.withService === false ||
        (options.compact === undefined && options.of === undefined)
          ? {}
          : {
              compaction: {
                compact: options.compact ?? (async () => ({ compacted: false, compaction: null })),
                of: options.of ?? (async () => null)
              }
            })
      })
    )
  }

  it('POST /:id/compact：回包过 shared schema；空 body = 缺省 keep（undefined）', async () => {
    const compact = vi.fn(async () => ({
      compacted: true,
      compaction: {
        threadId: THREAD_ID,
        summary: '摘要',
        summarized: 4,
        kept: 10,
        level: 'summary' as const,
        createdAt: new Date().toISOString(),
        tokensBefore: 527_000,
        tokensAfter: 53_700
      }
    }))
    const app = makeApp({ compact })
    const response = await app.request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(response.status).toBe(200)
    const body = compactThreadResponseSchema.parse(await response.json())
    expect(body.compacted).toBe(true)
    expect(compact).toHaveBeenCalledWith(THREAD_ID, undefined)
  })

  it('POST /:id/compact：keep 脏值 400；线程不存在 404；没接线 503', async () => {
    const app = makeApp({ compact: async () => ({ compacted: false, compaction: null }) })
    const bad = await app.request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: 1 })
    })
    expect(bad.status).toBe(400)

    const missing = await makeApp({
      thread: null,
      compact: async () => ({ compacted: false, compaction: null })
    }).request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(missing.status).toBe(404)

    const unwired = await makeApp({ withService: false }).request(
      `/api/threads/${THREAD_ID}/compact`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    )
    expect(unwired.status).toBe(503)
  })

  it('POST /:id/compact：模型配置类失败 → 400 原文透出；其余 → 500 一行通用文案', async () => {
    const { ProviderConfigError } = await import('../model')
    const configApp = makeApp({
      compact: async () => {
        throw new ProviderConfigError('p1', ['缺 API 密钥'])
      }
    })
    const configRes = await configApp.request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(configRes.status).toBe(400)
    expect(((await configRes.json()) as { error: string }).error).toContain('缺 API 密钥')

    const boomApp = makeApp({
      compact: async () => {
        throw new Error('backend stack trace 之类的东西')
      }
    })
    const boomRes = await boomApp.request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(boomRes.status).toBe(500)
    const body = (await boomRes.json()) as { error: string }
    expect(body.error).toContain('压缩没能完成')
    expect(body.error).not.toContain('backend stack trace')
  })

  it('GET /:id/compaction：有记录回记录、没有回 null（线程不存在也回 null，读侧幂等）', async () => {
    const record: ThreadCompaction = {
      threadId: THREAD_ID,
      summary: '摘要',
      summarized: 3,
      kept: 10,
      level: 'summary',
      createdAt: new Date().toISOString(),
      // round 59：回包要带上分界线用的两个 token 字段（strict schema：少了就 parse 报错）
      tokensBefore: 527_000,
      tokensAfter: 53_700
    }
    const withRecord = makeApp({ of: async () => record })
    const response = await withRecord.request(`/api/threads/${THREAD_ID}/compaction`)
    expect(response.status).toBe(200)
    expect(threadCompactionResponseSchema.parse(await response.json()).compaction).toEqual(record)

    const empty = makeApp({ thread: null, of: async () => null })
    const emptyResponse = await empty.request(`/api/threads/${THREAD_ID}/compaction`)
    expect(emptyResponse.status).toBe(200)
    expect(threadCompactionResponseSchema.parse(await emptyResponse.json()).compaction).toBeNull()
  })

  // round 58：路由不另设门槛——4 条会话（条数少、体量大）就该压得动。这条用真压缩服务接线
  // （上面的用例是假服务，只验回包形状）。
  it('POST /:id/compact：4 条会话也回 compacted=true（真服务接线，空 body 用缺省 keep）', async () => {
    const messages = [
      storedMessage('m1', 'user', '旧问题'),
      storedMessage('m2', 'assistant', '旧回答'),
      storedMessage('m3', 'user', '新问题'),
      storedMessage('m4', 'assistant', '新回答')
    ]
    const deleteMessages = vi.fn(async () => undefined)
    const memory = {
      getThreadById: vi.fn(async () => threadRow),
      recall: vi.fn(async () => ({ messages })),
      deleteMessages
    }
    const store = memoryStore()
    const service = createCompactionService({
      memory: memory as unknown as CompactionMemory,
      store,
      resolveModel: (async () => ({})) as never,
      generate: async () => ({ text: '## 要点\n- 前两轮聊过的事' })
    })
    const app = new Hono().route(
      '/api/threads',
      createThreadsRouter({
        memory: memory as never,
        resolveModel: (async () => ({})) as never,
        compaction: {
          compact: (threadId, keep) => service.compact(threadId, keep),
          of: (threadId) => store.get(threadId)
        }
      })
    )

    const response = await app.request(`/api/threads/${THREAD_ID}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(response.status).toBe(200)
    const body = compactThreadResponseSchema.parse(await response.json())
    expect(body.compacted).toBe(true)
    expect(body.compaction).toMatchObject({ threadId: THREAD_ID, summarized: 2, kept: 2 })
    expect(deleteMessages).toHaveBeenCalledWith(['m1', 'm2'])
    expect(await store.get(THREAD_ID)).toEqual(body.compaction)
  })
})

describe('真服务集成（chat + compact + 注入 + 截断）', () => {
  let dir: string
  let server: AgentServerHandle
  let chatPrompts: unknown[]
  let summaryPrompts: unknown[]
  const SUMMARY_TEXT = '## 要点\n- 用户前几轮都在聊天气\n## 决定\n- 无'

  function mockModel(): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      provider: 'kyclaw-compaction-mock',
      modelId: 'kyclaw-compaction-mock',
      doStream: async (options: { prompt: unknown }) => {
        chatPrompts.push(options.prompt)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: '回复。' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: FINISH_STOP, usage: CHAT_USAGE }
            ],
            initialDelayInMs: 0,
            chunkDelayInMs: 0
          })
        }
      },
      doGenerate: async (options: { prompt: unknown }) => {
        summaryPrompts.push(options.prompt)
        return {
          content: [{ type: 'text' as const, text: SUMMARY_TEXT }],
          finishReason: FINISH_STOP,
          usage: SUMMARY_USAGE,
          warnings: []
        }
      }
    })
  }

  function authed(init: RequestInit = {}): RequestInit {
    return {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.token}`,
        ...init.headers
      }
    }
  }

  async function say(threadId: string, messages: unknown[]): Promise<void> {
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      ...authed(),
      body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
    })
    expect(response.status).toBe(200)
    await response.text()
  }

  async function messages(
    threadId: string
  ): Promise<{ id: string; role: string; content: unknown }[]> {
    const response = await fetch(`${server.baseUrl}/api/threads/${threadId}/messages`, authed())
    expect(response.status).toBe(200)
    return (
      (await response.json()) as { messages: { id: string; role: string; content: unknown }[] }
    ).messages
  }

  function textOf(message: { content: unknown }): string {
    const parts = (message.content as { parts?: { type?: string; text?: string }[] }).parts ?? []
    return parts
      .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
      .join('\n')
  }

  /**
   * round 59：等该会话的"最近一轮输入"读数到位（记账在流收尾处，可能比 HTTP 回包晚一点）。
   * 到了才往下走；超时也断言一次——真没等到就是回归，不该悄悄跳过。
   */
  async function waitForLastInput(threadId: string, expected: number): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      const response = await fetch(
        `${server.baseUrl}/api/usage/context?threadId=${encodeURIComponent(threadId)}`,
        authed()
      )
      expect(response.status).toBe(200)
      const { lastInput } = (await response.json()) as { lastInput: number | null }
      if (lastInput === expected || Date.now() > deadline) {
        expect(lastInput).toBe(expected)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  beforeAll(async () => {
    chatPrompts = []
    summaryPrompts = []
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-compaction-'))
    const model = mockModel()
    server = await startAgentServer({
      dataDir: dir,
      resolveModel: async () => model as never
    })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('多轮对话 → 压缩 → 旧消息消失 / 记录可读 / 摘要进下一轮 prompt / 继续对话与截断正常', async () => {
    const threadId = 'thread-compact'
    await say(threadId, [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '第一问：天气怎样' }] }
    ])
    await say(threadId, [
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '第二问：适合钓鱼吗' }] }
    ])
    await say(threadId, [
      { id: 'u3', role: 'user', parts: [{ type: 'text', text: '第三问：明天呢' }] }
    ])

    const before = await messages(threadId)
    expect(before.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant'
    ])

    // —— 压缩（keep=2：保留最后一轮问答）——
    // round 59：先等"压缩前最近一轮"的读数落库（每轮 mock input = 1），下面才验证 tokensBefore
    await waitForLastInput(threadId, 1)
    const compactResponse = await fetch(
      `${server.baseUrl}/api/threads/${threadId}/compact`,
      authed({ method: 'POST', body: JSON.stringify({ keep: 2 }) })
    )
    expect(compactResponse.status).toBe(200)
    const outcome = compactThreadResponseSchema.parse(await compactResponse.json())
    expect(outcome.compacted).toBe(true)
    expect(outcome.compaction).toMatchObject({ threadId, summarized: 4, kept: 2 })
    expect(outcome.compaction?.summary).toContain('用户前几轮都在聊天气')
    // round 59：before = 压缩**之前**最近一轮的实测输入（1）；摘要那轮记的是 11 —— 若读数取在
    // 摘要落库之后，这里会是 11 而不是 1（顺带证明 index.ts 的 usageOf 真接上了、时机也对）
    expect(outcome.compaction?.tokensBefore).toBe(1)
    // after 是估算：基线 1 + 摘要与保留段的字符折算（mock 里压缩前输入只有 1 token，
    // 所以这组数字不体现"变小"——变小要在真模型上才看得到，这里只验公式接通了）
    expect(outcome.compaction?.tokensAfter).toBeGreaterThan(1)
    // 摘要调用的素材 = 被裁掉的前四条消息文本（generateText 的 prompt 是消息数组，序列化后断言）
    expect(JSON.stringify(summaryPrompts[0] ?? null)).toContain('第一问：天气怎样')

    // 旧消息从存储消失：只剩保留段
    const after = await messages(threadId)
    expect(after).toHaveLength(2)
    expect(after.map((message) => textOf(message))).toEqual(['第三问：明天呢', '回复。'])

    // 记录可读（顶部标记的数据面）
    const recordResponse = await fetch(
      `${server.baseUrl}/api/threads/${threadId}/compaction`,
      authed()
    )
    expect(recordResponse.status).toBe(200)
    expect(threadCompactionResponseSchema.parse(await recordResponse.json()).compaction).toEqual(
      outcome.compaction
    )

    // —— 压缩后继续对话：下一轮 prompt 带系统前缀摘要；被裁消息不再出现；摘要不落存储 ——
    const promptsBefore = chatPrompts.length
    await say(threadId, [
      { id: 'u4', role: 'user', parts: [{ type: 'text', text: '第四问：那后天呢' }] }
    ])
    expect(chatPrompts.length).toBe(promptsBefore + 1)
    const promptJson = JSON.stringify(chatPrompts[chatPrompts.length - 1])
    expect(promptJson).toContain(COMPACTION_PREFIX_TAG)
    expect(promptJson).toContain('用户前几轮都在聊天气')
    expect(promptJson).toContain('第三问：明天呢')
    expect(promptJson).not.toContain('第一问：天气怎样')

    const stored = await messages(threadId)
    expect(stored.map((message) => textOf(message))).toEqual([
      '第三问：明天呢',
      '回复。',
      '第四问：那后天呢',
      '回复。'
    ])
    // UI 流不被污染：摘要不是一条存储消息
    expect(stored.some((message) => textOf(message).includes('用户前几轮都在聊天气'))).toBe(false)

    // —— 压缩后"编辑重发"（截断半边）仍工作：从保留段里的消息起连它一起删 ——
    const target = stored[2]
    expect(target).toBeDefined()
    const truncateResponse = await fetch(
      `${server.baseUrl}/api/threads/${threadId}/truncate`,
      authed({ method: 'POST', body: JSON.stringify({ messageId: target?.id }) })
    )
    expect(truncateResponse.status).toBe(200)
    expect(((await truncateResponse.json()) as { deleted: number }).deleted).toBe(2)
    expect(await messages(threadId)).toHaveLength(2)
  }, 60_000)

  it('摘要调用消耗额度：并入单位窗口的用量（多一行 run）', async () => {
    const response = await fetch(`${server.baseUrl}/api/usage?range=today`, authed())
    expect(response.status).toBe(200)
    const usage = (await response.json()) as {
      byModel: { model: string; runs: number; tokens: { total: number } }[]
    }
    const row = usage.byModel.find((entry) => entry.model === 'kyclaw-compaction-mock')
    expect(row).toBeDefined()
    // 四个 chat 轮 + 一轮摘要 = 5 行；chat 每轮 4 token、摘要 122
    expect(row?.runs).toBe(5)
    expect(row?.tokens.total).toBe(4 * 4 + 122)
  }, 30_000)
})
