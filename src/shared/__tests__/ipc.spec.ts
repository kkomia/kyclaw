import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  agentEndpointSchema,
  IPC_CHANNELS,
  IpcInputError,
  noArgsSchema,
  parseIpcArgs,
  settingsUpdateArgsSchema,
  windowStateSchema
} from '../ipc'
import { DEFAULT_SETTINGS } from '../settings'

describe('IPC 契约：window 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.window).toEqual({
      minimize: 'window:minimize',
      maximize: 'window:maximize',
      close: 'window:close',
      isMaximized: 'window:is-maximized',
      stateChanged: 'window:state-changed'
    })
  })

  it('无入参通道只收空入参（多给一个参数就是非法调用）', () => {
    expect(noArgsSchema.safeParse([]).success).toBe(true)
    expect(noArgsSchema.safeParse([{ maximized: true }]).success).toBe(false)
    expect(noArgsSchema.safeParse([null]).success).toBe(false)
    expect(noArgsSchema.safeParse([1, 2]).success).toBe(false)
  })

  it('窗口状态 payload 只收 { maximized: boolean }，缺键/错型/多键都不合法', () => {
    expect(windowStateSchema.safeParse({ maximized: true }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: false }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: 'true' }).success).toBe(false)
    expect(windowStateSchema.safeParse({}).success).toBe(false)
    expect(windowStateSchema.safeParse({ maximized: true, extra: 1 }).success).toBe(false)
  })

  it('parseIpcArgs 校验的是整个 args 元组：合法时返回解析结果', () => {
    expect(parseIpcArgs(noArgsSchema, [], 'window:minimize')).toEqual([])
    // 带 payload 的通道把 payload 包成单元素元组（后续任务的新通道照此约定）
    expect(
      parseIpcArgs(z.tuple([windowStateSchema]), [{ maximized: true }], 'window:whatever')
    ).toEqual([{ maximized: true }])
  })

  it('parseIpcArgs 非法时抛 IpcInputError，且消息里带通道名（定位用）', () => {
    expect(() => parseIpcArgs(noArgsSchema, [1], IPC_CHANNELS.window.minimize)).toThrow(
      IpcInputError
    )
    expect(() => parseIpcArgs(noArgsSchema, [1], IPC_CHANNELS.window.minimize)).toThrow(
      /window:minimize/
    )
  })
})

describe('IPC 契约：settings 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.settings).toEqual({ get: 'settings:get', update: 'settings:update' })
  })

  it('settings:update 只收一个补丁对象（形状与取值都过 settings schema）', () => {
    expect(parseIpcArgs(settingsUpdateArgsSchema, [{ theme: 'dark' }], 'settings:update')).toEqual([
      { theme: 'dark' }
    ])
    expect(parseIpcArgs(settingsUpdateArgsSchema, [{}], 'settings:update')).toEqual([{}])
    expect(parseIpcArgs(settingsUpdateArgsSchema, [DEFAULT_SETTINGS], 'settings:update')).toEqual([
      DEFAULT_SETTINGS
    ])
  })

  it('settings:update 拦住非法补丁：错值 / 多键 / 非对象 / 缺参 / 多参', () => {
    const reject = (...args: unknown[]): void => {
      expect(() =>
        parseIpcArgs(settingsUpdateArgsSchema, args, IPC_CHANNELS.settings.update)
      ).toThrow(IpcInputError)
    }

    reject({ theme: 'blue' })
    reject({ fontTier: 'huge' })
    reject({ theme: 'dark', evil: 1 })
    reject('dark')
    reject(null)
    reject()
    reject({ theme: 'dark' }, { theme: 'light' })
  })
})

describe('IPC 契约：agent 通道', () => {
  it('通道名是固定字面量（主进程 handler 与 preload 靠它对齐，改名即破坏）', () => {
    expect(IPC_CHANNELS.agent).toEqual({ endpoint: 'agent:endpoint' })
  })

  it('端点 payload 只收 { baseUrl, token } 两个字符串，缺键/错型/多键都不合法', () => {
    expect(
      agentEndpointSchema.safeParse({ baseUrl: 'http://127.0.0.1:43210', token: 'abc' }).success
    ).toBe(true)
    expect(agentEndpointSchema.safeParse({ baseUrl: 'http://127.0.0.1:43210' }).success).toBe(false)
    expect(agentEndpointSchema.safeParse({ baseUrl: 1, token: 'abc' }).success).toBe(false)
    expect(agentEndpointSchema.safeParse({ baseUrl: 'x', token: 'y', port: 1 }).success).toBe(false)
  })
})
