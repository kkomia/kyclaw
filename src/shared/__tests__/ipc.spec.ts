import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { IPC_CHANNELS, IpcInputError, noArgsSchema, parseIpcArgs, windowStateSchema } from '../ipc'

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
