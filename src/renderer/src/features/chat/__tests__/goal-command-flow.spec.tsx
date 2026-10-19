import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelGoalProjection } from '@shared/kernel-ui'
import { resetThreadChats } from '../thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { ChatSession } from '../ChatPage'
import { createMockTransport } from './mock-transport'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-018 / D2：**flag 关**（`KYCLAW_KERNEL_PORT` 未开）的 renderer 行为。
 *
 * renderer 已删掉手写 parser：`/goal` 一律交给 main 的网关，flag 关时由 main 用旧 store 降级
 * （见 `src/main/kernel/kernel-command-fallback.ts`）。本 spec 只钉 renderer 侧：
 *   - `/goal` 仍走命令通道（不进消息流），六行按旧口径 `1/256` 显示；
 *   - 其它 slash（如 `/plan`）保持 0.1.6 行为：仍作为普通消息发给模型，不被命令平面劫持。
 */

const LEGACY_PROJECTION: KernelGoalProjection = {
  visible: true,
  goalId: 'g1',
  phase: 'active',
  rows: [
    { id: 'status', label: 'Status', value: '进行中', tone: 'normal' },
    { id: 'blocker', label: 'Blocker', value: '—', tone: 'muted' },
    { id: 'objective', label: 'Objective', value: '完成迁移', tone: 'normal' },
    { id: 'rounds', label: 'Rounds', value: '1/256', tone: 'normal' },
    { id: 'activation', label: 'Activation', value: 'armed', tone: 'muted' },
    {
      id: 'commands',
      label: 'Commands',
      value: '/goal pause · /goal edit · /goal clear',
      tone: 'muted'
    }
  ],
  commands: ['goal pause', 'goal edit', 'goal clear']
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

function stubFlagOff(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/kernel/status')) return json({ enabled: false })
    if (url.endsWith('/api/kernel/catalog')) return json({ enabled: false, commands: [] })
    if (url.includes('/api/kernel/projection')) return json({ goal: null, plan: null })
    if (url.endsWith('/api/kernel/command')) {
      const body = JSON.parse(String(init?.body)) as { line: string }
      return sse([
        { type: 'command/run', commandId: 'legacy-1', line: body.line },
        {
          type: 'command/done',
          commandId: 'legacy-1',
          line: body.line,
          result: { kind: 'success' },
          goal: LEGACY_PROJECTION,
          plan: null
        }
      ])
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function renderSession(): Promise<ReturnType<typeof createMockTransport>> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId="thread-legacy"
        runtime={{
          transport: control.transport,
          loadHistory: async () => [],
          onTurnEnd: () => {},
          refreshInteractions: false
        }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return control
}

function runLine(text: string): void {
  const input = screen.getByTestId('composer-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  installKyclawBridge()
  window.kyclaw.agent.endpoint = async () => ({ baseUrl: 'http://legacy.local', token: 'tok' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearKyclawBridge()
})

describe('PB-018 flag 关：旧路径零变化 + `/goal` 由 main 降级实现接管', () => {
  it('`/goal` 仍走命令通道（不进消息流），六行按旧口径 1/256', async () => {
    stubFlagOff()
    const control = await renderSession()
    await act(async () => runLine('/goal 完成迁移'))

    const card = await screen.findByTestId('goal-command-card')
    expect(card).toHaveTextContent('完成迁移')
    expect(card).toHaveTextContent('1/256')
    expect(control.requests).toHaveLength(0)
  })

  it('flag 关菜单仍是旧静态三行（catalog 为空不冒充内核目录）', async () => {
    stubFlagOff()
    await renderSession()
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: '/' } })
    expect(await screen.findByTestId('suggest-command:compact')).toBeInTheDocument()
    expect(screen.getByTestId('suggest-command:goal')).toBeInTheDocument()
    expect(screen.queryByTestId('suggest-command:export')).not.toBeInTheDocument()
  })

  it('`/plan` 在 flag 关仍是普通消息（不被命令平面劫持）', async () => {
    const fetchMock = stubFlagOff()
    const control = await renderSession()
    await act(async () => runLine('/plan'))
    await waitFor(() => expect(control.requests).toHaveLength(1))
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/kernel/command'))
    ).toHaveLength(0)
    control.finish()
  })
})
