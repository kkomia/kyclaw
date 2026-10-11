import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 思考翻译通道的 handler（round 32）：先过入参闸门，再按设置现读服务配置、解出来密钥发请求。
 * 与设置通道同一套 mock 方式（假 ipcMain + 反转字符串的假 safeStorage），临时 userData 目录。
 * 翻译请求打**本地假服务**（真 HTTP）——验的是"设置里的地址/模型/目标语言真的用上了、
 * 密钥真的进了 Authorization 头、回包与文案都不含明文"。
 *
 * 不碰真网络：预置地址（用户局域网那台）只由 shared/__tests__/settings.spec.ts 在纯函数层验证
 * 兜底（effectiveReasoningTranslate），这里一律把 baseUrl 指到本地假服务。
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
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from([...plain].reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => [...encrypted.toString('utf8')].reverse().join('')
  }
}))

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS, REASONING_TRANSLATE_PRESET } from '../../../shared/settings'
import { TRANSLATE_KEY_SECRET_ID, TRANSLATE_MAX_CHARS } from '../../../shared/translate'
import { secretsPath } from '../../secrets'
import { readSettings, settingsPath, writeSettings } from '../../settings'
import { registerTranslateIpc } from '../translate'

const EVENT = { sender: { id: 1 } }
const KEY = 'sk-ipc-translate-SECRET'

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

type RequestLog = { url?: string; authorization?: string; body: string }

const openServers: Array<{ close: () => Promise<void> }> = []

async function startFakeService(
  content = '我先读一下配置。'
): Promise<{ log: RequestLog[]; baseUrl: string }> {
  const log: RequestLog[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      log.push({ url: request.url, authorization: request.headers.authorization, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  openServers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
  return { log, baseUrl: `http://127.0.0.1:${port}/v1` }
}

/** 摆一份落盘的翻译设置（翻译通道自己读盘，不经过 settings 通道） */
function storeTranslate(patch: Partial<(typeof DEFAULT_SETTINGS)['reasoningTranslate']>): void {
  writeSettings(settingsPath(dir), {
    ...DEFAULT_SETTINGS,
    reasoningTranslate: { ...DEFAULT_SETTINGS.reasoningTranslate, ...patch }
  })
}

let dir: string

beforeEach(() => {
  mocks.handlers.clear()
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-translate-ipc-'))
  registerTranslateIpc(dir)
})

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('translate 通道 handler', () => {
  it('四条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'translate:clear-key',
      'translate:key-state',
      'translate:run',
      'translate:set-key'
    ])
  })

  it('translate:run 用设置里的地址/模型/目标语言（入参只给 text 时按设置兜底）', async () => {
    const service = await startFakeService()
    storeTranslate({
      enabled: true,
      baseUrl: service.baseUrl,
      model: 'my-translate-model',
      targetLanguage: '繁體中文'
    })

    const result = await handlerOf(IPC_CHANNELS.translate.run)(EVENT, {
      text: 'Let me read the config first.'
    })

    expect(result).toEqual({ ok: true, text: '我先读一下配置。' })
    expect(service.log).toHaveLength(1)
    expect(service.log[0].url).toBe('/v1/chat/completions')
    // 本 LAN 服务不需要 key：没配就不带 Authorization 头
    expect(service.log[0].authorization).toBeUndefined()
    const body = JSON.parse(service.log[0].body) as {
      model: string
      messages: Array<{ content: string }>
    }
    expect(body.model).toBe('my-translate-model')
    expect(body.messages[0].content).toContain('请将以下文本翻译为繁體中文')
  }, 30_000)

  it('入参的 targetLanguage 优先于设置；模型名落盘为空串时按预置兜底', async () => {
    const service = await startFakeService()
    storeTranslate({
      enabled: true,
      baseUrl: service.baseUrl,
      model: '',
      targetLanguage: '简体中文'
    })

    const result = await handlerOf(IPC_CHANNELS.translate.run)(EVENT, {
      text: 'Hello there.',
      targetLanguage: '日本語'
    })

    expect(result).toEqual({ ok: true, text: '我先读一下配置。' })
    const body = JSON.parse(service.log[0].body) as {
      model: string
      messages: Array<{ content: string }>
    }
    expect(body.model).toBe(REASONING_TRANSLATE_PRESET.model)
    expect(body.messages[0].content).toContain('请将以下文本翻译为日本語')
  }, 30_000)

  it('密钥：写只回 {hasKey:true}、状态只有"有没有"、磁盘是密文、请求带 Bearer、回包不含明文', async () => {
    const service = await startFakeService('译文')
    storeTranslate({ enabled: true, baseUrl: service.baseUrl })

    const written = handlerOf(IPC_CHANNELS.translate.setKey)(EVENT, KEY)
    expect(written).toEqual({ hasKey: true })
    expect(JSON.stringify(written)).not.toContain(KEY)

    const state = handlerOf(IPC_CHANNELS.translate.keyState)(EVENT)
    expect(state).toEqual({ hasKey: true, needsReentry: false })
    expect(JSON.stringify(state)).not.toContain(KEY)

    const raw = readFileSync(secretsPath(dir), 'utf8')
    expect(raw).not.toContain(KEY)
    const stored = JSON.parse(raw) as { keys: Record<string, string> }
    expect(stored.keys[TRANSLATE_KEY_SECRET_ID]).toBeDefined()

    const result = await handlerOf(IPC_CHANNELS.translate.run)(EVENT, { text: 'Hello' })
    expect(result).toEqual({ ok: true, text: '译文' })
    expect(service.log[0].authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(result)).not.toContain(KEY)

    // 清密钥（幂等；返回清除后的状态）
    expect(handlerOf(IPC_CHANNELS.translate.clearKey)(EVENT)).toEqual({
      hasKey: false,
      needsReentry: false
    })
  }, 30_000)

  it('run 只读设置不写设置（现读现用，落盘原样）', async () => {
    storeTranslate({ enabled: true, baseUrl: 'http://127.0.0.1:1/v1' })
    const before = readSettings(settingsPath(dir))

    const result = await handlerOf(IPC_CHANNELS.translate.run)(EVENT, { text: 'Hello' })

    expect(result).toMatchObject({ ok: false })
    expect(readSettings(settingsPath(dir))).toEqual(before)
  }, 30_000)

  it('入参闸门：缺入参 / 空文本 / 超长文本 / 多键 / 目标语言形状不对都抛 IpcInputError', async () => {
    // run 是 async handler：闸门抛出的 IpcInputError 走 rejected promise（真 IPC 上就是 invoke 失败）
    const handler = handlerOf(IPC_CHANNELS.translate.run)

    for (const args of [
      [],
      [{}],
      [{ text: '' }],
      [{ text: 'hi', targetLanguage: 1 }],
      [{ text: 'hi', extra: 1 }],
      [{ text: 'x'.repeat(TRANSLATE_MAX_CHARS + 1) }]
    ]) {
      await expect(handler(EVENT, ...args), JSON.stringify(args).slice(0, 40)).rejects.toThrow(
        IpcInputError
      )
    }
  })

  it('密钥通道的入参闸门：set-key 要非空字符串，key-state / clear-key 不收参数', () => {
    expect(() => handlerOf(IPC_CHANNELS.translate.setKey)(EVENT)).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.translate.setKey)(EVENT, '')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.translate.setKey)(EVENT, 'k', 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.translate.keyState)(EVENT, 'x')).toThrow(IpcInputError)
    expect(() => handlerOf(IPC_CHANNELS.translate.clearKey)(EVENT, 'x')).toThrow(IpcInputError)
  })
})
