import { describe, expect, it, vi } from 'vitest'

/**
 * PB-038：`app:relaunch` 的 handler 语义。
 * 用 mock 的 electron 跑：拿注册进 ipcMain.handle 的 handler 直接调用，不真起 Electron。
 *
 * 钉三件事：
 *   1. 有未保存 Office 文档 → 拒绝（不 relaunch、不 quit），回 `{ok:false, reason:'unsaved-documents'}`；
 *   2. 干净 → 先 relaunch 再 quit，回 `{ok:true}`；
 *   3. relaunch/quit 抛错 → 回 `{ok:false, reason:'relaunch-failed'}`（不让 renderer 以为在重启）。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>()
  }
})

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

import { IPC_CHANNELS } from '../../../shared/ipc'
import { registerAppControlIpc } from '../app-control'

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

const EVENT = { sender: { id: 1 } }

describe('PB-038 app:relaunch', () => {
  it('有未保存文档 → 拒绝重启（不 relaunch、不 quit）', () => {
    const relaunch = vi.fn()
    const quit = vi.fn()
    registerAppControlIpc({ dirtyCount: () => 2, relaunch, quit })
    const result = handlerOf(IPC_CHANNELS.app.relaunch)(EVENT)
    expect(result).toEqual({ ok: false, reason: 'unsaved-documents' })
    expect(relaunch).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('干净 → relaunch + quit，回 {ok:true}', () => {
    const calls: string[] = []
    registerAppControlIpc({
      dirtyCount: () => 0,
      relaunch: () => calls.push('relaunch'),
      quit: () => calls.push('quit')
    })
    const result = handlerOf(IPC_CHANNELS.app.relaunch)(EVENT)
    expect(result).toEqual({ ok: true })
    // 顺序：先安排重启，再退出
    expect(calls).toEqual(['relaunch', 'quit'])
  })

  it('relaunch 抛错 → 回 relaunch-failed（不假装成功）', () => {
    registerAppControlIpc({
      dirtyCount: () => 0,
      relaunch: () => {
        throw new Error('boom')
      },
      quit: vi.fn()
    })
    const result = handlerOf(IPC_CHANNELS.app.relaunch)(EVENT)
    expect(result).toEqual({ ok: false, reason: 'relaunch-failed' })
  })

  it('带非法入参 → 当场拒绝（入参闸门）', () => {
    registerAppControlIpc({ dirtyCount: () => 0, relaunch: vi.fn(), quit: vi.fn() })
    expect(() => handlerOf(IPC_CHANNELS.app.relaunch)(EVENT, 'unexpected')).toThrow()
  })
})
