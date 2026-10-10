import { describe, expect, it, vi } from 'vitest'

/**
 * 主进程窗口通道 handler：入参闸门 + 动作都落在"收到消息的那个窗口"上（多窗口不误控）。
 * 用 mock 的 electron 跑：拿注册进 ipcMain.handle 的 handler 直接调用，不真起 Electron。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    fromWebContents: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    fromWebContents: (...args: unknown[]) => mocks.fromWebContents(...args)
  }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { registerWindowIpc } from '../window'

registerWindowIpc()

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

function fakeWindow(overrides: { maximized?: boolean } = {}): {
  minimize: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
} {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => overrides.maximized ?? false)
  }
}

function withWindow(win: ReturnType<typeof fakeWindow>): ReturnType<typeof fakeWindow> {
  mocks.fromWebContents.mockReturnValue(win)
  return win
}

describe('window 通道 handler', () => {
  it('四条 invoke 通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.window.minimize,
        IPC_CHANNELS.window.maximize,
        IPC_CHANNELS.window.close,
        IPC_CHANNELS.window.isMaximized
      ].sort()
    )
  })

  it('minimize / close 落到发来消息的那个窗口', () => {
    const win = withWindow(fakeWindow())

    handlerOf(IPC_CHANNELS.window.minimize)(EVENT)
    handlerOf(IPC_CHANNELS.window.close)(EVENT)

    expect(mocks.fromWebContents).toHaveBeenCalledWith(EVENT.sender)
    expect(win.minimize).toHaveBeenCalledTimes(1)
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('maximize 是切换：没最大化就最大化，已最大化就还原', () => {
    const win = withWindow(fakeWindow({ maximized: false }))
    handlerOf(IPC_CHANNELS.window.maximize)(EVENT)
    expect(win.maximize).toHaveBeenCalledTimes(1)
    expect(win.unmaximize).not.toHaveBeenCalled()

    win.isMaximized.mockReturnValue(true)
    handlerOf(IPC_CHANNELS.window.maximize)(EVENT)
    expect(win.unmaximize).toHaveBeenCalledTimes(1)
    expect(win.maximize).toHaveBeenCalledTimes(1)
  })

  it('isMaximized 返回窗口当前状态；窗口已经不在了就返回 false', () => {
    withWindow(fakeWindow({ maximized: true }))
    expect(handlerOf(IPC_CHANNELS.window.isMaximized)(EVENT)).toBe(true)

    mocks.fromWebContents.mockReturnValue(null)
    expect(handlerOf(IPC_CHANNELS.window.isMaximized)(EVENT)).toBe(false)
  })

  it.each([
    IPC_CHANNELS.window.minimize,
    IPC_CHANNELS.window.maximize,
    IPC_CHANNELS.window.close,
    IPC_CHANNELS.window.isMaximized
  ])('%s 拒绝带入参的调用（抛 IpcInputError，且不动窗口）', (channel) => {
    const win = withWindow(fakeWindow())
    const handler = handlerOf(channel)

    expect(() => handler(EVENT, { smuggled: true })).toThrow(IpcInputError)
    expect(() => handler(EVENT, 1, 2)).toThrow(IpcInputError)
    expect(win.minimize).not.toHaveBeenCalled()
    expect(win.maximize).not.toHaveBeenCalled()
    expect(win.unmaximize).not.toHaveBeenCalled()
    expect(win.close).not.toHaveBeenCalled()
  })

  it('窗口不存在时（关窗竞态）不抛，静默无操作', () => {
    mocks.fromWebContents.mockReturnValue(null)

    expect(() => handlerOf(IPC_CHANNELS.window.minimize)(EVENT)).not.toThrow()
    expect(() => handlerOf(IPC_CHANNELS.window.maximize)(EVENT)).not.toThrow()
    expect(() => handlerOf(IPC_CHANNELS.window.close)(EVENT)).not.toThrow()
  })
})
