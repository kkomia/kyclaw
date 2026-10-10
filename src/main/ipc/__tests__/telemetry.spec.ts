// @vitest-environment node
/**
 * 可观测通道 handler（T17）：入参闸门 + 密钥只进不出的回包纪律 + active 的传递。
 * 与 settings 通道的测试同一套做法：mock 掉 electron 的 ipcMain 与 safeStorage（假密码本 = 反转），
 * userData 用临时目录。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => [...encrypted.toString('utf8')].reverse().join('')
  }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { secretsPath } from '../../secrets'
import { settingsPath, writeSettings } from '../../settings'
import { registerTelemetryIpc } from '../telemetry'

const EVENT = { sender: { id: 1 } }
const PUBLIC_KEY = 'pk-lf-ipc-0001'
const SECRET_KEY = 'sk-lf-ipc-9999-SECRET'

let dir: string
let active = false

/** 取一条已注册的 handler（顺带断言它确实注册了） */
function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

beforeEach(() => {
  mocks.handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-telemetry-ipc-'))
  active = false
  writeSettings(settingsPath(dir), {
    ...DEFAULT_SETTINGS,
    langfuse: { endpoint: 'https://cloud.langfuse.com' }
  })
  registerTelemetryIpc({
    dataDir: dir,
    secretsFile: secretsPath(dir),
    langfuseActive: () => active
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('telemetry 通道', () => {
  it('三条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      IPC_CHANNELS.telemetry.clearLangfuseKeys,
      IPC_CHANNELS.telemetry.langfuseState,
      IPC_CHANNELS.telemetry.setLangfuseKeys
    ])
  })

  it('状态：地址来自落盘设置；密钥没配就是"没有"；active 跟着取值函数走', () => {
    expect(handlerOf(IPC_CHANNELS.telemetry.langfuseState)(EVENT)).toEqual({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: false },
      secretKey: { hasKey: false, needsReentry: false },
      active: false
    })

    active = true
    expect(handlerOf(IPC_CHANNELS.telemetry.langfuseState)(EVENT)).toMatchObject({ active: true })
  })

  it('写密钥：回包只有 {hasKeys:true}，明文不进回包、不进磁盘', () => {
    const result = handlerOf(IPC_CHANNELS.telemetry.setLangfuseKeys)(EVENT, PUBLIC_KEY, SECRET_KEY)

    expect(result).toEqual({ hasKeys: true })
    expect(JSON.stringify(result)).not.toContain(PUBLIC_KEY)

    const secrets = readFileSync(secretsPath(dir), 'utf8')
    expect(secrets).not.toContain(PUBLIC_KEY)
    expect(secrets).not.toContain(SECRET_KEY)

    expect(handlerOf(IPC_CHANNELS.telemetry.langfuseState)(EVENT)).toMatchObject({
      publicKey: { hasKey: true },
      secretKey: { hasKey: true }
    })
  })

  it('写密钥的入参要两段非空字符串（空串 / 少给一个 / 多给一个都不收）', () => {
    const setKeys = handlerOf(IPC_CHANNELS.telemetry.setLangfuseKeys)

    expect(() => setKeys(EVENT, '', SECRET_KEY)).toThrow(IpcInputError)
    expect(() => setKeys(EVENT, PUBLIC_KEY)).toThrow(IpcInputError)
    expect(() => setKeys(EVENT, PUBLIC_KEY, SECRET_KEY, 'extra')).toThrow(IpcInputError)
    expect(() => setKeys(EVENT, 42, SECRET_KEY)).toThrow(IpcInputError)
  })

  it('清除密钥：回吐清完的状态（地址留着），没有密钥时也能调', () => {
    handlerOf(IPC_CHANNELS.telemetry.setLangfuseKeys)(EVENT, PUBLIC_KEY, SECRET_KEY)

    expect(handlerOf(IPC_CHANNELS.telemetry.clearLangfuseKeys)(EVENT)).toEqual({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: false },
      secretKey: { hasKey: false, needsReentry: false },
      active: false
    })
    expect(handlerOf(IPC_CHANNELS.telemetry.clearLangfuseKeys)(EVENT)).toMatchObject({
      publicKey: { hasKey: false }
    })
  })

  it('无入参通道多给参数就是非法调用', () => {
    expect(() => handlerOf(IPC_CHANNELS.telemetry.langfuseState)(EVENT, 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.telemetry.clearLangfuseKeys)(EVENT, 1)).toThrow(
      IpcInputError
    )
  })
})
