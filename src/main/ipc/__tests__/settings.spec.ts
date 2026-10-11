import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 设置通道 handler：先过入参闸门，再读写 userData 下的 settings.json。
 * 跟窗口通道一样 mock 掉 electron 跑：注册时把 userData 目录当参数传进来，测试就能用临时目录。
 *
 * 密钥部分（settings:set-provider-key 等）连带 mock safeStorage：假密码本 = 反转字符串，
 * 于是"回包不含明文、磁盘是密文"这类断言在 node 环境里也能真验证。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>(), decryptFails: false }
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
    decryptString: (encrypted: Buffer) => {
      if (mocks.decryptFails) throw new Error('decrypt 失败（换机/迁移）')
      return [...encrypted.toString('utf8')].reverse().join('')
    }
  }
}))

import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'
import { secretsPath } from '../../secrets'
import { readSettings, settingsPath, writeSettings } from '../../settings'
import { registerSettingsIpc } from '../settings'

const EVENT = { sender: { id: 1 } }

/** 测试密钥：又长又不像密文，方便断言"任何回包/落盘都不含它" */
const KEY = 'sk-ipc-9e4b1d7a-SECRET'

const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  isDefault: true
}

/** handler 只有 id 参与定位，事件对象本身不重要 */
function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

/** 通过 settings:update 通道摆 provider 配置（走的就是渲染端那条路） */
function configure(...providers: ProviderConfig[]): void {
  handlerOf(IPC_CHANNELS.settings.update)(EVENT, { providers })
}

/** 起一个只服务本用例的假供应商（随机端口，127.0.0.1） */
async function startHttpServer(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(onRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

let dir: string

beforeEach(() => {
  mocks.handlers.clear()
  mocks.decryptFails = false
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-settings-ipc-'))
  registerSettingsIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings 通道 handler', () => {
  it('七条 invoke 通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'settings:get',
      'settings:probe-models',
      'settings:provider-key-states',
      'settings:remove-provider',
      'settings:set-provider-key',
      'settings:test-provider',
      'settings:update'
    ])
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

describe('settings:set-provider-key（密钥只进不出）', () => {
  it('保存成功只回 {hasKey:true}：回包、设置回包、密钥状态、磁盘都不含明文', () => {
    configure(DEEPSEEK)

    const written = handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)

    expect(written).toEqual({ hasKey: true })
    expect(JSON.stringify(written)).not.toContain(KEY)

    const settings = handlerOf(IPC_CHANNELS.settings.get)(EVENT)
    expect(JSON.stringify(settings)).not.toContain(KEY)

    const states = handlerOf(IPC_CHANNELS.settings.providerKeyStates)(EVENT)
    expect(states).toEqual({ deepseek: { hasKey: true, needsReentry: false } })
    expect(JSON.stringify(states)).not.toContain(KEY)

    // 磁盘上是密文：原始文本与 base64 解出来的字节都不是明文
    const raw = readFileSync(secretsPath(dir), 'utf8')
    expect(raw).not.toContain(KEY)
    const stored = JSON.parse(raw) as { keys: Record<string, string> }
    expect(Buffer.from(stored.keys.deepseek, 'base64').toString('utf8')).not.toContain(KEY)
  })

  it('入参不合法（空 key / 多参）被闸门拦住，一个字节都不落盘', () => {
    const handler = handlerOf(IPC_CHANNELS.settings.setProviderKey)

    for (const args of [['deepseek'], ['deepseek', ''], ['', KEY], ['deepseek', KEY, 'x']]) {
      expect(() => handler(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }
    expect(existsSync(secretsPath(dir))).toBe(false)
  })
})

describe('settings:provider-key-states（设置页的"已配置 / 需重录"）', () => {
  it('未配 → false/false；配过 → true/false；解不开（换机）→ false/true', () => {
    const openai: ProviderConfig = { ...DEEPSEEK, id: 'openai', isDefault: false }
    configure(DEEPSEEK, openai)
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)

    expect(handlerOf(IPC_CHANNELS.settings.providerKeyStates)(EVENT)).toEqual({
      deepseek: { hasKey: true, needsReentry: false },
      openai: { hasKey: false, needsReentry: false }
    })

    mocks.decryptFails = true
    expect(handlerOf(IPC_CHANNELS.settings.providerKeyStates)(EVENT)).toEqual({
      deepseek: { hasKey: false, needsReentry: true },
      openai: { hasKey: false, needsReentry: false }
    })
  })

  it('无入参通道：带参数调用被闸门拦住', () => {
    expect(() => handlerOf(IPC_CHANNELS.settings.providerKeyStates)(EVENT, 'deepseek')).toThrow(
      IpcInputError
    )
  })
})

describe('settings:test-provider（复用已存的配置与密钥）', () => {
  it('找不到 id → ok:false + 文案（不抛）', () => {
    expect(handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'nope')).toEqual({
      ok: false,
      message: '找不到 provider：nope'
    })
  })

  it('缺密钥时不发任何请求，直接回"配置不完整：缺 API 密钥"（不静默回落 mock）', async () => {
    const hits: string[] = []
    const server = await startHttpServer((request, response) => {
      hits.push(request.url ?? '')
      response.end('{}')
    })
    configure({ ...DEEPSEEK, baseUrl: server.url })

    const result = await handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'deepseek')

    expect(result).toEqual({ ok: false, message: '配置不完整：缺 API 密钥' })
    expect(hits).toEqual([])
    await server.close()
  })

  it('配置齐了：请求带解出来的密钥；供应商把密钥回显在错误里也要抹掉', async () => {
    const seen: Array<string | undefined> = []
    const server = await startHttpServer((request, response) => {
      seen.push(request.headers.authorization)
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `Invalid API key: ${KEY}` } }))
    })
    configure({ ...DEEPSEEK, baseUrl: server.url })
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)

    const result = (await handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'deepseek')) as {
      ok: boolean
      message: string
    }

    expect(seen).toEqual([`Bearer ${KEY}`])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('认证失败')
    expect(JSON.stringify(result)).not.toContain(KEY)
    await server.close()
  })

  it('入参不合法被闸门拦住', () => {
    expect(() => handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, '')).toThrow(IpcInputError)
  })
})

describe('settings:remove-provider（删配置连带清密钥）', () => {
  it('删掉配置与它的密钥，返回合并后的设置；其他 provider 不动', () => {
    const openai: ProviderConfig = { ...DEEPSEEK, id: 'openai', isDefault: false }
    configure(DEEPSEEK, openai)
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)

    const next = handlerOf(IPC_CHANNELS.settings.removeProvider)(EVENT, 'deepseek')

    expect(next).toEqual({ ...DEFAULT_SETTINGS, providers: [openai] })
    expect(readSettings(settingsPath(dir))).toEqual(next)
    expect(handlerOf(IPC_CHANNELS.settings.providerKeyStates)(EVENT)).toEqual({
      openai: { hasKey: false, needsReentry: false }
    })
    expect((JSON.parse(readFileSync(secretsPath(dir), 'utf8')) as { keys: object }).keys).toEqual(
      {}
    )
  })

  it('删不存在的 id 是空操作：返回当前设置，不抛', () => {
    configure(DEEPSEEK)

    expect(handlerOf(IPC_CHANNELS.settings.removeProvider)(EVENT, 'nope')).toEqual({
      ...DEFAULT_SETTINGS,
      providers: [DEEPSEEK]
    })
  })

  it('入参不合法被闸门拦住', () => {
    expect(() => handlerOf(IPC_CHANNELS.settings.removeProvider)(EVENT)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.settings.removeProvider)(EVENT, '')).toThrow(IpcInputError)
  })
})
