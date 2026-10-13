/**
 * 导出序列化（纯函数）：一份快照装下"对话 + 轨迹 + 用量"，形状钉死在这里。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage, ThreadCompaction } from '@shared/threads'
import type { TrajectoryUsageRun } from '@shared/trajectory'
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
    cost: null,
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
    cost: 0.25,
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

const doc = buildTrajectory({ messages, usageRuns, compaction })

const NOW = new Date('2026-10-13T06:30:00.000Z')

describe('trajectoryExportPayload', () => {
  const payload = trajectoryExportPayload({
    thread: { id: 't1', title: '会话甲' },
    mode: 'duration',
    doc,
    messages,
    usageRuns,
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

  it('用量：逐一列出 + 合计；没归属进任何轮的那行也不丢', () => {
    expect(payload.usage.runs).toHaveLength(2)
    expect(payload.usage.unattributed.map((run) => run.id)).toEqual(['r0'])
    // 合计 = 该会话**全部**记账行（含没能归属进某轮的那一行；它只在 runs 里出现一次，
    // unattributed 是同一行的交叉索引，不是第二份数据）
    expect(payload.usage.totals).toEqual({ input: 110, output: 11, cachedInput: 40, cost: 0.25 })
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
      compaction
    })
    const parsed = JSON.parse(json) as Record<string, unknown>

    expect(parsed.format).toBe(TRAJECTORY_EXPORT_FORMAT)
    expect(parsed.view).toBe('turns')
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
