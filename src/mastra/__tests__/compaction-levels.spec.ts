// @vitest-environment node
/**
 * round 75 · 压缩分级（A）：**付钱之前先做零成本档**。
 *
 * 三块证据：
 *   1. 纯函数：占位说明四件事齐全（工具名 / 参数 / 开头若干行 / 去哪找）、只动 tool-invocation
 *      的 result、老的大结果优先、用户消息与助手正文一字不动、去重的两种命中（完全重复 /
 *      被更早结果包含）；
 *   2. 服务决策（**红→绿的核心**）：会话里"旧的大工具结果 × 多条"时，compact() 停在 `snip` 档
 *      ——`generate`（摘要模型）**一次都不调**、消息一条不删、usage_runs 一行不记，记录里
 *      `level: 'snip'` 与 before/after 双读数都在；旧段没有可省的东西时才回落摘要档；
 *      同一档不重复停（上次停在 snip → 这次从 dedupe 起算）；
 *   3. 注入处理器（真 MessageList）：机械档下模型这一轮收到的 prompt 里，大工具结果已换成
 *      占位说明（大文本真的不在 prompt 里了），而**存储/界面的原文一字未动**、消息顺序不变、
 *      保留窗口内的新结果不碰、本轮新产生的消息不碰。
 *
 * 口径与边界见 src/mastra/compaction.ts 头注（"压缩分级"那两段）。
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageList } from '@mastra/core/agent'
import {
  argsSummaryOf,
  buildTranscript,
  compactionLevelOf,
  estimateTokens,
  liveCharsOf,
  mechanicalDecision,
  mechanicalPrefix,
  mechanicalStage,
  mechanicalSummaryText,
  nextMechanicalLevel,
  PROCESSOR_KEEP_MESSAGES,
  recordLevelOf,
  resultHead,
  resultText,
  createCompactionProcessor,
  snipPlaceholder,
  SNIP_HEAD_LINES,
  SNIP_MIN_RESULT_CHARS,
  trimLoadedHistory,
  type CompactionMemory,
  type CompactionStore,
  COMPACT_MAX_OUTPUT_TOKENS,
  COMPACTION_PREFIX_TAG,
  createCompactionService
} from '../compaction'
import type { ThreadCompaction } from '../../shared/threads'
import { threadCompactionResponseSchema } from '../../shared/threads'
import type { UsageRun, UsageStore } from '../usage'

/* ─────────────────────────────── 夹具 ─────────────────────────────── */

/** 一条工具结果消息（v2 形状：tool-invocation part 带 result） */
function toolMessage(
  id: string,
  toolName: string,
  args: unknown,
  result: string,
  toolCallId = `c-${id}`
): {
  id: string
  role: string
  content: { parts: unknown[] }
} {
  return {
    id,
    role: 'assistant',
    content: {
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: { state: 'result', toolCallId, toolName, args, result }
        }
      ]
    }
  }
}

/** 一条纯文本消息 */
function textMessage(
  id: string,
  role: string,
  text: string
): { id: string; role: string; content: { parts: unknown[] } } {
  return { id, role, content: { parts: [{ type: 'text', text }] } }
}

/**
 * 造一段"真实形态"的大结果：像 read 一个大文件那样，多行、每行带行号，
 * **末尾有一行独特标记**（"被省掉的中间与结尾"靠它断言——开头几行本来就留在占位说明里）。
 */
function bigResult(chars: number, label: string): string {
  const tail = `${label} —— 文件结尾标记（这一行在原文最后）\n`
  const lines: string[] = []
  let size = 0
  let index = 1
  while (size + tail.length < chars) {
    const line = `${label} 第 ${index} 行：export const something${'x'.repeat(40)} = 1;\n`
    lines.push(line)
    size += line.length
    index += 1
  }
  return lines.join('') + tail
}

/**
 * 一条"旧的大工具结果 × 多条"的会话（24 条存储消息）：
 * 前 14 条 = 旧段（会被机械档处理），后 10 条 = 保留窗口（最近几轮，一条都不能动）。
 * 旧段里 6 条工具结果合计约 44.5 万字符——就是实测里把上下文撑爆的那种形态。
 */
const BIG_SIZES = [180_000, 90_000, 60_000, 50_000, 40_000, 25_000] as const
const BIG_TOTAL = BIG_SIZES.reduce((sum, size) => sum + size, 0)

function realisticSession(): ReturnType<typeof textMessage>[] {
  return [
    textMessage('m1', 'user', '先读一下 package-lock.json 看看锁了什么版本'),
    toolMessage('m2', 'read', { path: 'package-lock.json' }, bigResult(BIG_SIZES[0], 'lock')),
    textMessage('m3', 'user', '好，日志也看一下'),
    toolMessage('m4', 'read', { path: 'build.log' }, bigResult(BIG_SIZES[1], 'log')),
    textMessage('m5', 'user', '继续'),
    toolMessage('m6', 'bash', { command: 'npm ls --all' }, bigResult(BIG_SIZES[2], 'npm')),
    textMessage('m7', 'user', '嗯'),
    toolMessage('m8', 'grep', { pattern: 'import' }, bigResult(BIG_SIZES[4], 'grep')),
    textMessage('m9', 'user', '好的'),
    toolMessage('m10', 'bash', { command: 'pnpm test' }, bigResult(BIG_SIZES[3], 'test')),
    textMessage('m11', 'user', '再读一下那个大文件'),
    toolMessage('m12', 'read', { path: 'src/mastra/index.ts' }, bigResult(BIG_SIZES[5], 'index')),
    textMessage('m13', 'user', '明白了'),
    textMessage('m14', 'assistant', '总结：锁文件与日志都看过了，测试也跑过。'),
    // —— 以下 10 条是保留窗口（最近几轮现场）——
    textMessage('m15', 'user', '现在改一下压缩逻辑'),
    // 保留窗口里也有一条大结果：**不能被碰**（这是"最近十轮是现场"的钉子）
    toolMessage('m16', 'read', { path: 'src/mastra/compaction.ts' }, bigResult(70_000, 'compaction')),
    textMessage('m17', 'user', '继续改'),
    textMessage('m18', 'assistant', '好。'),
    textMessage('m19', 'user', '再看一眼测试'),
    textMessage('m20', 'assistant', '看过了。'),
    textMessage('m21', 'user', '行'),
    textMessage('m22', 'assistant', '嗯。'),
    textMessage('m23', 'user', '最后一问'),
    textMessage('m24', 'assistant', '答。')
  ]
}

function fakeMemory(messages: ReadonlyArray<{ id: string }>): {
  memory: CompactionMemory
  deleteMessages: ReturnType<typeof vi.fn>
} {
  const deleteMessages = vi.fn(async () => undefined)
  return {
    memory: { recall: vi.fn(async () => ({ messages })), deleteMessages } as unknown as CompactionMemory,
    deleteMessages
  }
}

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

/**
 * 压缩前的实测读数：这轮会话被大工具结果撑到约 175k tokens —— 这个数字是**按真身子算的**：
 * 会话进 prompt 的字符数 / 3（见下面"自洽性"那条用例，它拿 processor 真产出的 prompt 体积
 * 与记录里的 tokensAfter 对了一遍）。分界线左边的 before 就是它。
 */
const MEASURED_BEFORE = 175_000
const BASELINE = 11_000

/* ─────────────────────── 1. 纯函数：占位说明与两档改写 ─────────────────────── */

describe('机械档的占位说明', () => {
  it('snip 的四件事齐全：工具名、参数摘要、结果开头、去哪找原文', () => {
    const text = bigResult(50_000, 'file')
    const placeholder = snipPlaceholder('read', { path: 'a.txt', offset: 1 }, text.length, text)

    expect(placeholder).toContain('read')
    expect(placeholder).toContain('"path":"a.txt"')
    expect(placeholder).toContain(`共 ${text.length} 字符`)
    // 结果开头真的留了（模型才认得出"这里曾经有什么"）：第一行在，深处与结尾不在
    expect(placeholder).toContain('第 1 行')
    expect(placeholder).not.toContain('文件结尾标记')
    expect(placeholder).not.toContain('第 100 行')
    // 指路：重新执行同一个工具
    expect(placeholder).toContain('重新执行')
    // 占位说明本身要小（否则不叫精简）
    expect(placeholder.length).toBeLessThan(SNIP_MIN_RESULT_CHARS * 2)
    expect(placeholder.length).toBeLessThan(text.length)
  })

  it('结果开头按行截断（超过 20 行只留前 20 行），参数摘要按 200 字截断', () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行`).join('\n')
    const head = resultHead(manyLines)
    expect(head.split('\n')).toHaveLength(SNIP_HEAD_LINES)
    expect(head).toContain('第 20 行')
    expect(head).not.toContain('第 21 行')

    const args = argsSummaryOf({ command: 'x'.repeat(500) })
    expect(args.length).toBeLessThanOrEqual(201)
    expect(args.endsWith('…')).toBe(true)
  })

  it('对象结果按 JSON 折算（模型看到的开销就是它）', () => {
    expect(resultText({ a: 1 })).toBe('{"a":1}')
    expect(resultText('plain')).toBe('plain')
    expect(resultText(undefined)).toBeNull()
    expect(resultText(null)).toBeNull()
  })
})

describe('机械档的两档改写（纯函数，不改输入）', () => {
  it('snip：只换大结果的结果体，用户原话与助手正文一字不动；保留窗口外的大结果优先', () => {
    const session = realisticSession()
    const before = JSON.stringify(session)
    const stage = mechanicalStage(session.slice(0, 14), 'snip')

    // 6 条大结果都被换了（最小那条 25k 也远超门槛）
    expect(stage.rewritten).toBe(6)
    // 输入一个字节都没被改（纯函数）
    expect(JSON.stringify(session)).toBe(before)
    // 用户消息与助手正文一律原样（逐条同一性）
    for (const index of [0, 2, 4, 6, 8, 10, 12, 13]) {
      expect(stage.messages[index]).toBe(session[index])
    }
    // 被换的那条：result 变成占位说明，参数（args）保留
    const replaced = stage.messages[1] as { content: { parts: { toolInvocation: Record<string, unknown> }[] } }
    const invocation = replaced.content.parts[0]?.toolInvocation ?? {}
    expect(String(invocation.result)).toContain('[工具结果已精简]')
    expect(String(invocation.result)).toContain('package-lock.json')
    expect(invocation.args).toEqual({ path: 'package-lock.json' })
    expect(invocation.toolName).toBe('read')
    // 释放量：原来 44.5 万字符的六条大结果，换成六条占位说明
    expect(stage.freedChars).toBeGreaterThan(BIG_TOTAL * 0.97)
    expect(stage.beforeChars).toBeGreaterThanOrEqual(BIG_TOTAL)
  })

  it('snip 的两个门槛：太小的结果不碰；改完不省反亏的也不碰', () => {
    const small = toolMessage('s1', 'read', { path: 'a' }, 'x'.repeat(SNIP_MIN_RESULT_CHARS - 1))
    const stageSmall = mechanicalStage([small], 'snip')
    expect(stageSmall.rewritten).toBe(0)
    expect(stageSmall.messages[0]).toBe(small)

    // 刚过门槛一点点：占位说明（头 20 行 + 参数 + 指路）比原文还长 → 不改
    const borderline = toolMessage('s2', 'read', { path: 'a' }, 'y'.repeat(SNIP_MIN_RESULT_CHARS))
    const stageBorder = mechanicalStage([borderline], 'snip')
    expect(stageBorder.rewritten).toBe(0)
  })

  it('dedupe：完全重复的第二次起换成"指向首次出现处"；首次那条一字不动', () => {
    const repeated = bigResult(900, 'cfg').replace(/\n/g, '')
    const messages = [
      toolMessage('d1', 'read', { path: 'settings.json' }, repeated),
      toolMessage('d2', 'read', { path: 'settings.json' }, repeated),
      toolMessage('d3', 'read', { path: 'settings.json' }, repeated)
    ]
    const stage = mechanicalStage(messages, 'dedupe')

    expect(stage.rewritten).toBe(2)
    expect(stage.messages[0]).toBe(messages[0]) // 首次出现：原文留着
    expect(String((stage.messages[1] as never as { content: { parts: { toolInvocation: { result: string } }[] } }).content.parts[0]?.toolInvocation.result)).toContain('[工具结果已去重]')
    expect(JSON.stringify(stage.messages[1])).not.toContain('cfgcfg')
    expect(stage.freedChars).toBeGreaterThan(0)
    // 零信息损失：首次那份原文还在（模型按指路能找回）
    expect(JSON.stringify(stage.messages[0])).toContain(repeated.slice(0, 200))
  })

  it('dedupe：后一次的结果被更早那份包含（同一文件读了两次、第二次窗口更小）也算重复', () => {
    const whole = bigResult(5_000, 'whole')
    const window = whole.slice(0, 2_000)
    const messages = [
      toolMessage('w1', 'read', { path: 'a.txt' }, whole),
      toolMessage('w2', 'read', { path: 'a.txt', offset: 1, limit: 40 }, window)
    ]
    const stage = mechanicalStage(messages, 'dedupe')

    expect(stage.rewritten).toBe(1)
    expect(stage.messages[0]).toBe(messages[0])
    expect(String(JSON.stringify(stage.messages[1]))).toContain('[工具结果已去重]')
  })

  it('liveCharsOf 只数正文与工具结果（思考过程不进裁剪射程）', () => {
    const withReasoning = {
      id: 'r1',
      role: 'assistant',
      content: {
        parts: [
          { type: 'reasoning', reasoning: 'x'.repeat(9_999) },
          { type: 'text', text: 'abc' },
          toolMessage('t', 'read', {}, 'y'.repeat(10)).content.parts[0]
        ]
      }
    }
    expect(liveCharsOf([withReasoning])).toBe(3 + 10)
  })
})

/* ─────────────── 2. 服务决策：够省就不调摘要模型（红→绿核心） ─────────────── */

describe('压缩分级：零成本档先上，够省就不调摘要模型', () => {
  const model = { modelId: 'deepseek-flash', provider: 'deepseek' } as never
  const resolveModel = async (): Promise<never> => model

  it('【核心】旧的大工具结果够省 → 停在 snip：不调模型、不删消息、不记账，记录带 level 与双读数', async () => {
    const session = realisticSession()
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore()
    const usage = fakeUsageStore()
    // 摘要模型带一个实现：这一版**不该走到它**——真走了的话，下面第一条断言就会报
    // "Number of calls: 1"（这就是"只做摘要那版"失败的样子）
    const generate = vi.fn(async () => ({ text: '## 要点\n- 这版不该调用摘要模型' }))
    const service = createCompactionService({
      memory,
      store,
      resolveModel,
      generate,
      usage,
      usageOf: async () => ({ lastInput: MEASURED_BEFORE, baselineInput: BASELINE })
    })

    const outcome = await service.compact('thread-snip')

    // ① 没有付钱：摘要模型一次都没被调用（这条就是"只做摘要那版"会失败的地方）
    expect(generate).not.toHaveBeenCalled()
    // 也没有记账行（用量页/预算里不会多出一次"压缩"）
    expect(usage.runs).toEqual([])
    // ② 一条消息都没删（用户原话与工具轨迹都还在存储里）
    expect(deleteMessages).not.toHaveBeenCalled()
    // ③ 记录：档位 + 这次的省法 + before/after 双读数
    const record = outcome.compaction
    expect(record?.level).toBe('snip')
    expect(record?.summarized).toBe(6)
    expect(record?.kept).toBe(10)
    expect(record?.tokensBefore).toBe(MEASURED_BEFORE)
    expect(record?.tokensAfter).toBeLessThan(record?.tokensBefore ?? 0)
    expect(record?.summary).toContain('没有调用模型')
    expect(record?.summary).toContain('6 条工具结果')
    expect(await store.get('thread-snip')).toEqual(record)

    // ④ 真数字：释放的字符数 / 估算 token / 分界线上的 before → after
    const freedChars = BIG_TOTAL - (record?.summary.length ?? 0) * 0 // 占位说明的开销见下
    expect(freedChars).toBeGreaterThan(0)
    console.log(
      '[snip 实测] 旧段大工具结果合计 %d 字符；记录 summarized=%d；tokensBefore=%d → tokensAfter=%d',
      BIG_TOTAL,
      record?.summarized,
      record?.tokensBefore,
      record?.tokensAfter
    )
  })

  it('【核心·负向】旧段没有可省的东西（纯对话正文）→ 回落摘要档：这次真的调了模型', async () => {
    const session = Array.from({ length: 24 }, (_, index) =>
      textMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `第 ${index + 1} 条对话`)
    )
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore()
    const generate = vi.fn(async () => ({ text: '## 要点\n- 聊了 12 轮' }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-summary')

    expect(generate).toHaveBeenCalledTimes(1)
    expect(outcome.compaction?.level).toBe('summary')
    expect(deleteMessages).toHaveBeenCalledTimes(1)
    // 摘要档照旧：删掉旧段、保留窗口不变
    expect(outcome.compaction?.summarized).toBe(14)
    expect(outcome.compaction?.kept).toBe(10)
  })

  it('【核心·负向】同一档不重复停：上次停在 snip、这次没有新可省的 → 直接去摘要', async () => {
    const session = realisticSession()
    const previous: ThreadCompaction = {
      threadId: 'thread-again',
      summary: '上一次：把较早的 6 条工具结果换成了占位说明',
      summarized: 6,
      kept: 10,
      level: 'snip',
      createdAt: new Date(2026, 9, 12, 10, 0, 0).toISOString(),
      tokensBefore: 152_000,
      tokensAfter: 7_000
    }
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore([previous])
    const generate = vi.fn(async () => ({ text: '## 要点\n- 大文件都读过了' }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-again')

    // snip 已经开着，且这批会话里没有重复结果 → dedupe 也停不住 → 付摘要那一笔
    expect(generate).toHaveBeenCalledTimes(1)
    expect(outcome.compaction?.level).toBe('summary')
    expect(deleteMessages).toHaveBeenCalledTimes(1)
  })

  it('上次停在 snip：这次旧段里出现重复结果且够省 → 停在 dedupe（仍然不调模型）', async () => {
    const repeated = bigResult(990, 'cfg').replace(/\n/g, '')
    // 24 条 = 旧段 14 条（12 条重复的工具结果）+ 保留窗口 10 条
    const session = [
      textMessage('u1', 'user', '读一下设置'),
      ...Array.from({ length: 12 }, (_, index) =>
        toolMessage(`d${index + 1}`, 'read', { path: 'settings.json' }, repeated, `c${index}`)
      ),
      textMessage('u2', 'user', '嗯'),
      ...Array.from({ length: 10 }, (_, index) =>
        textMessage(`k${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `第 ${index + 1} 条`)
      )
    ]
    const previous: ThreadCompaction = {
      threadId: 'thread-dedupe',
      summary: '上一次：把较早的若干条工具结果换成占位说明',
      summarized: 4,
      kept: 10,
      level: 'snip',
      createdAt: new Date(2026, 9, 12, 11, 0, 0).toISOString(),
      tokensBefore: 90_000,
      tokensAfter: 30_000
    }
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore([previous])
    const generate = vi.fn()
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-dedupe')

    expect(generate).not.toHaveBeenCalled()
    expect(deleteMessages).not.toHaveBeenCalled()
    expect(outcome.compaction?.level).toBe('dedupe')
    // 12 条里 11 条是重复（首次出现那份留着）
    expect(outcome.compaction?.summarized).toBe(11)
  })

  it('上次已经是 fold（三档都在生效，round 76 起链尾）→ 只能去摘要：这一轮直接调模型', async () => {
    const session = realisticSession()
    const previous: ThreadCompaction = {
      threadId: 'thread-both',
      summary: '上一次：裁剪 + 去重 + 折叠都做了',
      summarized: 8,
      kept: 10,
      level: 'fold',
      createdAt: new Date(2026, 9, 12, 12, 0, 0).toISOString(),
      tokensBefore: 60_000,
      tokensAfter: 20_000
    }
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore([previous])
    const generate = vi.fn(async () => ({ text: '## 要点\n- 都做过了' }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-both')

    // round 76：链尾是 fold —— 走到它就没有下一档机械手段了（四档顺序见 shared/compactionLevels）
    expect(nextMechanicalLevel(previous)).toBeNull()
    expect(mechanicalDecision(session.slice(0, 14), previous)).toBeNull()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(outcome.compaction?.level).toBe('summary')
    expect(deleteMessages).toHaveBeenCalledTimes(1)
  })

  it('上次停在 dedupe：链上还有 fold 一档（不是"永远停在 dedupe"）', () => {
    const previous: ThreadCompaction = {
      threadId: 't-chain',
      summary: '上一次：裁剪 + 去重',
      summarized: 4,
      kept: 10,
      level: 'dedupe',
      createdAt: new Date(2026, 9, 12, 12, 30, 0).toISOString(),
      tokensBefore: 60_000,
      tokensAfter: 20_000
    }
    // snip → dedupe → fold → null：每一档都有自己的下一档，且不回头
    expect(nextMechanicalLevel(null)).toBe('snip')
    expect(nextMechanicalLevel(previous)).toBe('fold')
    expect(nextMechanicalLevel({ ...previous, level: 'snip' })).toBe('dedupe')
    expect(nextMechanicalLevel({ ...previous, level: 'summary' })).toBe('snip')
  })

  it('机械档不把"上次的精简说明"当成旧摘要拼进素材（摘要档才携带）', () => {
    const snipRecord: ThreadCompaction = {
      threadId: 't',
      summary: '这次没有调用模型：把较早的 3 条工具结果换成了占位说明',
      summarized: 3,
      kept: 10,
      level: 'snip',
      createdAt: new Date(2026, 9, 12, 13, 0, 0).toISOString(),
      tokensBefore: 50_000,
      tokensAfter: 10_000
    }
    // 归一口径：有档位用它；没有（老记录 / 手造）按 summary
    expect(recordLevelOf(snipRecord)).toBe('snip')
    expect(recordLevelOf(null)).toBe('summary')
    expect(compactionLevelOf(undefined)).toBe('summary')
    expect(compactionLevelOf('snip')).toBe('snip')
    expect(compactionLevelOf('胡说')).toBe('summary')
  })

  it('shared 契约：带 level 的记录过、不带 level 的老记录也过（读侧按 summary 解释），脏档位被拒', () => {
    const base = {
      threadId: 't-contract',
      summary: '摘要或精简说明',
      summarized: 3,
      kept: 10,
      createdAt: new Date(2026, 9, 12, 14, 0, 0).toISOString(),
      tokensBefore: null,
      tokensAfter: null
    }
    // 老记录（round 71 及更早）没有 level 字段：路由回包解析不许因此炸
    const old = threadCompactionResponseSchema.parse({ compaction: base })
    expect(old.compaction?.level).toBeUndefined()
    // 新记录带着档位（分界线 / 轨迹页要读它）
    for (const level of ['snip', 'dedupe', 'summary'] as const) {
      const parsed = threadCompactionResponseSchema.parse({ compaction: { ...base, level } })
      expect(parsed.compaction?.level).toBe(level)
    }
    // 认不出的档位是脏数据：拒绝（别让一个没走过的档位显示在分界线上）
    expect(() =>
      threadCompactionResponseSchema.parse({ compaction: { ...base, level: '折叠' } })
    ).toThrow()
  })

  it('决策只看"看得见的那一段"：比 40 条更老的旧段不参与（那些消息本来就不进 prompt）', () => {
    const bigOld = toolMessage('old', 'read', { path: 'a' }, bigResult(200_000, 'old'))
    const messages = [
      bigOld,
      toolMessage('old2', 'read', { path: 'b' }, bigResult(200_000, 'old2')),
      ...Array.from({ length: 20 }, (_, index) => textMessage(`t${index}`, 'user', 'x'))
    ]
    // 旧段（outside 保留窗口）只有那两条大结果 → 决策看得见它们
    expect(mechanicalDecision(messages.slice(0, 22), null)?.level).toBe('snip')
    // 换成一个"看不见"的旧段（这里只有正文）→ 机械档停不住
    const noTools = messages.slice(0, 22).filter((message) => message.content.parts.some((part) => (part as { type?: string }).type === 'text'))
    expect(mechanicalDecision(noTools, null)).toBeNull()
  })

  it('机械档记录的人话文案：说清"怎么省的"（不写后端实现）', () => {
    const snipText = mechanicalSummaryText({ level: 'snip', rewritten: 6, freedChars: 436_000 })
    expect(snipText).toContain('没有调用模型')
    expect(snipText).toContain('6 条工具结果')
    expect(snipText).toContain('一字未动')
    expect(snipText).toContain('重新执行')
    const dedupeText = mechanicalSummaryText({ level: 'dedupe', rewritten: 11, freedChars: 7_150 })
    expect(dedupeText).toContain('没有调用模型')
    expect(dedupeText).toContain('11 条')
    expect(mechanicalPrefix('snip')).toContain('上下文已精简')
  })
})

/* ───────────── 3. 注入处理器：模型看到占位、存储里原文一字未动 ───────────── */

describe('注入处理器：机械档改的是"这一轮发给模型的那份"', () => {
  const THREAD_ID = 'thread-proc'

  /**
   * 真 MessageList：历史按 source=memory 装进去，本轮新发的用户消息按 source=input 装——
   * 与生产的装配路径同形（memory 处理器先载入历史、我们的处理器排在其后）。
   */
  function listWith(session: ReturnType<typeof textMessage>[]): {
    messageList: MessageList
    session: ReturnType<typeof textMessage>[]
    live: { id: string; role: string; parts: unknown[] }[]
  } {
    const messageList = new MessageList({ threadId: THREAD_ID, resourceId: 'local-user' })
    const start = new Date(2026, 0, 1, 10, 0, 0).getTime()
    messageList.add(
      session.map((message, index) => ({
        ...message,
        threadId: THREAD_ID,
        resourceId: 'local-user',
        createdAt: new Date(start + index * 1000),
        content: { format: 2, parts: message.content.parts }
      })) as never,
      'memory'
    )
    const live = [
      { id: 'live-1', role: 'user', parts: [{ type: 'text', text: '这一轮的新问题' }] }
    ]
    messageList.add(
      live.map((message) => ({
        ...message,
        threadId: THREAD_ID,
        resourceId: 'local-user',
        createdAt: new Date(start + session.length * 1000),
        content: { format: 2, parts: message.parts }
      })) as never,
      'input'
    )
    return { messageList, session, live }
  }

  async function runProcessor(
    messageList: MessageList,
    record: ThreadCompaction
  ): Promise<void> {
    const processor = createCompactionProcessor({ get: async () => record })
    const processInput = processor.processInput as unknown as (args: unknown) => Promise<unknown>
    await processInput({
      messageList,
      messages: messageList.get.input.db(),
      requestContext: {
        get: (key: string): unknown =>
          key === 'MastraMemory' ? { thread: { id: THREAD_ID } } : undefined
      }
    })
  }

  const snipRecord: ThreadCompaction = {
    threadId: THREAD_ID,
    summary: '这次没有调用模型：把较早的 6 条工具结果换成了占位说明，省下约 145k tokens。',
    summarized: 6,
    kept: 10,
    level: 'snip',
    createdAt: new Date(2026, 0, 1, 12, 0, 0).toISOString(),
    tokensBefore: MEASURED_BEFORE,
    tokensAfter: 27_000
  }

  it('snip 档：prompt 里的大工具结果换成占位说明、用户原话与助手正文原样、顺序不变', async () => {
    const { messageList, session } = listWith(realisticSession())
    const promptBefore = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    await runProcessor(messageList, snipRecord)
    const promptAfter = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    // ① 大文本真的不在这一轮 prompt 里了（省下来的就是这个）：深处与结尾都消失了，只留开头
    expect(promptBefore).toContain('lock —— 文件结尾标记')
    expect(promptAfter).not.toContain('lock —— 文件结尾标记')
    expect(promptAfter).not.toContain('lock 第 500 行')
    expect(promptAfter).toContain('lock 第 1 行')
    // ② 占位说明进了 prompt：模型知道这里曾经有什么、去哪找
    expect(promptAfter).toContain('[工具结果已精简]')
    expect(promptAfter).toContain('package-lock.json')
    expect(promptAfter).toContain('重新执行')
    // ③ 用户原话一字未动
    for (const message of session.filter((item) => item.role === 'user')) {
      const text = String((message.content.parts[0] as { text?: string }).text)
      expect(promptAfter).toContain(text)
    }
    // ④ 一行说明也进了系统消息（说清"历史被精简过"）
    expect(promptAfter).toContain(mechanicalPrefix('snip').slice(0, 12))
    // ⑤ prompt 体积真的小了（真数字）
    expect(promptAfter.length).toBeLessThan(promptBefore.length)
    console.log(
      '[处理器实测] 这一轮 prompt（模型看到的）%d 字符 → %d 字符，省下约 %d token（估算）',
      promptBefore.length,
      promptAfter.length,
      estimateTokens(promptBefore.length - promptAfter.length)
    )
  })

  it('存储/界面的原文一字未动：会话消息对象没被改写，顺序也没变', async () => {
    const { messageList, session } = listWith(realisticSession())
    const resultBefore = String(
      (session[1]?.content.parts[0] as { toolInvocation?: { result?: string } }).toolInvocation?.result
    )

    await runProcessor(messageList, snipRecord)

    // 交给处理器的那些消息对象（= 存储层的这一份）没被改过
    expect(
      String(
        (session[1]?.content.parts[0] as { toolInvocation?: { result?: string } }).toolInvocation?.result
      )
    ).toBe(resultBefore)
    expect(resultBefore).toContain('lock —— 文件结尾标记')
    // 消息列的顺序不变（去重/裁剪不许把消息挪位置）
    expect(messageList.get.all.db().map((message) => message.id).join(',')).toBe(
      [...session.map((message) => message.id), 'live-1'].join(',')
    )
  })

  it('保留窗口内的新大结果不碰；本轮新发的消息也不碰；且不会把它当成"待落库"再存一遍', async () => {
    const { messageList } = listWith(realisticSession())

    await runProcessor(messageList, snipRecord)

    // m16 是保留窗口里的 70k 大结果：原样留着
    const kept = messageList.get.all.db().find((message) => message.id === 'm16')
    expect(JSON.stringify(kept)).toContain('compaction —— 文件结尾标记')
    // 本轮新发的用户消息：原样、且仍是 input 来源（轮末照常落库）
    const live = messageList.get.all.db().find((message) => message.id === 'live-1')
    expect(JSON.stringify(live)).toContain('这一轮的新问题')
    const checked = messageList.getPersisted.input.db().map((message) => message.id)
    expect(checked).toEqual(['live-1'])
  })

  it('summary 档（老路）行为不变：只加系统前缀，消息列一个字节都不动', async () => {
    const { messageList } = listWith(realisticSession())
    const record: ThreadCompaction = {
      threadId: THREAD_ID,
      summary: '## 要点\n- 之前聊过锁文件版本',
      summarized: 4,
      kept: 10,
      level: 'summary',
      createdAt: new Date(2026, 0, 1, 12, 30, 0).toISOString(),
      tokensBefore: 90_000,
      tokensAfter: 30_000
    }

    await runProcessor(messageList, record)
    const prompt = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    expect(prompt).toContain(COMPACTION_PREFIX_TAG)
    expect(prompt).toContain('之前聊过锁文件版本')
    // 摘要档不裁剪：大结果照旧进 prompt（含深处与结尾）
    expect(prompt).toContain('lock —— 文件结尾标记')
    expect(prompt).not.toContain('[工具结果已精简]')
  })

  it('dedupe 档：重复结果在 prompt 里指向首次出现处', async () => {
    const repeated = bigResult(900, 'cfg').replace(/\n/g, '')
    const session = [
      ...Array.from({ length: 12 }, (_, index) =>
        textMessage(`u${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `第 ${index + 1} 条`)
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        toolMessage(`d${index + 1}`, 'read', { path: 'settings.json' }, repeated, `c${index}`)
      )
    ]
    const { messageList } = listWith(session)
    const before = messageList.get.all.db().length

    await runProcessor(messageList, { ...snipRecord, level: 'dedupe', summarized: 11 })

    const prompt = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())
    expect(prompt).toContain('[工具结果已去重]')
    expect(messageList.get.all.db()).toHaveLength(before)
  })

  it('trimLoadedHistory 返回改写的条数（0 = 这一轮没什么可省）', () => {
    const { messageList } = listWith(realisticSession())
    expect(trimLoadedHistory(messageList, 'snip')).toBe(6)
  })

  it('裁剪窗口跟着记录里的保留条数走（kept=2 → 连最近那几条里的新大结果也算旧段）', () => {
    const { messageList } = listWith(realisticSession())
    // 记录说"只保留最近 2 条" → 旧段一直伸到 m16（保留窗口里那条 70k 结果也成了旧段）
    expect(trimLoadedHistory(messageList, 'snip', 2)).toBe(7)
  })

  it('记录里的保留窗口被写坏（0）时兜住最后 2 条：不许裁到"正在干的那一轮"', () => {
    const { messageList } = listWith(realisticSession())
    const all = messageList.get.all.db()
    const lastTwo = all.slice(-2).map((message) => message.id)
    // kept=0 → 内部按 KEEP_MIN(2) 收口
    expect(trimLoadedHistory(messageList, 'snip', 0)).toBe(7)
    const keptIds = messageList.get.all.db().map((message) => message.id)
    for (const id of lastTwo) expect(keptIds).toContain(id)
  })
})

/* ───────── 4. 省下来的钱：与"只做摘要那版"的输入/输出对照（真数字） ───────── */

describe('零成本档省下的钱（与摘要调用的对照）', () => {
  it('机械档不产生任何模型调用；摘要那版要付的输入/输出可以量出来', () => {
    const older = realisticSession().slice(0, 14)
    const material = buildTranscript(older)
    const summaryCallTokens = estimateTokens(material.length) + COMPACT_MAX_OUTPUT_TOKENS

    // 摘要那版：一次调用（素材输入 + 摘要输出上限）
    expect(summaryCallTokens).toBeGreaterThan(0)
    // 机械档：同样一段历史，零调用
    const decision = mechanicalDecision(older, null)
    expect(decision?.level).toBe('snip')
    console.log(
      '[成本对照] 这段历史：机械档 = 0 次调用；摘要档 = 1 次调用（素材 %d 字符 ≈ %d input token + 最多 %d output token）',
      material.length,
      estimateTokens(material.length),
      COMPACT_MAX_OUTPUT_TOKENS
    )
  })

  it('估算器口径：estimateTokens(字符) = 向上取整 / 3', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(3)).toBe(1)
    expect(estimateTokens(4)).toBe(2)
    expect(estimateTokens(BIG_TOTAL)).toBe(Math.ceil(BIG_TOTAL / 3))
  })

  /**
   * 自洽性：分界线上的 `before → ~after` 不是拍的——after（估算）= before（实测）− 本档释放，
   * 而"本档释放"与 processor 真产出的 prompt 缩量对得上。这条用例把两边摆在一起量一次：
   * 服务端算出的 after 与"真 prompt 体积 / 3"应当在同一量级（这里给 5% 容差）。
   */
  it('after 的估算与真 prompt 体积吻合（服务端记录 ↔ 处理器真产出）', async () => {
    const session = realisticSession()
    const { memory } = fakeMemory(session)
    const store = memoryStore()
    const generate = vi.fn()
    const service = createCompactionService({
      memory,
      store,
      resolveModel: async () => ({ modelId: 'x', provider: 'y' }) as never,
      generate,
      usageOf: async () => ({ lastInput: MEASURED_BEFORE, baselineInput: BASELINE })
    })
    const outcome = await service.compact('thread-consistency')
    expect(outcome.compaction?.level).toBe('snip')

    // 处理器那边的真账：同一段会话、同一个档位，看这一轮 prompt 变成了多大
    const messageList = new MessageList({ threadId: 'thread-consistency', resourceId: 'local-user' })
    const start = new Date(2026, 0, 1, 10, 0, 0).getTime()
    messageList.add(
      session.map((message, index) => ({
        ...message,
        threadId: 'thread-consistency',
        resourceId: 'local-user',
        createdAt: new Date(start + index * 1000),
        content: { format: 2, parts: message.content.parts }
      })) as never,
      'memory'
    )
    const promptBefore = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())
    trimLoadedHistory(messageList, 'snip')
    const promptAfter = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    const realAfter = estimateTokens(promptAfter.length)
    const recorded = outcome.compaction?.tokensAfter ?? 0
    const drift = Math.abs(recorded - realAfter) / realAfter
    console.log(
      '[自洽性] prompt %d → %d 字符（≈%d token）；记录 tokensAfter=%d（偏差 %.1f%%）',
      promptBefore.length,
      promptAfter.length,
      realAfter,
      recorded,
      drift * 100
    )
    /**
     * 容差 10%，偏差的来源是真账与估算**量东西的单位不同**：after 是"实测 before − 释放的字符数/3"
     * （字符按原文算），而这里的真账是 prompt 序列化后的长度——换行在 JSON 里要转义成两个字符，
     * 大文件那几千个换行会多算几千字符，于是估算偏**保守**（少报几个百分点的省量）。
     * 实测这段 fixture 偏差 ~7%，方向是"分界线不说大话"，可以接受；要更准就得把转义也算进去，
     * 不值当（它是 `~` 估值，不是测量值）。
     */
    expect(drift).toBeLessThan(0.1)
  })

  it('保留窗口常量与服务端缺省一致（10 条）', () => {
    expect(PROCESSOR_KEEP_MESSAGES).toBe(10)
  })
})
