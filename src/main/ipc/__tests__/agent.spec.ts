/**
 * agent 通道 handler：先过入参闸门，再回吐本地服务的端点（baseUrl + token）。
 * 跟其它通道一致地 mock 掉 electron 跑：端点从注册时传进来的取值函数拿，
 * 测试不用起真的服务（那是 service.spec / link.spec 的事）。
 *
 * round 76：服务没起来时**挂起等一段**（有限重试），不再是"问一次就抛" ——
 * 这里注入小超时/小间隔验三条：等得到就回吐、等不到才抛、入参闸门照旧在最前。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

import { IPC_CHANNELS, IpcInputError, type AgentEndpoint } from '../../../shared/ipc'
import { registerAgentIpc } from '../agent'

const EVENT = { sender: { id: 1 } }
const ENDPOINT: AgentEndpoint = { baseUrl: 'http://127.0.0.1:43210', token: 'token-abc' }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

beforeEach(() => {
  mocks.handlers.clear()
})

describe('agent 通道 handler', () => {
  it('注册了 agent:endpoint', () => {
    registerAgentIpc(() => ENDPOINT)

    expect([...mocks.handlers.keys()]).toEqual([IPC_CHANNELS.agent.endpoint])
  })

  it('回吐服务端点的 baseUrl + token', async () => {
    registerAgentIpc(() => ENDPOINT)

    await expect(handlerOf(IPC_CHANNELS.agent.endpoint)(EVENT)).resolves.toEqual(ENDPOINT)
  })

  it('服务晚 800ms 起来：挂起等到端点就绪再回吐（冷启动不再直接落到错误卡）', async () => {
    let endpoint: AgentEndpoint | null = null
    registerAgentIpc(() => endpoint, { timeoutMs: 3000, intervalMs: 25 })
    const started = Date.now()
    const pending = Promise.resolve(handlerOf(IPC_CHANNELS.agent.endpoint)(EVENT))
    setTimeout(() => {
      endpoint = ENDPOINT
    }, 800)

    await expect(pending).resolves.toEqual(ENDPOINT)
    // 真等到了那一刻（不是提前拿了个空壳，也不是问了两次就放弃）
    expect(Date.now() - started).toBeGreaterThanOrEqual(790)
  })

  it('一直没起来：等到超时才抛错（不静默回半截端点，也不无限等）', async () => {
    registerAgentIpc(() => null, { timeoutMs: 60, intervalMs: 10 })
    const started = Date.now()

    await expect(handlerOf(IPC_CHANNELS.agent.endpoint)(EVENT)).rejects.toThrow()
    // 超时是"等到上限"，不是当场抛
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('拒绝带入参的调用（入参闸门在等待之前）', async () => {
    registerAgentIpc(() => ENDPOINT)
    const handler = handlerOf(IPC_CHANNELS.agent.endpoint)

    await expect(handler(EVENT, { evil: 1 })).rejects.toThrow(IpcInputError)
    await expect(handler(EVENT, 'token')).rejects.toThrow(IpcInputError)
  })
})
