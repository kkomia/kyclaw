// @vitest-environment node
/**
 * round 76 · 压缩分级（B）：**第三档 `fold`（折叠）**——把"不活跃的段落"折成一行摘要。
 *
 * 四块证据：
 *   1. 纯规则：折叠说明三件事齐全（折了几条 / 讲的是什么 / **怎么恢复**）、正文摘要由本地规则
 *      生成（第一句 + 截断）、不调模型；
 *   2. 段与改写（纯函数）：段 = 连续的助手消息，**用户的每条原话是墙**（永不被折、逐条同一性）；
 *      段内正文合计不够不折、**未收尾的工具调用所在段不折**（等审批 = 现场）；折后消息条数不变、
 *      顺序不变、工具 part 原样、输入对象一个字节不改；
 *   3. 服务决策（**红→绿的核心**）：上一档停在 dedupe 的会话，旧段里只有"一大段已经结束的长正文"
 *      → compact() 停在 `fold`：摘要模型**一次都不调**、消息一条不删、usage 一行不记；
 *      **旧实现（只有 snip/dedupe 两档）在这里会直接去付摘要那一次调用**（nextMechanicalLevel
 *      在 dedupe 上返回 null）——这就是这条用例的红。
 *   4. 注入处理器（真 MessageList）：fold 档下模型这一轮收到的 prompt 里，那几段长正文已换成
 *      折叠说明（深处与结尾的字都不在了），而**存储/界面那一份一字未动**、用户原话仍在、
 *      消息条数与顺序不变。
 *
 * 口径与边界见 src/mastra/compaction.ts 头注（"压缩分级"与 `fold` 档边界那两段）。
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageList } from '@mastra/core/agent'
import {
  buildTranscript,
  compactionLevelOf,
  COMPACT_MAX_OUTPUT_TOKENS,
  createCompactionProcessor,
  createCompactionService,
  estimateTokens,
  FOLD_DIGEST_MAX_CHARS,
  FOLD_MARKER,
  FOLD_MIN_SEGMENT_CHARS,
  foldDigest,
  foldPlaceholder,
  foldStage,
  liveCharsOf,
  mechanicalDecision,
  mechanicalPrefix,
  mechanicalStage,
  mechanicalSummaryText,
  MECHANICAL_MIN_FREED_TOKENS,
  nextMechanicalLevel,
  recordLevelOf,
  trimLoadedHistory,
  type CompactionMemory,
  type CompactionStore
} from '../compaction'
import {
  compactionLevels,
  threadCompactionResponseSchema,
  type ThreadCompaction
} from '../../shared/threads'
import type { UsageRun, UsageStore } from '../usage'

/* ─────────────────────────────── 夹具 ─────────────────────────────── */

interface Fixture {
  id: string
  role: string
  content: { parts: unknown[] }
}

function userMsg(id: string, text: string): Fixture {
  return { id, role: 'user', content: { parts: [{ type: 'text', text }] } }
}

function assistantText(id: string, text: string): Fixture {
  return { id, role: 'assistant', content: { parts: [{ type: 'text', text }] } }
}

/** 一条工具结果消息（v2 形状；state 可换，用来造"还没收尾"的段） */
function toolMsg(
  id: string,
  toolName: string,
  args: unknown,
  result: string,
  state = 'result'
): Fixture {
  return {
    id,
    role: 'assistant',
    content: {
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: { state, toolCallId: `c-${id}`, toolName, args, result }
        }
      ]
    }
  }
}

/**
 * 一段"已经结束的长正文"：像助手写完一篇分析那样多行、末尾有独特标记
 * （"被折掉的深处与结尾"靠它断言——开头那句会留在折叠说明的摘要里）。
 */
function longAnswer(label: string, chars: number): string {
  const head = `${label}：我把这一段实现从头看了一遍，结论是先把零成本的三档做完再考虑摘要。`
  const body: string[] = []
  let size = head.length
  let index = 1
  while (size < chars) {
    const line = `\n${label} 细节第 ${index} 条：${'x'.repeat(60)}`
    body.push(line)
    size += line.length
    index += 1
  }
  return `${head}${body.join('')}\n${label}-TAIL-结尾标记`
}

/** 折叠说明里"怎么恢复"点名的文件（从工具入参里认出来） */
function readMsg(id: string, path: string, result = '（略）'): Fixture {
  return toolMsg(id, 'read', { path }, result)
}

/**
 * 一段"多轮已结束话题"的旧会话（14 条，全是助手长正文 + 用户短问，没有任何大工具结果、
 * 也没有重复结果）——snip/dedupe 在这里省不下东西，只有 fold 有活干。
 */
const ANSWER_CHARS = 3_600

function talkyOlder(): Fixture[] {
  return [
    userMsg('u1', '先看看压缩实现'),
    assistantText('a2', longAnswer('A', ANSWER_CHARS)),
    userMsg('u3', '那分界线呢'),
    assistantText('a4', longAnswer('B', ANSWER_CHARS)),
    userMsg('u5', '嗯'),
    assistantText('a6', longAnswer('C', ANSWER_CHARS)),
    userMsg('u7', '好'),
    assistantText('a8', longAnswer('D', ANSWER_CHARS)),
    userMsg('u9', '明白了'),
    assistantText('a10', longAnswer('E', ANSWER_CHARS)),
    userMsg('u11', '继续'),
    assistantText('a12', longAnswer('F', ANSWER_CHARS)),
    userMsg('u13', '行'),
    assistantText('a14', longAnswer('G', ANSWER_CHARS))
  ]
}

/** 保留窗口（最近 10 条：当前任务现场，一条都不能动） */
function keptWindow(): Fixture[] {
  return [
    userMsg('k1', '现在改一下折叠'),
    assistantText('k2', '好，我改。'),
    userMsg('k3', '继续'),
    assistantText('k4', '嗯。'),
    userMsg('k5', '再看一眼'),
    assistantText('k6', '看过了。'),
    userMsg('k7', '行'),
    assistantText('k8', '好。'),
    userMsg('k9', '最后一问'),
    assistantText('k10', '答。')
  ]
}

const OLDER = talkyOlder()
const SESSION = [...OLDER, ...keptWindow()]
/** 旧段里的助手正文合计（fold 的"活"体积就是它） */
const OLDER_TEXT_CHARS = OLDER.filter((message) => message.role === 'assistant').reduce(
  (sum, message) => sum + textOf(message).length,
  0
)

function textOf(message: Fixture): string {
  return message.content.parts
    .flatMap((part) => {
      const typed = part as { type?: string; text?: string }
      return typed.type === 'text' && typeof typed.text === 'string' ? [typed.text] : []
    })
    .join('')
}

function fakeMemory(messages: readonly { id: string }[]): {
  memory: CompactionMemory
  deleteMessages: ReturnType<typeof vi.fn>
} {
  const deleteMessages = vi.fn(async () => undefined)
  return {
    memory: {
      recall: vi.fn(async () => ({ messages })),
      deleteMessages
    } as unknown as CompactionMemory,
    deleteMessages
  }
}

function memoryStore(seed: ThreadCompaction[] = []): CompactionStore {
  const records = new Map(seed.map((record) => [record.threadId, record]))
  return {
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

/** 上一次停在 dedupe（snip 与 dedupe 都已开着）——本轮该从 fold 起算 */
function previousAtDedupe(threadId: string): ThreadCompaction {
  return {
    threadId,
    summary: '上一次没有调用模型：把较早的工具结果精简/去重了一遍。',
    summarized: 5,
    kept: 10,
    level: 'dedupe',
    createdAt: new Date(2026, 9, 13, 9, 0, 0).toISOString(),
    tokensBefore: 60_000,
    tokensAfter: 21_000
  }
}

const MEASURED_BEFORE = 26_400
const BASELINE = 9_000

/* ───────────────────────── 1. 纯规则：折叠说明与摘要行 ───────────────────────── */

describe('fold 的折叠说明（本地规则，不调模型）', () => {
  it('一句话摘要是"第一句 + 截断"：换行压平、遇句号断、超长加省略号', () => {
    expect(foldDigest('第一句。第二句。')).toBe('第一句。')
    expect(foldDigest('这里\n换行了，还是同一句\n继续')).toBe('这里 换行了，还是同一句 继续')
    const long = foldDigest(`开头${'很长的内容'.repeat(60)}`)
    expect(long.length).toBe(FOLD_DIGEST_MAX_CHARS + 1)
    expect(long.endsWith('…')).toBe(true)
    expect(foldDigest('   ')).toBe('')
  })

  it('说明三件事齐全：折了几条消息、这一段讲的是什么、**怎么恢复**', () => {
    const text = foldPlaceholder({
      count: 3,
      textChars: 9_800,
      digest: '我把压缩实现从头看了一遍。',
      toolNames: ['read', 'bash'],
      fileHints: ['src/mastra/compaction.ts']
    })

    expect(text).toContain(FOLD_MARKER)
    expect(text).toContain('这里折了 3 条消息')
    expect(text).toContain('我把压缩实现从头看了一遍。')
    // 恢复路径：重新读哪条 / 让它重新展开的条件
    expect(text).toContain('src/mastra/compaction.ts')
    expect(text).toContain('重新展开')
    // 原文去哪了：说清"没删、还在用户的对话记录里"
    expect(text).toContain('一条消息都没有删除')
    expect(text).toContain('用户的对话记录')
    // 没有文件线索时也要有兜底的恢复说法
    const noHints = foldPlaceholder({
      count: 1,
      textChars: 2_000,
      digest: '随便聊了聊。',
      toolNames: [],
      fileHints: []
    })
    expect(noHints).toContain('重新展开')
    expect(noHints.length).toBeLessThan(400)
    console.log('[fold 说明原文]\n%s', text)
  })
})

/* ─────────────────────── 2. 段与改写（纯函数，不改输入） ─────────────────────── */

describe('fold 的段：用户原话是墙，未收尾的段不折', () => {
  it('把一段已经结束的长正文折成一行说明；用户消息、工具结果原样，条数与顺序不变', () => {
    const messages: Fixture[] = [
      readMsg('t1', 'src/a.ts', 'y'.repeat(2_000)),
      assistantText('a2', longAnswer('A', 4_000)),
      assistantText('a3', longAnswer('B', 4_000))
    ]
    const before = JSON.stringify(messages)
    const stage = foldStage(messages)

    // 输入一个字节都没被改（纯函数）
    expect(JSON.stringify(messages)).toBe(before)
    // 段 = a2 + a3（连续助手消息）：两条都被改写
    expect(stage.rewritten).toBe(2)
    // 工具结果那条不在这段里（它是独立的助手消息，但没有任何正文）→ 原样、同一性保留
    expect(stage.messages[0]).toBe(messages[0])
    // 段里第一条：正文换成折叠说明
    expect(textOf(stage.messages[1] as Fixture)).toContain(FOLD_MARKER)
    expect(textOf(stage.messages[1] as Fixture)).toContain('这里折了 2 条消息')
    // 摘要来自第一句（本地规则），深处与结尾不在说明里（真被折掉了）
    expect(textOf(stage.messages[1] as Fixture)).toContain('我把这一段实现从头看了一遍')
    expect(textOf(stage.messages[1] as Fixture)).not.toContain('A 细节第 1 条')
    expect(textOf(stage.messages[1] as Fixture)).not.toContain('A-TAIL-结尾标记')
    // 段里第二条：正文折掉（一条 part 都不剩 → 补指路标记，不让空消息进 prompt）
    expect(textOf(stage.messages[2] as Fixture)).toContain('已折叠')
    // 释放量是真数（两段正文 − 说明 − 指路标记）
    expect(stage.freedChars).toBeGreaterThan(7_000)
    expect(stage.beforeChars).toBeGreaterThan(8_000)
  })

  it('用户的每条原话永不被折（逐条同一性），它是段与段之间的墙', () => {
    const messages = [userMsg('u1', '这是用户原话'), assistantText('a2', longAnswer('A', 3_000))]
    const stage = foldStage(messages)
    expect(stage.messages[0]).toBe(messages[0])
    expect(textOf(messages[0])).toBe('这是用户原话')
  })

  it('段内正文合计不够长 → 不折（几百字的段折了也是噪音）', () => {
    const short = assistantText('a1', '好。'.repeat(Math.floor(FOLD_MIN_SEGMENT_CHARS / 4)))
    expect(textOf(short).length).toBeLessThan(FOLD_MIN_SEGMENT_CHARS)
    const stage = foldStage([short])
    expect(stage.rewritten).toBe(0)
    expect(stage.messages[0]).toBe(short)
  })

  it('段里有还没收尾的工具调用（等审批 / 半截）→ 这一段是现场，不折', () => {
    const pending = toolMsg('t1', 'write', { path: 'a.txt' }, '', 'call')
    const messages = [pending, assistantText('a2', longAnswer('A', 4_000))]
    const stage = foldStage(messages)
    // 没有 tool-invocation 的那一条也在同一段里 → 整段一起放过（"不活跃"不成立）
    expect(stage.rewritten).toBe(0)
    expect(stage.messages[1]).toBe(messages[1])
  })

  it('折掉正文后带工具调用的消息仍然可用：工具 part 原样留在这一轮里', () => {
    const messages = [
      toolMsg('t1', 'read', { path: 'src/mastra/compaction.ts' }, 'z'.repeat(300)),
      assistantText('a2', longAnswer('A', 3_000)),
      assistantText('a3', longAnswer('B', 3_000))
    ]
    const stage = foldStage(messages)

    const folded = stage.messages[1] as Fixture
    expect(textOf(folded)).toContain('这里折了 2 条消息')
    // 工具那条（y 结果）不在这一段里，原样
    expect(JSON.stringify(stage.messages[0])).toContain('z'.repeat(50))
    // 折叠说明里点名了"重新读哪条"（从工具入参里认出来的文件）
    expect(textOf(folded)).toContain('src/mastra/compaction.ts')
  })

  it('liveCharsOf 与 fold 的 beforeChars 同一口径（正文 + 工具结果）', () => {
    const messages = [
      toolMsg('t1', 'read', {}, 'x'.repeat(100)),
      assistantText('a2', 'y'.repeat(50))
    ]
    expect(liveCharsOf(messages)).toBe(150)
    expect(foldStage(messages).beforeChars).toBe(150)
  })
})

/* ───────────── 3. 服务决策：够省就停在 fold（红→绿核心） ───────────── */

describe('压缩分级：第三档 fold —— 不活跃的长正文够省就不调摘要模型', () => {
  const model = { modelId: 'deepseek-flash', provider: 'deepseek' } as never
  const resolveModel = async (): Promise<never> => model

  it('【核心】上一档停在 dedupe + 旧段是一大段已结束的长正文 → 停在 fold：不调模型、不删消息、不记账', async () => {
    const { memory, deleteMessages } = fakeMemory(SESSION)
    const store = memoryStore([previousAtDedupe('thread-fold')])
    const usage = fakeUsageStore()
    // 摘要模型带实现：这一版**不该走到它**——真走了下面第一条断言就会报"Number of calls: 1"
    // （那正是"只有 snip/dedupe 两档"的旧实现会走的路：nextMechanicalLevel(dedupe) = null）
    const generate = vi.fn(async () => ({ text: '## 要点\n- 这段不该被摘要' }))
    const service = createCompactionService({
      memory,
      store,
      resolveModel,
      generate,
      usage,
      usageOf: async () => ({ lastInput: MEASURED_BEFORE, baselineInput: BASELINE })
    })

    const outcome = await service.compact('thread-fold')

    // ① 没有付钱：摘要模型一次都没被调用（旧实现在这里失败）
    expect(generate).not.toHaveBeenCalled()
    expect(usage.runs).toEqual([])
    // ② 一条消息都没删（用户原话与助手正文都还在存储里）
    expect(deleteMessages).not.toHaveBeenCalled()
    // ③ 记录：档位 + 这次的省法 + 双读数
    const record = outcome.compaction
    expect(record?.level).toBe('fold')
    // 7 条助手长正文（每段 1 条）都被折
    expect(record?.summarized).toBe(7)
    expect(record?.kept).toBe(10)
    expect(record?.tokensBefore).toBe(MEASURED_BEFORE)
    expect(record?.tokensAfter).toBeLessThan(record?.tokensBefore ?? 0)
    expect(record?.summary).toContain('没有调用模型')
    expect(record?.summary).toContain('折')
    expect((await store.get('thread-fold'))?.level).toBe('fold')

    // ④ 真数字：释放了多少字符 / 估算 token；这一档省掉了哪一次调用
    //    tokensAfter 的口径是"实测 before − 本档释放的估算 token"，这里按同一个公式对一遍账
    const staged = foldStage(OLDER)
    expect(record?.summarized).toBe(staged.rewritten)
    expect(record?.tokensAfter).toBe(MEASURED_BEFORE - estimateTokens(staged.freedChars))
    // 摘要那版要付的钱：按**真实素材口径**（buildTranscript）算一次输入，输出上限走常量
    const material = buildTranscript(OLDER)
    console.log(
      '[fold 实测] 旧段助手正文合计 %d 字符；被折 %d 条；释放 %d 字符 ≈ %d token；记录 %d → %d；摘要模型调用 0 次（省下 1 次摘要调用：素材 %d 字符 ≈ %d input token + 最多 %d output token）',
      OLDER_TEXT_CHARS,
      record?.summarized,
      staged.freedChars,
      estimateTokens(staged.freedChars),
      record?.tokensBefore,
      record?.tokensAfter,
      material.length,
      estimateTokens(material.length),
      COMPACT_MAX_OUTPUT_TOKENS
    )
  })

  it('【负向】旧段没有长正文（只有短问答与工具结果）→ fold 停不住 → 回落摘要：这次真的调了模型', async () => {
    const session = [
      ...Array.from({ length: 14 }, (_, index) =>
        index % 2 === 0
          ? userMsg(`u${index}`, `第 ${index} 问`)
          : toolMsg(`t${index}`, 'read', { path: 'a.txt' }, 'w'.repeat(300))
      ),
      ...keptWindow()
    ]
    const { memory, deleteMessages } = fakeMemory(session)
    const store = memoryStore([previousAtDedupe('thread-no-fold')])
    const generate = vi.fn(async () => ({ text: '## 要点\n- 没什么可折的' }))
    const service = createCompactionService({ memory, store, resolveModel, generate })

    const outcome = await service.compact('thread-no-fold')

    expect(generate).toHaveBeenCalledTimes(1)
    expect(outcome.compaction?.level).toBe('summary')
    expect(deleteMessages).toHaveBeenCalledTimes(1)
  })

  it('通过线按"从上一档之后累加"算：这一档自己不够、加上前一档就够 → 停在它', () => {
    // 上一档停在 snip → 这一轮从 dedupe 起算；造一段"去重省一点 + 折叠再省一点"的旧段
    const duplicated = 'd'.repeat(3_000)
    const repeated = 'e'.repeat(3_000)
    const session: Fixture[] = [
      toolMsg('t1', 'read', { path: 'a.ts' }, duplicated),
      toolMsg('t2', 'read', { path: 'a.ts' }, duplicated),
      toolMsg('t3', 'read', { path: 'b.ts' }, repeated),
      toolMsg('t4', 'read', { path: 'b.ts' }, repeated),
      userMsg('u1', '继续'),
      assistantText('a1', longAnswer('A', 1_600)),
      userMsg('u2', '嗯'),
      assistantText('a2', longAnswer('B', 1_600)),
      userMsg('u3', '好'),
      assistantText('a3', longAnswer('C', 1_600)),
      userMsg('u4', '行'),
      assistantText('a4', longAnswer('D', 1_600))
    ]
    const previous: ThreadCompaction = {
      ...previousAtDedupe('t-line'),
      level: 'snip'
    }

    // 逐档量一遍（与 mechanicalDecision 内部同一套函数）：这一档自己不够，累计才够
    const snip = mechanicalStage(session, 'snip')
    const dedupe = mechanicalStage(snip.messages, 'dedupe')
    const fold = mechanicalStage(dedupe.messages, 'fold')
    expect(estimateTokens(fold.freedChars)).toBeLessThan(MECHANICAL_MIN_FREED_TOKENS)
    expect(estimateTokens(dedupe.freedChars + fold.freedChars)).toBeGreaterThanOrEqual(
      MECHANICAL_MIN_FREED_TOKENS
    )

    const decision = mechanicalDecision(session, previous)
    expect(decision?.level).toBe('fold')
    // 本次新启用的条数 = 去重 + 折叠（snip 上次已经开着，不算这一轮的"新启用"）
    expect(decision?.rewritten).toBe(dedupe.rewritten + fold.rewritten)
    console.log(
      '[fold 累加口径] dedupe 释放 %d 字符（≈%d token）+ fold 释放 %d 字符（≈%d token）→ 累计 ≈%d token ≥ 通过线 %d',
      dedupe.freedChars,
      estimateTokens(dedupe.freedChars),
      fold.freedChars,
      estimateTokens(fold.freedChars),
      estimateTokens(dedupe.freedChars + fold.freedChars),
      MECHANICAL_MIN_FREED_TOKENS
    )
  })

  it('链序：snip → dedupe → fold → null（四档顺序在记录里读得出来）', () => {
    const base = previousAtDedupe('t-chain')
    expect(nextMechanicalLevel(null)).toBe('snip')
    expect(nextMechanicalLevel({ ...base, level: 'snip' })).toBe('dedupe')
    expect(nextMechanicalLevel(base)).toBe('fold')
    expect(nextMechanicalLevel({ ...base, level: 'fold' })).toBeNull()
    expect(nextMechanicalLevel({ ...base, level: 'summary' })).toBe('snip')
    // 老行（没有 level）读出来仍是 summary（那时只有摘要这一条路）
    expect(recordLevelOf(null)).toBe('summary')
    expect(recordLevelOf({ ...base, level: undefined })).toBe('summary')
    expect(recordLevelOf(base)).toBe('dedupe')
    // 读侧归一：fold 认得出来，脏值仍归 summary（不编造没走过的档位）
    expect(compactionLevelOf('fold')).toBe('fold')
    expect(compactionLevelOf('snip')).toBe('snip')
    expect(compactionLevelOf(null)).toBe('summary')
    expect(compactionLevelOf('folded')).toBe('summary')
  })

  it('shared 契约：fold 是合法档位（过 schema），认不出的档位照旧被拒', () => {
    expect(compactionLevels).toEqual(['snip', 'dedupe', 'fold', 'summary'])
    const compaction = {
      threadId: 't-fold-contract',
      summary: '这次没有调用模型：把较早那几段已经结束的对话折成了折叠说明',
      summarized: 3,
      kept: 10,
      level: 'fold' as const,
      createdAt: new Date(2026, 9, 13, 10, 0, 0).toISOString(),
      tokensBefore: 26_400,
      tokensAfter: 12_000
    }
    const parsed = threadCompactionResponseSchema.parse({ compaction })
    expect(parsed.compaction?.level).toBe('fold')
    expect(() =>
      threadCompactionResponseSchema.parse({ compaction: { ...compaction, level: '折叠' } })
    ).toThrow()
  })

  it('记录的人话文案按档分：fold 档说清"折了什么、怎么拿回来"', () => {
    const text = mechanicalSummaryText({ level: 'fold', rewritten: 7, freedChars: 24_000 })
    expect(text).toContain('没有调用模型')
    expect(text).toContain('7 条消息')
    expect(text).toContain('折叠说明')
    expect(text).toContain('一条消息都没有删除')
    expect(text).toContain('重新')
    // 三档的前缀各自说自己的那一档
    expect(mechanicalPrefix('snip')).toContain('工具结果')
    expect(mechanicalPrefix('dedupe')).toContain('含重复项')
    expect(mechanicalPrefix('fold')).toContain('助手正文')
    expect(mechanicalPrefix('fold')).toContain('重新展开')
  })
})

/* ─────────── 4. 注入处理器：模型看到折叠说明，存储里原文一字未动 ─────────── */

describe('注入处理器：fold 改的是"这一轮发给模型的那份"', () => {
  const THREAD_ID = 'thread-fold-proc'

  function listWith(session: Fixture[]): { messageList: MessageList; session: Fixture[] } {
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
    messageList.add(
      [
        {
          id: 'live-1',
          role: 'user',
          threadId: THREAD_ID,
          resourceId: 'local-user',
          createdAt: new Date(start + session.length * 1000),
          content: { format: 2, parts: [{ type: 'text', text: '这一轮的新问题' }] }
        }
      ] as never,
      'input'
    )
    return { messageList, session }
  }

  async function runProcessor(messageList: MessageList, record: ThreadCompaction): Promise<void> {
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

  const foldRecord: ThreadCompaction = {
    threadId: THREAD_ID,
    summary: '这次没有调用模型：把较早那几段已经结束的对话折成了折叠说明。',
    summarized: 7,
    kept: 10,
    level: 'fold',
    createdAt: new Date(2026, 0, 1, 12, 0, 0).toISOString(),
    tokensBefore: MEASURED_BEFORE,
    tokensAfter: 12_000
  }

  it('prompt 里那几段长正文换成折叠说明、用户原话与保留窗口原样、条数与顺序不变', async () => {
    const { messageList, session } = listWith(SESSION)
    const promptBefore = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    await runProcessor(messageList, foldRecord)
    const promptAfter = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    // ① 长正文真的不在这一轮 prompt 里了（深处与结尾都消失，只留第一句摘要）
    expect(promptBefore).toContain('A-TAIL-结尾标记')
    expect(promptAfter).not.toContain('A-TAIL-结尾标记')
    expect(promptAfter).not.toContain('A 细节第 1 条')
    // ② 折叠说明进了 prompt：模型知道这里折了什么、怎么恢复
    expect(promptAfter).toContain(FOLD_MARKER)
    expect(promptAfter).toContain('这里折了 1 条消息')
    expect(promptAfter).toContain('我把这一段实现从头看了一遍')
    expect(promptAfter).toContain('重新展开')
    // ③ 用户原话一字未动
    for (const message of session.filter((item) => item.role === 'user')) {
      expect(promptAfter).toContain(textOf(message))
    }
    // ④ 保留窗口里的正文没被碰（当前任务现场）
    expect(promptAfter).toContain('现在改一下折叠')
    expect(promptAfter).toContain('答。')
    // ⑤ 一行说明也进了系统消息
    expect(promptAfter).toContain(mechanicalPrefix('fold').slice(0, 12))
    // ⑥ prompt 体积真的小了（真数字）
    expect(promptAfter.length).toBeLessThan(promptBefore.length)
    console.log(
      '[fold 处理器实测] 这一轮 prompt（模型看到的）%d 字符 → %d 字符，省下约 %d token（估算）',
      promptBefore.length,
      promptAfter.length,
      estimateTokens(promptBefore.length - promptAfter.length)
    )
  })

  it('存储/界面的原文一字未动：会话消息对象没被改写，顺序也没变', async () => {
    const { messageList, session } = listWith(SESSION)
    const before = JSON.stringify(session)

    await runProcessor(messageList, foldRecord)

    // 交给处理器的那些消息对象（= 存储层的这一份）没被改过
    expect(JSON.stringify(session)).toBe(before)
    expect(JSON.stringify(session)).toContain('A-TAIL-结尾标记')
    // 消息列的顺序不变（折叠不许把消息挪位置、也不许删）
    expect(
      messageList.get.all
        .db()
        .map((message) => message.id)
        .join(',')
    ).toBe([...session.map((message) => message.id), 'live-1'].join(','))
    // 被折叠的那些消息仍是"存储来源"，不会被当成待落库再存一遍（轮末只落本轮新发的那条）
    expect(messageList.getPersisted.input.db().map((message) => message.id)).toEqual(['live-1'])
  })

  it('trimLoadedHistory 在 fold 档返回被改写的条数（各档累计；0 = 没什么可折）', () => {
    const { messageList } = listWith(SESSION)
    expect(trimLoadedHistory(messageList, 'fold')).toBe(7)

    const plain = listWith(keptWindow()).messageList
    expect(trimLoadedHistory(plain, 'fold')).toBe(0)
  })

  it('summary 档（老路）不受影响：只加系统前缀，正文一个字节都不动', async () => {
    const { messageList } = listWith(SESSION)
    await runProcessor(messageList, {
      ...foldRecord,
      level: 'summary',
      summary: '## 要点\n- 聊过压缩'
    })
    const prompt = JSON.stringify(await messageList.get.all.aiV7.llmPrompt())

    expect(prompt).toContain('聊过压缩')
    // 摘要档不折叠：长正文照旧进 prompt
    expect(prompt).toContain('A-TAIL-结尾标记')
    expect(prompt).not.toContain(FOLD_MARKER)
  })
})
