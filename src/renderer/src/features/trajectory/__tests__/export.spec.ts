/**
 * 导出序列化（纯函数）：一份快照装下"对话 + 轨迹 + 用量"，形状钉死在这里。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage, ThreadCompaction } from '@shared/threads'
import type { TrajectoryRequestSummary, TrajectoryUsageRun } from '@shared/trajectory'
import { buildTrajectory } from '../model'
import {
  serializeTrajectoryExport,
  trajectoryExportFileName,
  trajectoryExportPayload,
  TRAJECTORY_EXPORT_FORMAT,
  TRAJECTORY_EXPORT_VERSION
} from '../export'

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
      ...(role === 'assistant'
        ? { metadata: { modelId: 'deepseek-flash', provider: 'deepseek.chat' } }
        : {})
    }
  } as unknown as StoredMessage
}

const messages: StoredMessage[] = [
  message('u1', 'user', 1000, [{ type: 'text', text: '你好', createdAt: 1000 }]),
  message('a1', 'assistant', 2500, [
    { type: 'text', text: '查一下', createdAt: 1200 },
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
    }
  ])
]

const usageRuns: TrajectoryUsageRun[] = [
  {
    id: 'r0',
    runId: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    input: 10,
    output: 1,
    total: 11,
    cachedInput: null,
    contextInput: null,
    contextCachedInput: null,
    stepCount: null,
    createdAt: new Date(500).toISOString()
  },
  {
    id: 'r1',
    runId: 'run-1',
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    input: 100,
    output: 10,
    total: 110,
    cachedInput: 40,
    contextInput: 900,
    contextCachedInput: 800,
    stepCount: 2,
    createdAt: new Date(1500).toISOString()
  }
]

const compaction: ThreadCompaction = {
  threadId: 't1',
  summary: '## 要点',
  summarized: 2,
  kept: 2,
  createdAt: new Date(2600).toISOString(),
  tokensBefore: 900,
  tokensAfter: 300
}

/** round 87：逐次模型请求的摘要（一步一步；正文按需取，不进导出）—— 落在第 1 轮的时间窗里 */
const requests: TrajectoryRequestSummary[] = [
  {
    id: 's1',
    runId: 'run-1',
    step: 0,
    status: 'complete',
    error: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    messageCount: 3,
    toolCount: 1,
    systemChars: 8,
    toolsChars: 43,
    truncated: false,
    createdAt: new Date(1600).toISOString()
  },
  {
    id: 's2',
    runId: 'run-1',
    step: 1,
    status: 'error',
    error: 'Bad Request',
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    messageCount: null,
    toolCount: null,
    systemChars: null,
    toolsChars: null,
    truncated: false,
    createdAt: new Date(1700).toISOString()
  }
]

const doc = buildTrajectory({ messages, usageRuns, requests, compaction })

const NOW = new Date('2026-10-13T06:30:00.000Z')

describe('trajectoryExportPayload', () => {
  const payload = trajectoryExportPayload({
    thread: { id: 't1', title: '会话甲' },
    mode: 'duration',
    doc,
    messages,
    usageRuns,
    requests,
    compaction,
    now: NOW
  })

  it('格式标识与版本在（外部工具据它认形状）', () => {
    expect(payload.format).toBe(TRAJECTORY_EXPORT_FORMAT)
    expect(payload.version).toBe(TRAJECTORY_EXPORT_VERSION)
    expect(payload.exportedAt).toBe('2026-10-13T06:30:00.000Z')
    expect(payload.view).toBe('duration')
    expect(payload.thread).toEqual({ id: 't1', title: '会话甲' })
  })

  it('三部分都在：对话原文 / 轨迹 / 用量', () => {
    expect(payload.conversation.messages).toEqual(messages)
    expect(payload.compaction).toEqual(compaction)
    expect(payload.trajectory.compactions).toBe(1)
    expect(payload.trajectory.turns).toHaveLength(1)
    expect(payload.trajectory.rows.length).toBe(doc.rows.length)
  })

  it('round 87 / v4：请求只有摘要（一步一步，含失败那次），正文给出口径说明', () => {
    expect(payload.requests.summaries).toEqual(requests)
    expect(payload.requests.note).toContain('/api/trajectory/requests/detail')
    // 与轨迹行同源：成功那次的两类行 + 失败那次的一行都在
    expect(payload.trajectory.rows.filter((row) => row.kind === 'system')).toHaveLength(1)
    expect(payload.trajectory.rows.filter((row) => row.kind === 'context')).toHaveLength(1)
    expect(payload.trajectory.rows.filter((row) => row.kind === 'error')).toHaveLength(1)
    // 行上带着请求 id：外部工具据此回本地取正文
    const systemRow = payload.trajectory.rows.find((row) => row.kind === 'system')
    expect(systemRow?.request).toEqual({
      id: 's1',
      step: 0,
      status: 'complete',
      truncated: false
    })
  })

  it('用量：逐一列出 + 合计；没归属进任何轮的那行也不丢', () => {
    expect(payload.usage.runs).toHaveLength(2)
    expect(payload.usage.unattributed.map((run) => run.id)).toEqual(['r0'])
    // 合计 = 该会话**全部**记账行（含没能归属进某轮的那一行；它只在 runs 里出现一次，
    // unattributed 是同一行的交叉索引，不是第二份数据）
    expect(payload.usage.totals).toEqual({ input: 110, output: 11, cachedInput: 40 })
    // 负向守卫：导出里没有计费口径（用户口径 014 不做计费）——v2 起 totals 也不再带 cost
    expect(payload.usage.totals).not.toHaveProperty('cost')
    expect(payload.usage.runs[1]).not.toHaveProperty('cost')
  })

  it('时刻转 ISO、拿不到的留 null（不编造 1970）', () => {
    const toolRow = payload.trajectory.rows.find((row) => row.kind === 'tool')
    expect(toolRow).toMatchObject({
      startedAt: new Date(1200).toISOString(),
      endedAt: new Date(1900).toISOString(),
      durationMs: 700,
      timingSource: 'session',
      pending: false,
      tool: {
        name: 'bash',
        callId: 'c1',
        input: '{\n  "command": "ls"\n}',
        result: '文件A'
      }
    })

    // 用户消息是瞬时事件：时刻记下来了（来源 = 会话时间戳），但本来就没有时长
    const userRow = payload.trajectory.rows.find((row) => row.kind === 'user')
    expect(userRow).toMatchObject({
      startedAt: new Date(1000).toISOString(),
      durationMs: null,
      timingSource: 'session'
    })
  })
})

describe('serializeTrajectoryExport', () => {
  it('是合法 JSON（缩进 2），解析回来与载荷一致', () => {
    const json = serializeTrajectoryExport({
      thread: { id: 't1', title: null },
      mode: 'turns',
      doc,
      messages,
      usageRuns,
      requests,
      compaction
    })
    const parsed = JSON.parse(json) as Record<string, unknown>

    expect(parsed.format).toBe(TRAJECTORY_EXPORT_FORMAT)
    expect(parsed.view).toBe('turns')
    // v4：requests 段只有摘要 + 正文口径说明（用户反馈 015 的原料）
    expect(parsed.version).toBe(4)
    expect(Object.keys(parsed.requests as Record<string, unknown>).sort()).toEqual([
      'note',
      'summaries'
    ])
    expect(json).toContain('\n  "format"')
  })
})

describe('trajectoryExportFileName', () => {
  it('文件名带会话前 8 位与本地时间戳', () => {
    const local = new Date(2026, 9, 13, 6, 30, 5)
    expect(trajectoryExportFileName('abcdef12-3456-7890', local)).toBe(
      'kyclaw-轨迹-abcdef12-20261013-063005.json'
    )
  })
})
