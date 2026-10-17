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
 * 例外是 `settings:reveal-provider-key`（用户显式点眼睛）：它**应当**回一次真实明文，
 * 但失败文案与落盘文件仍不能含明文/密文（见对应 describe）。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    decryptFails: false,
    /** 007 的只读发现：默认空表，用例自己喂返回值/抛错 */
    listProviderModels: vi.fn(async () => [] as { id: string; contextWindow?: number }[]),
    /** 007（补齐）：拿刚填的地址/密钥发现模型；默认"读不到"，用例自己喂 */
    discoverProviderModels: vi.fn(
      async (): Promise<
        | { ok: true; models: { id: string; contextWindow?: number }[] }
        | { ok: false; message: string }
      > => ({ ok: false, message: '读不到模型清单' })
    )
  }
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

/**
 * 后台探测（provider 保存后 fire-and-forget，round 22 / 48）换空实现：这份用例只测通道本身的行为，
 * 探测请求（GET /models + 一条带图 chat）会跟"连接测试"抢同一个假服务器、把请求计数搅浑
 * （保存 provider 时还没有 key，但探测的第二趟在微任务里跑，key 可能已经落进去了）。
 * 探测自己的行为在 src/main/__tests__/model-probe.spec.ts 里测；007 的只读发现（listProviderModels）
 * 也换成可注入的假件——这里测的是"通道怎么用它"，不是它自己怎么发请求。
 */
vi.mock('../../model-probe', () => ({
  probeProviderModelsQuietly: async () => undefined,
  listProviderModels: mocks.listProviderModels,
  discoverProviderModels: mocks.discoverProviderModels
}))

import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'
import { secretsPath } from '../../secrets'
import { outsideMode } from '../../permission/outside-mode'
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
  mocks.listProviderModels.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-settings-ipc-'))
  registerSettingsIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('settings 通道 handler', () => {
  it('十一条 invoke 通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'settings:discover-provider-models',
      'settings:effective-theme',
      'settings:get',
      'settings:list-provider-models',
      'settings:probe-models',
      'settings:provider-key-states',
      'settings:remove-provider',
      'settings:reveal-provider-key',
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

  it('settings:effective-theme 走注入的解析器；没有 hook 时回 light', () => {
    expect(handlerOf(IPC_CHANNELS.settings.effectiveTheme)(EVENT)).toBe('light')

    mocks.handlers.clear()
    const effectiveTheme = vi.fn(() => 'dark' as const)
    registerSettingsIpc(dir, { effectiveTheme })

    expect(handlerOf(IPC_CHANNELS.settings.effectiveTheme)(EVENT)).toBe('dark')
    expect(effectiveTheme).toHaveBeenCalledTimes(1)
  })

  it('settings:update 合并补丁、落盘，并回吐合并后的完整设置', () => {
    const next = handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'light' })

    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
    expect(readSettings(settingsPath(dir))).toEqual(next)
    expect(handlerOf(IPC_CHANNELS.settings.get)(EVENT)).toEqual(next)
  })

  it('012：theme 落盘后通知 onThemeSaved（运行时切 system 的接线点）', () => {
    mocks.handlers.clear()
    const onThemeSaved = vi.fn()
    registerSettingsIpc(dir, { onThemeSaved })

    const next = handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'system' }) as {
      theme: string
    }

    expect(next.theme).toBe('system')
    expect(onThemeSaved).toHaveBeenCalledWith('system')
    expect(readSettings(settingsPath(dir)).theme).toBe('system')
  })

  it('012：只改字号不触发主题通知', () => {
    mocks.handlers.clear()
    const onThemeSaved = vi.fn()
    registerSettingsIpc(dir, { onThemeSaved })

    handlerOf(IPC_CHANNELS.settings.update)(EVENT, { fontTier: 'large' })

    expect(onThemeSaved).not.toHaveBeenCalled()
  })

  it('主题 hook 抛错会向调用方传播（此时设置已落盘）', () => {
    mocks.handlers.clear()
    const onThemeSaved = vi.fn(() => {
      throw new Error('主题同步失败')
    })
    registerSettingsIpc(dir, { onThemeSaved })

    expect(() => handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'dark' })).toThrow(
      '主题同步失败'
    )
    expect(readSettings(settingsPath(dir)).theme).toBe('dark')
  })

  it('settings:update 的非法补丁被入参闸门拦住：抛 IpcInputError，文件不动', () => {
    const handler = handlerOf(IPC_CHANNELS.settings.update)
    const before = readSettings(settingsPath(dir))

    for (const bad of [
      [{ theme: 'blue' }],
      [{ fontTier: 'huge' }],
      [{ outsideWorkspaceMode: 'always' }],
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

  it('round 75：「工作区之外」那一档经这条通道落盘，并刷进审批判定的运行期镜像', () => {
    // handler 的返回面是 unknown（IPC 边界）；回吐的就是合并后的设置，按 readSettings 的读法收窄
    const next = handlerOf(IPC_CHANNELS.settings.update)(EVENT, {
      outsideWorkspaceMode: 'full'
    }) as ReturnType<typeof readSettings>

    expect(next.outsideWorkspaceMode).toBe('full')
    expect(readSettings(settingsPath(dir)).outsideWorkspaceMode).toBe('full')
    // 审批判定读的就是这个镜像（guard 的 ToolContext 缺省来源，见 permission/outside-mode.ts）
    expect(outsideMode()).toBe('full')

    handlerOf(IPC_CHANNELS.settings.update)(EVENT, { outsideWorkspaceMode: 'ask' })
    expect(outsideMode()).toBe('ask')
  })

  it('落盘失败时把错误抛给调用方（不静默吞掉用户的改动），也不触发主题通知', () => {
    // 父路径是文件 → mkdir 必失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')
    const onThemeSaved = vi.fn()
    mocks.handlers.clear()
    registerSettingsIpc(blocked, { onThemeSaved })

    expect(() => handlerOf(IPC_CHANNELS.settings.update)(EVENT, { theme: 'dark' })).toThrow()
    expect(onThemeSaved).not.toHaveBeenCalled()
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

describe('settings:reveal-provider-key（仅用户显式点击时回显真实密钥）', () => {
  it('已配置且密钥可解：回 {ok:true,key}；只读——设置与密钥文件一个字节都不动', () => {
    configure(DEEPSEEK)
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)
    const settingsBefore = readFileSync(settingsPath(dir), 'utf8')
    const secretsBefore = readFileSync(secretsPath(dir), 'utf8')

    const revealed = handlerOf(IPC_CHANNELS.settings.revealProviderKey)(EVENT, 'deepseek')

    expect(revealed).toEqual({ ok: true, key: KEY })
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(settingsBefore)
    expect(readFileSync(secretsPath(dir), 'utf8')).toBe(secretsBefore)
  })

  it('没配过 / provider 不在设置里 / 解不开：结构化失败，不回显任何密文或明文', () => {
    configure(DEEPSEEK)

    // 没配过密钥
    expect(handlerOf(IPC_CHANNELS.settings.revealProviderKey)(EVENT, 'deepseek')).toEqual({
      ok: false,
      reason: 'not-configured',
      message: '还没有保存 API Key'
    })
    // 有孤儿密文（配置里没有这条 provider）也不回显
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'ghost', KEY)
    const ghost = handlerOf(IPC_CHANNELS.settings.revealProviderKey)(EVENT, 'ghost')
    expect(ghost).toMatchObject({ ok: false, reason: 'not-configured' })
    expect(JSON.stringify(ghost)).not.toContain(KEY)

    // 存过但本机解不开（换机/迁移）：报"需重录"，不回显密文
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)
    mocks.decryptFails = true
    const unreadable = handlerOf(IPC_CHANNELS.settings.revealProviderKey)(EVENT, 'deepseek')
    expect(unreadable).toMatchObject({ ok: false, reason: 'needs-reentry' })
    expect(JSON.stringify(unreadable)).not.toContain(KEY)
    // 反向密文（测试 mock 的加密结果）也不能出现在失败文案里
    expect(JSON.stringify(unreadable)).not.toContain([...KEY].reverse().join(''))
  })

  it('入参不合法（缺 id / 空串 / 多参）被闸门拦住', () => {
    const handler = handlerOf(IPC_CHANNELS.settings.revealProviderKey)

    for (const args of [[], [''], ['deepseek', 'extra'], [1]]) {
      expect(() => handler(EVENT, ...args), JSON.stringify(args)).toThrow(IpcInputError)
    }
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
  it('找不到 id → ok:false + 文案，三步都是"没跑"（不抛）', () => {
    const result = handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'nope') as {
      ok: boolean
      message: string
      steps: Array<{ id: string; status: string }>
    }

    expect(result.ok).toBe(false)
    expect(result.message).toBe('找不到 provider：nope')
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ['connectivity', 'failed'],
      ['streaming', 'skipped'],
      ['tools', 'skipped']
    ])
  })

  it('anthropic 缺密钥：不发任何请求，直接回"配置不完整：缺 API 密钥"（不静默回落 mock）', async () => {
    const hits: string[] = []
    const server = await startHttpServer((request, response) => {
      hits.push(request.url ?? '')
      response.end('{}')
    })
    // anthropic 走官方端点（配置里没有 baseUrl），密钥是必填的
    configure({
      id: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      isDefault: true
    })

    const result = (await handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'anthropic')) as {
      ok: boolean
      message: string
    }

    expect(result.ok).toBe(false)
    expect(result.message).toBe('配置不完整：缺 API 密钥')
    expect(hits).toEqual([])
    await server.close()
  })

  it('官方云主机（deepseek 预置）+ 没有密钥：直接回"配置不完整：缺 API 密钥"（原口径不变）', async () => {
    // 地址是官方云主机（预置表里那三个之一）→ 密钥必填：闸门在发请求之前就拦下来
    configure({
      id: 'deepseek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      isDefault: true
    })

    const result = (await handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'deepseek')) as {
      ok: boolean
      message: string
      steps: Array<{ id: string; status: string }>
    }

    expect(result.ok).toBe(false)
    expect(result.message).toBe('配置不完整：缺 API 密钥')
    // 三步全没跑（连通那一步的 detail 就是这句人话）
    expect(result.steps.map((step) => step.status)).toEqual(['failed', 'skipped', 'skipped'])
  })

  it('打包态实报：openai 兼容的自定义端点**没有密钥也照样测**（本机服务那类，真 HTTP/SSE 端到端）', async () => {
    const seen: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = []
    const server = await startHttpServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
          string,
          unknown
        >
        seen.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: parsed
        })
        if (request.headers.authorization !== undefined) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: '这个端点不要密钥' } }))
          return
        }
        // 流式那两趟（正文 + 工具）走 SSE；非流式那趟走普通 JSON
        if (parsed.stream === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(
            `data: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'local-model',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }]
            })}\n\ndata: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'local-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}\n\ndata: [DONE]\n\n`
          )
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 1,
            model: 'local-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }
            ]
          })
        )
      })
    })
    // 没有 setProviderKey → 这条 provider 一个密钥都没有
    configure({
      id: 'custom-1',
      type: 'openai-compatible',
      baseUrl: server.url,
      model: 'local-model',
      isDefault: true
    })

    const result = (await handlerOf(IPC_CHANNELS.settings.testProvider)(EVENT, 'custom-1')) as {
      ok: boolean
      steps: Array<{ id: string; status: string }>
    }

    // 连通 + 流式都真跑通了（第三步是工具那趟，见 connection-test.spec 的判据）
    expect(result.ok).toBe(true)
    expect(result.steps.slice(0, 2).map((step) => [step.id, step.status])).toEqual([
      ['connectivity', 'passed'],
      ['streaming', 'passed']
    ])
    expect(seen.length).toBeGreaterThanOrEqual(2)
    // 一个 Authorization 头都没发（SDK 在空密钥时不发头，而不是发空 Bearer）
    expect(seen.every((entry) => entry.authorization === undefined)).toBe(true)
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

describe('settings:list-provider-models（用户反馈 007：只读发现，不落盘）', () => {
  it('拿这条 provider 的密钥列清单，回可选项；设置文件一个字节都不动', async () => {
    configure(DEEPSEEK)
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)
    const before = readSettings(settingsPath(dir))
    mocks.listProviderModels.mockResolvedValueOnce([
      { id: 'deepseek-flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-pro' }
    ])

    const list = await handlerOf(IPC_CHANNELS.settings.listProviderModels)(EVENT, 'deepseek')

    expect(list).toEqual([
      { id: 'deepseek-flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-pro' }
    ])
    // 用的是落盘那条配置 + 它自己的密钥（密钥只进主进程）
    expect(mocks.listProviderModels).toHaveBeenCalledWith(DEEPSEEK, KEY)
    // 只读：设置（含 probedModels）原样不动
    expect(readSettings(settingsPath(dir))).toEqual(before)
    expect(before.probedModels).toEqual({})
  })

  it('没配密钥 / 不认识这条 provider → 空数组，连请求都不发（不是硬错）', async () => {
    configure(DEEPSEEK)

    expect(await handlerOf(IPC_CHANNELS.settings.listProviderModels)(EVENT, 'deepseek')).toEqual([])
    expect(await handlerOf(IPC_CHANNELS.settings.listProviderModels)(EVENT, 'nope')).toEqual([])
    expect(mocks.listProviderModels).not.toHaveBeenCalled()
  })

  it('端点没有 /models（抓取抛）→ 空数组 + 一句 warn：不把"读不到"变成用户眼前的报错', async () => {
    configure(DEEPSEEK)
    handlerOf(IPC_CHANNELS.settings.setProviderKey)(EVENT, 'deepseek', KEY)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.listProviderModels.mockRejectedValueOnce(new Error('模型清单请求失败（404）'))

    const list = await handlerOf(IPC_CHANNELS.settings.listProviderModels)(EVENT, 'deepseek')

    expect(list).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('入参不合法被闸门拦住（id 缺失 / 空串 / 多参）', async () => {
    const handler = handlerOf(IPC_CHANNELS.settings.listProviderModels)
    for (const args of [[], [''], ['deepseek', 'x']]) {
      await expect((async () => handler(EVENT, ...args))(), JSON.stringify(args)).rejects.toThrow(
        IpcInputError
      )
    }
  })
})

describe('settings:discover-provider-models（007 补齐：还没保存的端点也能发现）', () => {
  beforeEach(() => {
    mocks.discoverProviderModels.mockClear()
  })

  it('把弹窗里刚填的 type/baseUrl/apiKey 交给发现逻辑，回包原样（ok:false 也是一等结果）', async () => {
    mocks.discoverProviderModels.mockResolvedValueOnce({
      ok: true,
      models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash', contextWindow: 1_048_576 }]
    })

    const result = await handlerOf(IPC_CHANNELS.settings.discoverProviderModels)(EVENT, {
      type: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: KEY
    })

    expect(result).toEqual({
      ok: true,
      models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash', contextWindow: 1_048_576 }]
    })
    expect(mocks.discoverProviderModels).toHaveBeenCalledWith(
      { type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      KEY
    )

    mocks.discoverProviderModels.mockResolvedValueOnce({ ok: false, message: '认证失败（401）' })
    await expect(
      handlerOf(IPC_CHANNELS.settings.discoverProviderModels)(EVENT, {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: KEY
      })
    ).resolves.toEqual({ ok: false, message: '认证失败（401）' })
  })

  it('**不落盘**：这条通道不写设置、不写密钥（弹窗里还没点保存）', async () => {
    const before = readSettings(settingsPath(dir))
    mocks.discoverProviderModels.mockResolvedValueOnce({ ok: true, models: [] })

    await handlerOf(IPC_CHANNELS.settings.discoverProviderModels)(EVENT, {
      type: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: KEY
    })

    expect(readSettings(settingsPath(dir))).toEqual(before)
    expect(existsSync(secretsPath(dir))).toBe(false)
  })

  it('apiKey 可以为空串（本机服务那类）：原样交给发现逻辑，通道不替服务一刀切', async () => {
    mocks.discoverProviderModels.mockResolvedValueOnce({
      ok: false,
      message: '这个端点需要 API Key（401）：填一把再试；本机服务通常不需要'
    })

    await expect(
      handlerOf(IPC_CHANNELS.settings.discoverProviderModels)(EVENT, {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: ''
      })
    ).resolves.toEqual({
      ok: false,
      message: '这个端点需要 API Key（401）：填一把再试；本机服务通常不需要'
    })
    // 空密钥照旧递下去（要不要认证由端点回），通道层不预先拦
    expect(mocks.discoverProviderModels).toHaveBeenCalledWith(
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' },
      ''
    )
  })

  it('入参不合法被闸门拦住（缺 type / 多字段 / 报错文案里不含密钥）', async () => {
    const handler = handlerOf(IPC_CHANNELS.settings.discoverProviderModels)

    for (const args of [
      [],
      [{ baseUrl: 'https://x', apiKey: KEY }],
      [{ type: 'openai', baseUrl: 'https://x', apiKey: KEY }],
      [{ type: 'openai-compatible', baseUrl: 'https://x', apiKey: KEY, evil: 1 }],
      [{ type: 'openai-compatible', baseUrl: 'https://x', apiKey: KEY }, 'extra']
    ]) {
      let thrown: unknown
      try {
        await handler(EVENT, ...args)
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(args)).toBeInstanceOf(IpcInputError)
      // 闸门的报错里也不能出现密钥（zod 的 issue 只说形状，不回显值）
      expect(JSON.stringify(thrown instanceof Error ? thrown.message : thrown)).not.toContain(KEY)
    }
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
