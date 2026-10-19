import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetThreadChats } from '../thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { ChatSession } from '../ChatPage'
import { createMockTransport } from './mock-transport'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-039 `/goal` 提交路径（真 GOAL API 用 fetch stub）：
 *   - `/goal` 不进聊天历史（mock transport 一次请求都不发）；
 *   - 六行卡片渲染在输入框上方，关闭后状态不丢（再输入 `/goal` 还能查）；
 *   - 409 GOAL_STALE_REVISION → 重 GET → 用最新 revision 重发一次（卡片显示成功）。
 */
const state = (revision: number): Record<string, unknown> => ({
  goal: {
    id: 'g1',
    revision,
    objective: '完成迁移',
    phase: 'active',
    roundsStarted: 1,
    maxGoalRounds: 256,
    createdAt: 1,
    updatedAt: 2
  },
  activation: 'disarmed'
})

function goalResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

async function renderSession(): Promise<ReturnType<typeof createMockTransport>> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId="thread-goal"
        runtime={{ transport: control.transport, loadHistory: async () => [], onTurnEnd: () => {} }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return control
}

function runGoal(text: string): void {
  const input = screen.getByTestId('composer-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  const bridge = installKyclawBridge()
  void bridge
  window.kyclaw.agent.endpoint = async () => ({ baseUrl: 'http://goal.local', token: 'tok' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearKyclawBridge()
})

describe('PB-039 /goal 提交路径', () => {
  it('`/goal` 不进历史（不发 chat 请求），六行卡片渲染；关闭后状态不丢', async () => {
    const control = await renderSession()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => goalResponse(state(2)))
    )

    await act(async () => runGoal('/goal'))

    expect(await screen.findByTestId('goal-command-card')).toHaveTextContent('完成迁移')
    expect(screen.getByTestId('goal-command-lines')).toHaveTextContent('1/256')
    // 不进历史：chat transport 一次请求都没有
    expect(control.requests).toHaveLength(0)
    // 关闭卡片
    fireEvent.click(screen.getByTestId('goal-command-close'))
    expect(screen.queryByTestId('goal-command-card')).not.toBeInTheDocument()
    // 再 `/goal` 仍能查到（关闭 ≠ 清空）
    await act(async () => runGoal('/goal'))
    expect(await screen.findByTestId('goal-command-card')).toHaveTextContent('完成迁移')
  })

  it('409 stale → 重 GET → 用最新 revision 重发一次（卡片显示成功）', async () => {
    const control = await renderSession()
    const fetchMock = vi
      .fn()
      // 首次 GET（ref revision=2）
      .mockResolvedValueOnce(goalResponse(state(2)))
      // 首次 POST 409
      .mockResolvedValueOnce(
        goalResponse({ error: 'GOAL_STALE_REVISION', message: '旧 revision' }, 409)
      )
      // 重 GET（fresh revision=5）
      .mockResolvedValueOnce(goalResponse(state(5)))
      // 重发成功（revision=6）
      .mockResolvedValueOnce(goalResponse(state(6)))
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => runGoal('/goal pause'))

    expect(await screen.findByTestId('goal-command-card')).toHaveTextContent('完成迁移')
    expect(screen.queryByTestId('goal-command-error')).not.toBeInTheDocument()
    // PB-039 接线后 `GoalDockContainer` 挂载也会 GET 一次 goal，总请求数不再是固定 4；
    // 这里只钉"POST 两次（首次 409 + 重发）"与"重发用的是最新 revision"，不锁总次数。
    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    )
    expect(postCalls).toHaveLength(2)
    const retried = JSON.parse((postCalls[1]?.[1] as RequestInit).body as string)
    expect(retried.action).toBe('pause')
    expect(retried.ref).toEqual({ id: 'g1', revision: 5 })
    expect(control.requests).toHaveLength(0)
  })
})
