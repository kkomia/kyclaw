import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '../ChatPage'
import { resetThreadChats } from '../thread-chats'
import { createMockTransport } from './mock-transport'
import { nextFrame } from './next-frame'

/**
 * PB-027（P1 数据丢失级）：内核路径点「停止」后整列消息被旧宿主 history 覆盖成空。
 *
 * 复现条件（与 Nia 的 e2e 同一调用链）：
 *   - ChatSession **不注入 runtime** → `interactionsEnabled=true`，停止走
 *     `useAskUserStore.cancel(threadId, stop, synchronize)`；
 *   - 宿主旧线程库 `fetchThreadMessages` 返回 `[]`（内核路径的轮次不写旧库）；
 *   - 停止后 synchronize 里的 `setMessages(history)` 用空数组覆盖 → 用户消息 + 已交付文本全丢。
 *
 * 本 spec 两组：
 *   1. 内核模式：停止只 abort 本轮，不碰旧 ask-user/history 通道，消息保留；
 *   2. flag 关负向防线：即使同步回调拿到空 history，也**不许清空整列**（防别的路径再犯）。
 */

vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 2),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

const askApi = vi.hoisted(() => ({
  fetchPendingAskUser: vi.fn(async () => []),
  cancelAskUser: vi.fn(async () => [] as string[])
}))
vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: askApi.fetchPendingAskUser,
  cancelAskUser: askApi.cancelAskUser
}))

/**
 * 本 spec 只验停止路径；计划状态不是被测对象。真实 plansApi 在 jsdom 里没有 `window.kyclaw`
 * 会抛 unhandled rejection（ChatPage 的放宽刷新），这里给一个正常的 normal 计划，避免噪声。
 */
const plansApiMock = vi.hoisted(() => ({
  get: vi.fn(async (threadId: string) => ({
    state: {
      threadId,
      version: 0,
      mode: 'normal' as const,
      planId: null,
      revision: 0,
      body: null,
      feedback: null,
      approval: null,
      updatedAt: new Date().toISOString()
    },
    ref: null
  }))
}))
vi.mock('@renderer/lib/plans-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/plans-api')>()),
  plansApi: plansApiMock
}))

const kernelApi = vi.hoisted(() => ({
  kernelEnabled: vi.fn(async () => false),
  fetchKernelCatalog: vi.fn(async () => []),
  fetchKernelProjection: vi.fn(async () => ({ goal: null, plan: null })),
  runKernelCommand: vi.fn(async () => {})
}))
vi.mock('../kernel-command-api', () => kernelApi)

import { fetchThreadMessages } from '@renderer/lib/threads-api'
import { useAskUserStore } from '../ask-user-store'

const THREAD_ID = 'thread-stop'

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

async function renderSession(): Promise<ReturnType<typeof createMockTransport>> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        runtime={{
          transport: control.transport,
          loadHistory: async () => [],
          onTurnEnd: () => {},
          // 生产路径的 interactionsEnabled=true（没有注入 runtime 时也是 true）——
          // 只有它为 true，停止才会走 askUserStore.cancel 的 synchronize 分支（本 bug 的入口）。
          refreshInteractions: true
        }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return control
}

async function sendAndStop(control: ReturnType<typeof createMockTransport>): Promise<void> {
  await act(async () => {
    type('先别急着答')
  })
  // 发送钮在空输入时本来就是 disabled；有草稿才看"就绪与否"。就绪后点它（比 Enter 稳）。
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled(), {
    timeout: 5_000
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('composer-send'))
  })
  await waitFor(() => expect(control.requests).toHaveLength(1))
  await act(async () => {
    control.push('半句回答')
  })
  await nextFrame()
  expect(screen.getByTestId('message-list')).toHaveTextContent('先别急着答')
  expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')

  await act(async () => {
    fireEvent.click(screen.getByTestId('composer-stop'))
  })
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeVisible())
}

let cancelSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetThreadChats()
  vi.clearAllMocks()
  kernelApi.kernelEnabled.mockResolvedValue(false)
  askApi.cancelAskUser.mockResolvedValue([])
  askApi.fetchPendingAskUser.mockResolvedValue([])
  // 真实 useChat.stop() 在单测的 mock transport 上不保证 resolve（e2e 真链路会）——
  // 这里把 store 的 cancel 收口到它真正要验的两段：abort 本轮 + 跑 synchronize。
  // 停止路径的"用空 history 覆盖"就发生在 synchronize 里。
  cancelSpy = vi
    .spyOn(useAskUserStore.getState(), 'cancel')
    .mockImplementation(async (_threadId, stop, synchronize) => {
      void stop()
      await synchronize?.()
      return []
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PB-027 停止不清空消息列', () => {
  it('内核模式：停止只 abort 本轮；不调旧 ask-user/history，用户消息与已交付文本保留', async () => {
    kernelApi.kernelEnabled.mockResolvedValue(true)
    const control = await renderSession()

    await sendAndStop(control)

    // 当前行为（red）：synchronize 用空 history 覆盖 → 这里会是空列表/欢迎空态。
    expect(screen.getByTestId('message-list')).toHaveTextContent('先别急着答')
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')
    expect(screen.getByTestId('message-text')).toBeInTheDocument()
    // 内核路径不再打旧 ask-user 取消（threads/ask_user 归内核，PB-024/PB-025）
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('负向：flag 关的同步回调拿到空 history 时，也不许清空整列（防别的路径再犯）', async () => {
    const control = await renderSession()

    await sendAndStop(control)

    // 旧路径仍会尝试同步（证明防线不是"根本没走到"），但空快照必须被拒绝
    expect(cancelSpy).toHaveBeenCalled()
    expect(vi.mocked(fetchThreadMessages).mock.calls.length).toBeGreaterThan(0)
    expect(screen.getByTestId('message-list')).toHaveTextContent('先别急着答')
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')
    expect(screen.getByTestId('message-text')).toBeInTheDocument()
  })
})
