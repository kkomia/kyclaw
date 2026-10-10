import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 设置通道 handler：先过入参闸门，再读写 userData 下的 settings.json。
 * 跟窗口通道一样 mock 掉 electron 跑：注册时把 userData 目录当参数传进来，测试就能用临时目录。
 */
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

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { readSettings, settingsPath, writeSettings } from '../../settings'
import { registerSettingsIpc } from '../settings'

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

let dir: string

beforeEach(() => {
  mocks.handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-settings-ipc-'))
  registerSettingsIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings 通道 handler', () => {
  it('两条 invoke 通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(['settings:get', 'settings:update'])
  })

  it('settings:get 读的是这个 userData 目录下的文件', () => {
    writeSettings(settingsPath(dir), { ...DEFAULT_SETTINGS, theme: 'dark' })

    expect(handlerOf(IPC_CHANNELS.settings.get)(EVENT)).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark'
    })
  })

  it('settings:get 收不到文件（首启动）就给默认值', () => {
    expect(handlerOf(IPC_CHANNELS.settings.get)(EVENT)).toEqual(DEFAULT_SETTINGS)
  })

  it('settings:get 拒绝带入参的调用', () => {
    const handler = handlerOf(IPC_CHANNELS.settings.get)

    expect(() => handler(EVENT, { theme: 'dark' })).toThrow(IpcInputError)
    expect(() => handler(EVENT, 1)).toThrow(IpcInputError)
  })

  it('settings:update 合并补丁、落盘，并回吐合并后的完整设置', () => {
    const next = handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'light' })

    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
    expect(readSettings(settingsPath(dir))).toEqual(next)
    expect(handlerOf(IPC_CHANNELS.settings.get)(EVENT)).toEqual(next)
  })

  it('settings:update 的非法补丁被入参闸门拦住：抛 IpcInputError，文件不动', () => {
    const handler = handlerOf(IPC_CHANNELS.settings.update)
    const before = readSettings(settingsPath(dir))

    for (const bad of [
      [{ theme: 'blue' }],
      [{ fontTier: 'huge' }],
      [{ evil: 1 }],
      [null],
      ['dark'],
      [],
      [{ theme: 'dark' }, { theme: 'light' }]
    ]) {
      expect(() => handler(EVENT, ...bad), JSON.stringify(bad)).toThrow(IpcInputError)
    }
    expect(readSettings(settingsPath(dir))).toEqual(before)
  })

  it('落盘失败时把错误抛给调用方（不静默吞掉用户的改动）', () => {
    // 父路径是文件 → mkdir 必失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')
    mocks.handlers.clear()
    registerSettingsIpc(blocked)

    expect(() => handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'dark' })).toThrow()
  })
})
