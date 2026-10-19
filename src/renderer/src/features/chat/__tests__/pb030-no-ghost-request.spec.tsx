import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession, PENDING_THREAD_ID } from '../ChatPage'
import { resetThreadChats } from '../thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { createMockTransport } from './mock-transport'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-030 配合（Lead 2026-10-19）：renderer **不得**把占位/未物化的 thread id 当请求 threadId
 * 发给交互路由（`/ask-user/*`、`/api/kernel/interactions|projection`）——main 侧未知 thread 会
 * session/create，侧栏因此冒出幽灵会话（Nia 抓到 `session-item-kyclaw-pending`）。
 * 占位 id 仍可用于 UI key；请求必须等真会话（realThread）。
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/kernel/status')) {
      return new Response(JSON.stringify({ enabled: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  installKyclawBridge()
  window.kyclaw.agent.endpoint = async () => ({ baseUrl: 'http://ghost.local', token: 'tok' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearKyclawBridge()
})

async function renderSession(threadId: string | null): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = stubFetch()
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={threadId}
        runtime={{
          transport: control.transport,
          loadHistory: async () => [],
          onTurnEnd: () => {},
          refreshInteractions: true
        }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return fetchMock
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input))
}

describe('PB-030 配合：无真实会话不拿占位 id 打交互路由', () => {
  it('threadId=null（占位 UI key）→ 不发任何带 kyclaw-pending 的请求', async () => {
    const fetchMock = await renderSession(null)
    const urls = requestedUrls(fetchMock)
    expect(urls.some((url) => url.includes(PENDING_THREAD_ID))).toBe(false)
    expect(urls.some((url) => url.includes('/ask-user/pending'))).toBe(false)
    expect(urls.some((url) => url.includes('/api/kernel/projection'))).toBe(false)
    expect(urls.some((url) => url.includes('/api/kernel/interactions'))).toBe(false)
  })
})
