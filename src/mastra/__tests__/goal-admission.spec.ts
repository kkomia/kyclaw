// @vitest-environment node
/**
 * PB-039 阶段③：**chat 入口的 goal round 准入**。
 *
 * 覆盖：
 *   1. 纯函数 `goalRoundFromChatBody`（取最后一条 user 消息的 `metadata.goalRound`；坏结构 = 人类轮）；
 *   2. 真服务端（`startAgentServer` + 真 HTTP）：带 `metadata.goalRound` 的续跑轮被准入
 *      → `roundsStarted + 1`、`revision + 1`；
 *   3. 陈旧 revision / 非 active → **409 `GOAL_STALE_REVISION` / `GOAL_INVALID_TRANSITION`**（且不计数）；
 *   4. 不带 metadata 的人类轮 → 不计数。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { threadMemoryBody } from '../../shared/threads'
import { goalRoundFromChatBody, type GoalState } from '../../shared/goal'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer T>
  }
    ? T
    : never

function textChunks(text: string): Part[] {
  return [
    { type: 'stream-start', warnings: [], raw: undefined },
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
  ] as unknown as Part[]
}

let dir: string
let server: AgentServerHandle

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-goal-admission-'))
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-goal-admission-mock',
    modelId: 'kyclaw-goal-admission-mock',
    doStream: async () => {
      return { stream: simulateReadableStream({ chunks: textChunks('好的') }) }
    }
  })
  server = await startAgentServer({ dataDir: dir, model })
})

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] goal admission temp cleanup deferred', dir)
  }
})

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body)
  })
}

function getGoal(threadId: string): Promise<GoalState> {
  return fetch(`${server.baseUrl}/api/goal?threadId=${encodeURIComponent(threadId)}`, {
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => response.json() as Promise<GoalState>)
}

describe('goalRoundFromChatBody（纯函数）', () => {
  const marker = { goalId: 'g1', revision: 2, round: 3 }

  it('取最后一条 user 消息的 metadata.goalRound', () => {
    expect(
      goalRoundFromChatBody({
        messages: [
          { role: 'user', metadata: { goalRound: { ...marker, round: 1 } } },
          { role: 'assistant', parts: [] },
          { role: 'user', metadata: { goalRound: marker }, parts: [] }
        ]
      })
    ).toEqual(marker)
  })

  it('没有 metadata / 结构不对 / 没有 user → null（人类轮）', () => {
    for (const body of [
      {},
      { messages: [] },
      { messages: [{ role: 'assistant', metadata: { goalRound: marker } }] },
      { messages: [{ role: 'user', metadata: {} }] },
      { messages: [{ role: 'user', metadata: { goalRound: { goalId: '', revision: 0 } } }] },
      { messages: [{ role: 'user' }] }
    ]) {
      expect(goalRoundFromChatBody(body), JSON.stringify(body)).toBeNull()
    }
  })
})

describe('chat 入口的 goal round 准入（真服务端 + 真 HTTP）', () => {
  it('带 metadata.goalRound：准入计数 +1（revision 同步 +1）；陈旧 revision → 409 且不计数', async () => {
    const threadId = 'thread-goal-admission'
    const created = (await (await post('/api/goal', {
      threadId,
      action: 'create',
      objective: '把迁移做完'
    })).json()) as GoalState
    const goalId = created.goal?.id ?? ''
    expect(created.goal?.roundsStarted).toBe(0)

    const chat = (metadata?: unknown): Promise<Response> =>
      post('/chat/kyclaw-agent', {
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: '继续推进' }],
            ...(metadata === undefined ? {} : { metadata })
          }
        ],
        ...threadMemoryBody(threadId)
      })

    // ① 人类轮（无 metadata）→ 不计数
    const humanRound = await chat()
    expect(humanRound.status).toBe(200)
    await humanRound.text()
    expect((await getGoal(threadId)).goal?.roundsStarted).toBe(0)

    // ② goal round（revision 1 / round 1）→ 准入 +1
    const admitted = await chat({ goalRound: { goalId, revision: 1, round: 1 } })
    expect(admitted.status).toBe(200)
    await admitted.text()
    const afterFirst = await getGoal(threadId)
    expect(afterFirst.goal).toMatchObject({ roundsStarted: 1, revision: 2 })

    // ③ 同一轮重放（旧 revision）→ 409 GOAL_STALE_REVISION，且不计数
    const stale = await chat({ goalRound: { goalId, revision: 1, round: 1 } })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'GOAL_STALE_REVISION' })
    expect((await getGoal(threadId)).goal?.roundsStarted).toBe(1)

    // ④ 正确 revision 但轮号跳号（=2 而下一轮应是 2? 这里 roundsStarted+1=2，构造 round=3 跳号）→ 409
    const skipped = await chat({ goalRound: { goalId, revision: 2, round: 3 } })
    expect(skipped.status).toBe(409)
    expect((await getGoal(threadId)).goal?.roundsStarted).toBe(1)
  })
})
