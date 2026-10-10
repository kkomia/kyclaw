/**
 * agent 通道 handler：先过入参闸门，再回吐本地服务的端点（baseUrl + token）。
 * 跟其它通道一致地 mock 掉 electron 跑：端点从注册时传进来的取值函数拿，
 * 测试不用起真的服务（那是 service.spec / link.spec 的事）。
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

  it('回吐服务端点的 baseUrl + token', () => {
    registerAgentIpc(() => ENDPOINT)

    expect(handlerOf(IPC_CHANNELS.agent.endpoint)(EVENT)).toEqual(ENDPOINT)
  })

  it('服务还没起来时抛错（不静默回半截端点）', () => {
    registerAgentIpc(() => null)

    expect(() => handlerOf(IPC_CHANNELS.agent.endpoint)(EVENT)).toThrow()
  })

  it('拒绝带入参的调用', () => {
    registerAgentIpc(() => ENDPOINT)
    const handler = handlerOf(IPC_CHANNELS.agent.endpoint)

    expect(() => handler(EVENT, { evil: 1 })).toThrow(IpcInputError)
    expect(() => handler(EVENT, 'token')).toThrow(IpcInputError)
  })
})
