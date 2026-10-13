/**
 * 轨迹投影（纯函数）：原料 → 行 / 轮 / 用量的口径。
 *
 * 造的数据照**本机实测的存储形状**来（见 model.ts 头注）：
 *   - 消息列 `createdAt` 是 ISO 串（Mastra 的列）；
 *   - part 上的 `createdAt` / `updatedAt` 是 **epoch ms**；
 *   - `step-start` 出现在**下一步开始时**（起点标记），不是每一步都有；
 *   - `tool-invocation` 只有 `updatedAt`（结果落下那一刻），没有自己的 `createdAt`。
 *
 * 钉住的都是"不编造"这条线：时刻缺一头 → 时长为 null（不是 0）；没有系统提示词就不产 `系统` 行。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '@shared/threads'
import type { TrajectoryUsageRun } from '@shared/trajectory'
import { buildTrajectory, formatClock, formatDuration, searchableTextOf } from '../model'

function message(
  id: string,
  role: 'user' | 'assistant',
  createdAt: number,
  parts: unknown[]
): StoredMessage {
  return {
    id,
    role,
    createdAt: new Date(createdAt).toISOString(),
    content: {
      format: 2,
      parts,
      // 真实存储里助手消息带这份 metadata（模型 id / provider）；照实造
      ...(role === 'assistant'
        ? { metadata: { modelId: 'deepseek-flash', provider: 'deepseek.chat' } }
        : {})
    }
  } as unknown as StoredMessage
}

function usageRun(
  id: string,
  at: number,
  extra: Partial<TrajectoryUsageRun> = {}
): TrajectoryUsageRun {
  return {
    id,
    runId: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    input: 100,
    output: 10,
    total: 110,
    cachedInput: null,
    contextInput: null,
    contextCachedInput: null,
    stepCount: null,
    cost: null,
    createdAt: new Date(at).toISOString(),
    ...extra
  }
}

/** 一轮：用户问 + 助手两步（第二步带一次成功调用、一次待审批调用） */
const U1 = message('u1', 'user', 1000, [{ type: 'text', text: '你好', createdAt: 1000 }])
const A1 = message('a1', 'assistant', 2500, [
  { type: 'reasoning', reasoning: '想一下', createdAt: 1100 },
  { type: 'text', text: '我来查', createdAt: 1200 },
  {
    type: 'tool-invocation',
    toolInvocation: {
      state: 'result',
      toolName: 'bash',
      toolCallId: 'c1',
      args: { command: 'ls' },
      result: '文件A'
    },
    updatedAt: 1900
  },
  { type: 'step-start', createdAt: 2000, model: 'deepseek.chat/deepseek-flash' },
  { type: 'text', text: '好了', createdAt: 2400 },
  {
    type: 'tool-invocation',
    toolInvocation: {
      state: 'call',
      toolName: 'read_file',
      toolCallId: 'c2',
      args: { path: 'a.txt' }
    },
    updatedAt: 2450
  }
])
const U2 = message('u2', 'user', 3000, [{ type: 'text', text: '继续', createdAt: 3000 }])

describe('buildTrajectory · 行与步骤', () => {
  it('一轮 = 一条用户消息起；助手消息按 step-start 切成步，行序 = 对话先后', () => {
    const doc = buildTrajectory({ messages: [U1, A1, U2] })

    expect(doc.rows.map((row) => [row.kind, row.turn, row.step, row.index])).toEqual([
      ['user', 1, null, 0],
      ['message', 1, 1, 1],
      ['tool', 1, 1, 2],
      ['message', 1, 2, 3],
      ['tool', 1, 2, 4],
      ['user', 2, null, 5]
    ])
    expect(doc.turns.map((turn) => [turn.turn, turn.steps, turn.toolCalls])).toEqual([
      [1, 2, 2],
      [2, 0, 0]
    ])
  })

  it('步的起点 = 上一个事件的时刻（第 1 步没有 step-start，退回用户消息那一刻）；终点 = 下一步开始 / 消息写完', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const [first, second] = doc.rows.filter((row) => row.kind === 'message')

    expect(first.startedAt).toBe(1000)
    expect(first.endedAt).toBe(2000)
    expect(first.durationMs).toBe(1000)
    // 第二步：起点是 step-start 的时刻（2000），终点是消息写完（2500）
    expect(second?.startedAt).toBe(2000)
    // 终点 = 这条消息**最后一个 part** 的时刻（2450，那个待审批工具的 updatedAt），
    // 不是行 createdAt（2500）—— 行时刻是插入时刻，见 model.ts 头注
    expect(second?.endedAt).toBe(2450)
    expect(second?.durationMs).toBe(450)
    expect(first.timingSource).toBe('session')
  })

  it('助手行的正文与思考分开存：思考进 thinking，正文进 body，摘要带工具计数', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const [first, second] = doc.rows.filter((row) => row.kind === 'message')

    expect(first.body).toBe('我来查')
    expect(first.thinking).toBe('想一下')
    expect(first.text).toContain('我来查')
    expect(first.text).toContain('工具 1 个')
    // 第 1 步没有 step-start，模型 id 取消息 metadata；第 2 步取 step-start 自己记的那个
    expect(first.modelId).toBe('deepseek-flash')
    expect(second?.modelId).toBe('deepseek.chat/deepseek-flash')
  })

  it('没有系统提示词的存储里**不产** `系统` 行（不编造）', () => {
    const doc = buildTrajectory({ messages: [U1, A1, U2] })
    expect(doc.rows.some((row) => row.kind === 'system')).toBe(false)
  })
})

describe('buildTrajectory · 工具的入参 / 结果 / 时长', () => {
  it('入参与结果原样带出来（参数是 pretty JSON，结果保持原文）', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const call = doc.rows.find((row) => row.toolCallId === 'c1')

    expect(call?.toolName).toBe('bash')
    expect(call?.inputRaw).toBe('{\n  "command": "ls"\n}')
    expect(call?.outputRaw).toBe('文件A')
    expect(call?.isError).toBe(false)
    expect(call?.pending).toBe(false)
  })

  it('工具时长 = 发出调用的那一刻 → 结果落下的那一刻（都从记录的时刻倒推）', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const call = doc.rows.find((row) => row.toolCallId === 'c1')

    // 起点：同一段里紧挨在它前面的 text（1200）；终点：这一 part 的 updatedAt（1900）
    expect(call?.startedAt).toBe(1200)
    expect(call?.endedAt).toBe(1900)
    expect(call?.durationMs).toBe(700)
    expect(call?.timingSource).toBe('session')
  })

  it('还没收尾的调用标 pending 且**不给时长**（不把"还没结束"当"零耗时"）', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const pendingCall = doc.rows.find((row) => row.toolCallId === 'c2')

    expect(pendingCall?.pending).toBe(true)
    expect(pendingCall?.durationMs).toBeNull()
    // 时刻是记录下来的（起点在），只是还没有终点 —— 来源仍是"会话时间戳"，不是"未记录"
    expect(pendingCall?.timingSource).toBe('session')
    // 起点 = 同一段里紧挨在它前面的 text（2400）；终点 = 这一 part 的 updatedAt（2450）
    expect(pendingCall?.startedAt).toBe(2400)
    expect(pendingCall?.endedAt).toBe(2450)
    expect(pendingCall?.outputRaw).toBeNull()
  })

  it('失败的调用：isError 置位（其实现场就是 isError 或 output-error）', () => {
    const failing = message('a2', 'assistant', 4000, [
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'output-error',
          toolName: 'bash',
          toolCallId: 'c3',
          args: { command: 'boom' },
          errorText: '炸了'
        },
        updatedAt: 4100
      }
    ])
    const doc = buildTrajectory({ messages: [U1, failing] })
    const call = doc.rows.find((row) => row.toolCallId === 'c3')

    expect(call?.isError).toBe(true)
    expect(doc.rows.length).toBe(3)
  })
})

describe('buildTrajectory · 实测定下的三条口径', () => {
  it('消息的结束时刻取最后一个 part 的时刻：行 createdAt 更早也不当"写完的时刻"', () => {
    // 真库实测的形状：行插入在 1500，之后同一行又被追加了 part（2450）
    const appended = message('a-late', 'assistant', 1500, [
      { type: 'text', text: '先说一句', createdAt: 1600 },
      { type: 'step-start', createdAt: 2000, model: 'deepseek-flash' },
      { type: 'text', text: '再说一句', createdAt: 2400 },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'bash',
          toolCallId: 'c9',
          args: {},
          result: '好'
        },
        updatedAt: 2450
      }
    ])
    const doc = buildTrajectory({ messages: [U1, appended] })
    const [, secondStep] = doc.rows.filter((row) => row.kind === 'message')

    expect(secondStep?.endedAt).toBe(2450)
    expect(secondStep?.durationMs).toBe(450)
  })

  it('并行工具调用共享同一个起点（本段里模型最后一次说话的刻），各自终点是自己的结果', () => {
    const parallel = message('a-par', 'assistant', 2100, [
      { type: 'text', text: '两个一起查', createdAt: 1200 },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'glob',
          toolCallId: 'p1',
          args: { pattern: 'a' },
          result: '没有'
        },
        updatedAt: 1300
      },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'read',
          toolCallId: 'p2',
          args: { path: 'a' },
          result: '内容'
        },
        updatedAt: 1250
      }
    ])
    const doc = buildTrajectory({ messages: [U1, parallel] })
    const first = doc.rows.find((row) => row.toolCallId === 'p1')
    const second = doc.rows.find((row) => row.toolCallId === 'p2')

    // 两个都是 1200 起 —— 不是"上一个调用的结果时刻"（那样第二个会 1300 起、比它自己的终点还晚）
    expect(first?.startedAt).toBe(1200)
    expect(second?.startedAt).toBe(1200)
    expect(first?.durationMs).toBe(100)
    expect(second?.durationMs).toBe(50)
  })

  it('两头自相矛盾（终点早于起点）→ 时长按"未记录"算，不填 0', () => {
    const contradictory = message('a-bad', 'assistant', 2000, [
      { type: 'text', text: '说话在 1800', createdAt: 1800 },
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'bash',
          toolCallId: 'bad',
          args: {},
          result: 'x'
        },
        updatedAt: 1700
      }
    ])
    const doc = buildTrajectory({ messages: [U1, contradictory] })
    const call = doc.rows.find((row) => row.toolCallId === 'bad')

    expect(call?.startedAt).toBe(1800)
    expect(call?.endedAt).toBe(1700)
    expect(call?.durationMs).toBeNull()
    // 时刻是记录下来的（来源仍是会话时间戳），只是这两头凑不出一个时长
    expect(call?.timingSource).toBe('session')
  })

  it('步号在轮内连续：一轮落成多条助手消息时接着往下编号', () => {
    const firstHalf = message('a1a', 'assistant', 2000, [
      { type: 'text', text: '第一步', createdAt: 1200 },
      { type: 'step-start', createdAt: 1500, model: 'deepseek-flash' },
      { type: 'text', text: '第二步', createdAt: 1800 }
    ])
    const secondHalf = message('a1b', 'assistant', 4000, [
      { type: 'text', text: '第三步', createdAt: 3000 },
      { type: 'step-start', createdAt: 3200, model: 'deepseek-flash' },
      { type: 'text', text: '第四步', createdAt: 3800 }
    ])
    const doc = buildTrajectory({ messages: [U1, firstHalf, secondHalf, U2] })

    expect(doc.rows.filter((row) => row.kind === 'message').map((row) => row.step)).toEqual([
      1, 2, 3, 4
    ])
    expect(doc.turns[0]?.steps).toBe(4)
  })
})

describe('buildTrajectory · 时刻缺失', () => {
  it('part 没有时间戳 / 消息列没有 createdAt → 时长为 null、来源"未记录"', () => {
    const noTimestamps = {
      id: 'x',
      role: 'assistant',
      content: { parts: [{ type: 'text', text: '喂' }] }
    }
    const doc = buildTrajectory({
      messages: [U1, noTimestamps as unknown as StoredMessage]
    })
    const row = doc.rows.find((candidate) => candidate.body === '喂')

    expect(row?.startedAt).toBeNull()
    expect(row?.endedAt).toBeNull()
    expect(row?.durationMs).toBeNull()
    expect(row?.timingSource).toBe('none')
  })
})

describe('buildTrajectory · 轮级用量归属', () => {
  it('账的落账时刻落在哪一轮的时间窗内，就归哪一轮；早于首轮的被单独收着（不丢账）', () => {
    const doc = buildTrajectory({
      messages: [U1, A1, U2],
      usageRuns: [
        usageRun('early', 500),
        usageRun('r1', 1500, {
          input: 100,
          output: 10,
          cachedInput: 40,
          contextInput: 900,
          stepCount: 3
        }),
        usageRun('r2', 3500, { input: 200, output: 20 })
      ]
    })

    expect(doc.turns[0]?.usage).toMatchObject({
      input: 100,
      output: 10,
      cachedInput: 40,
      contextInput: 900,
      steps: 3,
      runs: 1
    })
    expect(doc.turns[1]?.usage?.input).toBe(200)
    expect(doc.unattributedUsage.map((run) => run.id)).toEqual(['early'])
    // 每一行都带"本轮用量"（同一轮的行拿同一份）
    expect(doc.rows[0]?.usage?.input).toBe(100)
    expect(doc.rows[5]?.usage?.input).toBe(200)
  })

  it('同一轮落了好几行账：合计起来、上下文大小取最后一次快照', () => {
    const doc = buildTrajectory({
      messages: [U1, A1, U2],
      usageRuns: [
        usageRun('a', 1300, { input: 100, output: 10, contextInput: 800, stepCount: 2, cost: 0.5 }),
        usageRun('b', 1500, {
          input: 300,
          output: 20,
          contextInput: 4200,
          stepCount: 5,
          cost: 0.25
        })
      ]
    })

    expect(doc.turns[0]?.usage).toMatchObject({
      input: 400,
      output: 30,
      contextInput: 4200,
      steps: 7,
      cost: 0.75,
      runs: 2
    })
  })

  it('没记过账的会话：用量是 null（不是 0）', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    expect(doc.turns[0]?.usage).toBeNull()
    expect(doc.rows[0]?.usage).toBeNull()
  })
})

describe('buildTrajectory · 压缩记录', () => {
  it('压缩折成一条"轮次之间"的行，按时刻插回时间序', () => {
    const doc = buildTrajectory({
      messages: [U1, A1, U2],
      compaction: {
        threadId: 't1',
        summary: '## 要点\n- 聊了天',
        summarized: 2,
        kept: 2,
        createdAt: new Date(2800).toISOString(),
        tokensBefore: 900,
        tokensAfter: 300
      }
    })

    const index = doc.rows.findIndex((row) => row.kind === 'compacted')
    expect(index).toBeGreaterThan(-1)
    expect(doc.rows[index]?.turn).toBeNull()
    expect(doc.rows[index]?.body).toBe('## 要点\n- 聊了天')
    expect(doc.rows[index]?.text).toBe('已摘要 2 条 · 保留 2 条')
    // 2800 落在 u2（3000）之前 → 插在 u2 之前
    expect(doc.rows[index + 1]?.kind).toBe('user')
    // index 重排后仍连续
    expect(doc.rows.map((row) => row.index)).toEqual(doc.rows.map((_, position) => position))
    expect(doc.compactions).toBe(1)
  })

  it('没有压缩记录：compactions = 0、不多出行', () => {
    const doc = buildTrajectory({ messages: [U1] })
    expect(doc.compactions).toBe(0)
    expect(doc.rows).toHaveLength(1)
  })

  it('round 76：轨迹文案也按档分（精简 / 去重 / 折叠 / 摘要），来源一栏跟着档位走', () => {
    const base = {
      threadId: 't1',
      summary: '这次没有调用模型：把较早那几段已经结束的对话折成了折叠说明。',
      summarized: 3,
      kept: 2,
      createdAt: new Date(2800).toISOString(),
      tokensBefore: 900,
      tokensAfter: 300
    }
    const cases = [
      ['snip', '已精简 3 条 · 保留 2 条', '精简'],
      ['dedupe', '已去重 3 条 · 保留 2 条', '去重'],
      ['fold', '已折叠 3 条 · 保留 2 条', '折叠'],
      ['summary', '已摘要 3 条 · 保留 2 条', '压缩']
    ] as const

    for (const [level, text, source] of cases) {
      const doc = buildTrajectory({
        messages: [U1, A1, U2],
        compaction: { ...base, level }
      })
      const row = doc.rows.find((item) => item.kind === 'compacted')
      expect(row?.text).toBe(text)
      expect(row?.source).toBe(source)
    }
    // 老记录（没有 level）照旧是摘要档的文案
    const legacy = buildTrajectory({ messages: [U1], compaction: base })
    expect(legacy.rows.find((item) => item.kind === 'compacted')?.text).toBe(
      '已摘要 3 条 · 保留 2 条'
    )
  })
})

describe('格式化与可搜文本', () => {
  it('时长：<1s 走毫秒、否则走秒；没有时长 = null', () => {
    expect(formatDuration(0)).toBe('0 毫秒')
    expect(formatDuration(640)).toBe('640 毫秒')
    expect(formatDuration(1500)).toBe('1.50 秒')
    expect(formatDuration(25_000)).toBe('25.0 秒')
    expect(formatDuration(null)).toBeNull()
  })

  it('时刻：HH:MM:SS.mmm（本地时区）；没有 = null', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5, 678).getTime()
    expect(formatClock(at)).toBe('03:04:05.678')
    expect(formatClock(null)).toBeNull()
  })

  it('可搜文本含类型词、工具名、入参与"第 N 轮"', () => {
    const doc = buildTrajectory({ messages: [U1, A1] })
    const call = doc.rows.find((row) => row.toolCallId === 'c1')
    const text = searchableTextOf(call!)

    expect(text).toContain('工具')
    expect(text).toContain('bash')
    expect(text).toContain('command')
    expect(text).toContain('第 1 轮')
  })
})

/**
 * round 75「渐进披露」：MCP 每台 server 只剩一个元工具 `mcp__<serverId>__meta`，
 * 真调用长成 `{action:'call', tool, args}`。轨迹行是人看的账，得说真名与真入参 ——
 * 否则导出的文档里全是 `mcp__x__meta` 和那层壳。
 */
describe('轨迹行：MCP 元工具解包（round 75）', () => {
  function metaMessage(id: string, tool: string, args: unknown, toolCallId: string): StoredMessage {
    return message(id, 'assistant', 1500, [
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolName: 'mcp__mcp-1__meta',
          toolCallId,
          args: { action: 'call', tool, args },
          result: 'ok'
        },
        updatedAt: 1500
      }
    ])
  }

  it('call → 行上的工具名是真名、入参是真入参', () => {
    const doc = buildTrajectory({
      messages: [U1, metaMessage('a9', 'search', { query: 'kyclaw' }, 'c9')]
    })
    const row = doc.rows.find((item) => item.toolCallId === 'c9')!

    expect(row.toolName).toBe('mcp__mcp-1__search')
    expect(row.inputRaw).toBe('{\n  "query": "kyclaw"\n}')
    expect(row.text).toContain('mcp__mcp-1__search')
    expect(row.text).not.toContain('mcp__mcp-1__meta')
    expect(row.text).not.toContain('"action"')
    // raw（明细页 / 导出用的原始 JSON）里的 args 也是真入参
    expect(row.raw ?? '').toContain('"query": "kyclaw"')
    expect(row.raw ?? '').not.toContain('mcp__mcp-1__meta')
    expect(searchableTextOf(row)).toContain('kyclaw')
  })

  it('list 档 / 非元工具一行不变（不认识就不猜）', () => {
    const listDoc = buildTrajectory({
      messages: [
        U1,
        message('a8', 'assistant', 1500, [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolName: 'mcp__mcp-1__meta',
              toolCallId: 'c8',
              args: { action: 'list' },
              result: '…'
            },
            updatedAt: 1500
          }
        ])
      ]
    })
    const listRow = listDoc.rows.find((item) => item.toolCallId === 'c8')!
    expect(listRow.toolName).toBe('mcp__mcp-1__meta')
    expect(listRow.inputRaw).toBe('{\n  "action": "list"\n}')

    // 逐件注入的 MCP 工具（不是元工具）：照旧
    const injected = buildTrajectory({
      messages: [
        U1,
        message('a7', 'assistant', 1500, [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolName: 'mcp__mcp-2__echo',
              toolCallId: 'c7',
              args: { msg: 'hi' },
              result: 'hi'
            },
            updatedAt: 1500
          }
        ])
      ]
    })
    const row = injected.rows.find((item) => item.toolCallId === 'c7')!
    expect(row.toolName).toBe('mcp__mcp-2__echo')
    expect(row.inputRaw).toBe('{\n  "msg": "hi"\n}')
  })
})
