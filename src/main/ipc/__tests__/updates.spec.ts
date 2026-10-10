// @vitest-environment node
/**
 * 更新通道 handler（T17）：入参闸门 + 三个动作都落到"当前"更新器 + 状态推送发给所有窗口。
 * mock 掉 electron（ipcMain / BrowserWindow），更新器用假件（状态机本身另有 updater.spec）。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    windows: [] as Array<{
      isDestroyed: () => boolean
      webContents: { isDestroyed: () => boolean; send: Mock }
    }>
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => mocks.windows
  }
}))

import { IPC_CHANNELS, IpcInputError, type UpdateState } from '../../../shared/ipc'
import { createInertUpdater, createUpdater, type UpdateBackend } from '../../updater'
import { pushUpdateState, registerUpdatesIpc } from '../updates'

const EVENT = { sender: { id: 1 } }

const UNCONFIGURED: UpdateState = {
  currentVersion: '1.0.0',
  configured: false,
  status: { phase: 'idle' }
}

const CONFIGURED: UpdateState = {
  currentVersion: '1.0.0',
  configured: true,
  status: { phase: 'up-to-date' }
}

/** 只用到 check/install 的假后端 */
function fakeBackend(): UpdateBackend & { checks: number; installs: number } {
  return {
    checks: 0,
    installs: 0,
    on: () => {},
    setFeedURL: () => {},
    setForceDevConfig: () => {},
    check: async function (this: { checks: number }) {
      this.checks += 1
    },
    install: function (this: { installs: number }) {
      this.installs += 1
    }
  }
}

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

function fakeWindow(destroyed = false): {
  isDestroyed: () => boolean
  webContents: { isDestroyed: () => boolean; send: Mock }
} {
  return {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send: vi.fn() }
  }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.windows.length = 0
})

describe('updates 通道', () => {
  it('三条通道都注册了；没配源时状态是"未配置"', () => {
    registerUpdatesIpc(() => createInertUpdater('1.0.0'))

    expect([...mocks.handlers.keys()].sort()).toEqual([
      IPC_CHANNELS.updates.check,
      IPC_CHANNELS.updates.install,
      IPC_CHANNELS.updates.state
    ])
    expect(handlerOf(IPC_CHANNELS.updates.state)(EVENT)).toEqual(UNCONFIGURED)
  })

  it('检查/安装都落到"当前"那个更新器（装配晚于注册也要生效）', async () => {
    let current = createInertUpdater('1.0.0')
    registerUpdatesIpc(() => current)

    await handlerOf(IPC_CHANNELS.updates.check)(EVENT)
    handlerOf(IPC_CHANNELS.updates.install)(EVENT)

    const backend = fakeBackend()
    current = createUpdater({
      currentVersion: '1.0.0',
      source: { kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: true },
      backend
    })

    await expect(handlerOf(IPC_CHANNELS.updates.check)(EVENT)).resolves.toMatchObject({
      configured: true
    })
    expect(backend.checks).toBe(1)

    handlerOf(IPC_CHANNELS.updates.install)(EVENT)
    // 没到"已下载"阶段：不装（后端也不该被动到）
    expect(backend.installs).toBe(0)
  })

  it('推送发给所有活着的窗口；销毁的窗口跳过（关窗竞态不炸）', () => {
    const alive = fakeWindow()
    const dead = fakeWindow(true)
    mocks.windows.push(alive, dead)

    pushUpdateState(CONFIGURED)

    expect(alive.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.updates.stateChanged,
      CONFIGURED
    )
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('无入参通道多给参数就是非法调用', () => {
    registerUpdatesIpc(() => createInertUpdater('1.0.0'))

    expect(() => handlerOf(IPC_CHANNELS.updates.state)(EVENT, 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.updates.check)(EVENT, 1)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.updates.install)(EVENT, {})).toThrow(IpcInputError)
  })
})
