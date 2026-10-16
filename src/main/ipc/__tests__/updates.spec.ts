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

import {
  IPC_CHANNELS,
  IpcInputError,
  type BundledReleaseNotes,
  type UpdateState
} from '../../../shared/ipc'
import { createInertUpdater, createUpdater, type UpdateBackend } from '../../updater'
import { pushUpdateState, registerUpdatesIpc } from '../updates'

const EVENT = { sender: { id: 1 } }

/** 本版本发行说明的假件（真读盘另有 release-notes-bundled.spec）：这里只验通道与入参闸门 */
const NOTES: BundledReleaseNotes = { state: 'missing' }

const UNCONFIGURED: UpdateState = {
  currentVersion: '1.0.0',
  configured: false,
  builtinUrl: null,
  status: { phase: 'idle' }
}

const CONFIGURED: UpdateState = {
  currentVersion: '1.0.0',
  configured: true,
  builtinUrl: null,
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
  it('四条通道都注册了；没配源时状态是"未配置"', () => {
    registerUpdatesIpc(
      () => createInertUpdater('1.0.0'),
      () => NOTES
    )

    expect([...mocks.handlers.keys()].sort()).toEqual([
      IPC_CHANNELS.updates.check,
      IPC_CHANNELS.updates.install,
      IPC_CHANNELS.updates.releaseNotes,
      IPC_CHANNELS.updates.state
    ])
    expect(handlerOf(IPC_CHANNELS.updates.state)(EVENT)).toEqual(UNCONFIGURED)
  })

  it('本版本发行说明：无入参、读盘结果原样回（断网/没配源也答得出，不走更新器）', () => {
    const readNotes = vi.fn(() => ({
      state: 'ok' as const,
      version: '1.0.0',
      notes: 'kyclaw 1.0.0\n\n- 一条'
    }))
    registerUpdatesIpc(() => createInertUpdater('1.0.0'), readNotes)

    expect(handlerOf(IPC_CHANNELS.updates.releaseNotes)(EVENT)).toEqual({
      state: 'ok',
      version: '1.0.0',
      notes: 'kyclaw 1.0.0\n\n- 一条'
    })
    expect(readNotes).toHaveBeenCalledTimes(1)
  })

  it('检查/安装都落到"当前"那个更新器（装配晚于注册也要生效）', async () => {
    let current = createInertUpdater('1.0.0')
    registerUpdatesIpc(
      () => current,
      () => NOTES
    )

    await handlerOf(IPC_CHANNELS.updates.check)(EVENT)
    handlerOf(IPC_CHANNELS.updates.install)(EVENT)

    const backend = fakeBackend()
    current = createUpdater({
      currentVersion: '1.0.0',
      resolveSource: () => ({ kind: 'url', url: 'http://127.0.0.1:8555/', forceDevConfig: true }),
      backend: async () => backend
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

  it('无入参通道多给参数就是非法调用（本版发行说明同样不收任何路径/参数）', () => {
    registerUpdatesIpc(
      () => createInertUpdater('1.0.0'),
      () => NOTES
    )

    expect(() => handlerOf(IPC_CHANNELS.updates.state)(EVENT, 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.updates.check)(EVENT, 1)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.updates.install)(EVENT, {})).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.updates.releaseNotes)(EVENT, 'C:\\some\\path.md')).toThrow(
      IpcInputError
    )
  })
})
