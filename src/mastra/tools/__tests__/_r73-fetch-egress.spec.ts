// @vitest-environment node
/**
 * 探针（round 73）：fetch 的**出站边界**。
 *
 * 判据（全部走真 HTTP，只用自己起的 127.0.0.1 桩，不碰任何真实站点）：
 *   A) 环回 / 私网 / 链路本地（含云元数据 169.254.169.254）/ 本机名 一律拒绝，且**一个字节都没发出去**；
 *   B) 重定向**逐跳校验**：302 到内网地址就地停住并如实回报，绝不把内网内容带回来；
 *   C) 域名**解析**到私网也算命中（注入解析器，不依赖真实 DNS）；
 *   D) 白名单是"用户就是要读自己机器上的服务"的出口（主机名或 `主机:端口`）。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from '@mastra/core/tools'
import { createFetchTool, type FetchInput } from '../fetch'
import { callTool, createBed, type TestBed } from './helpers'

/** 秘密服务（模拟"本机 / 内网上的服务"）：只该在用户显式放行时才被读到 */
let secretServer: Server
let secretPort = 0
let secretHits = 0

/** 重定向服务：充当"公网上的那个网页" */
let hopServer: Server
let hopPort = 0
let hopHits = 0

/** 收授权头的回显端点（跨源重定向不该把凭据带过去） */
let seenAuthorization = ''

beforeAll(async () => {
  secretServer = createServer((request, response) => {
    secretHits += 1
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/echo-auth') {
      seenAuthorization = request.headers.authorization ?? '（没有授权头）'
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`auth=${seenAuthorization}`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('内网秘密')
  })
  await new Promise<void>((resolve) => secretServer.listen(0, '127.0.0.1', resolve))
  secretPort = portOf(secretServer)

  hopServer = createServer((request, response) => {
    hopHits += 1
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    switch (path) {
      case '/hop':
        response.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret` })
        response.end('go')
        return
      case '/hop-localhost':
        response.writeHead(302, { location: `http://localhost:${secretPort}/secret` })
        response.end('go')
        return
      case '/hop-auth':
        response.writeHead(302, { location: `http://127.0.0.1:${secretPort}/echo-auth` })
        response.end('go')
        return
      case '/hop-file':
        response.writeHead(302, { location: 'file:///etc/passwd' })
        response.end('go')
        return
      case '/chain':
        response.writeHead(302, { location: '/chain-2' })
        response.end('go')
        return
      case '/chain-2':
        response.writeHead(302, { location: `http://127.0.0.1:${hopPort}/chain-done` })
        response.end('go')
        return
      case '/chain-done':
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('chain-ok')
        return
      case '/loop':
        response.writeHead(302, { location: '/loop' })
        response.end('go')
        return
      default:
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('plain-ok')
    }
  })
  await new Promise<void>((resolve) => hopServer.listen(0, '127.0.0.1', resolve))
  hopPort = portOf(hopServer)
})

afterAll(async () => {
  secretServer.closeAllConnections()
  hopServer.closeAllConnections()
  await new Promise<void>((resolve) => secretServer.close(() => resolve()))
  await new Promise<void>((resolve) => hopServer.close(() => resolve()))
})

let bed: TestBed

beforeEach(() => {
  bed = createBed()
  secretHits = 0
  hopHits = 0
  seenAuthorization = ''
})

afterEach(() => {
  bed.dispose()
})

function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('拿不到桩端口')
  return address.port
}

/** 允许本机桩的注入缝：`127.0.0.1:<端口>` 只在用例显式放行时才通（就是用户白名单那条路） */
function localTool(
  options: {
    allow?: readonly string[]
    lookup?: (host: string) => Promise<readonly string[]>
  } = {}
): Promise<Tool<FetchInput, string>> {
  return createFetchTool(bed.ctx, {
    egress: {
      allowHosts: () => options.allow ?? [`127.0.0.1:${hopPort}`, `127.0.0.1:${secretPort}`],
      ...(options.lookup === undefined ? {} : { lookup: options.lookup })
    }
  })
}

/** 工具结果或抛出的错误都折成一段文本：拒绝口径无论是"回执"还是"错误"都该说清为什么 */
async function run(tool: unknown, input: unknown): Promise<string> {
  try {
    return String(await callTool(tool, input))
  } catch (error) {
    return `THREW:${error instanceof Error ? error.message : String(error)}`
  }
}

describe('fetch 出站边界：拒绝环回 / 私网 / 链路本地（round 73）', () => {
  it('A1) 127.0.0.1 被拒：一个字节都没发出去，回执说清为什么与下一步', async () => {
    const tool = await localTool({ allow: [] })
    const out = await run(tool, { url: `http://127.0.0.1:${secretPort}/secret` })

    process.stdout.write(`\n[A1] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).toContain('127.0.0.1')
    // 没有真的打过去 —— 摸本机的动作一次都不允许发生
    expect(secretHits).toBe(0)
    // 人话 + 下一步（bash/curl 或白名单）
    expect(out).toMatch(/bash|curl/)
    expect(out).toMatch(/白名单/)
  })

  it('A2) 各种环回 / 私网 / 链路本地写法与名字都被拒', async () => {
    const tool = await localTool({ allow: [] })
    const targets = [
      'http://127.0.0.2/',
      'http://127.1/',
      'http://2130706433/',
      `http://localhost:${secretPort}/secret`,
      'http://localhost./',
      'http://foo.local/x',
      'http://mock.internal/x',
      'http://10.1.2.3/x',
      'http://172.20.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://0.0.0.0/x'
    ]

    for (const url of targets) {
      const out = await run(tool, { url, timeout_ms: 1000 })
      process.stdout.write(`[A2] ${url} → ${out.split('\n')[0]}\n`)
      expect(out, url).toContain('已阻断')
    }
    expect(secretHits).toBe(0)
  })

  it('A3) 云元数据那条会点名"链路本地"，别让它被当成普通内网糊过去', async () => {
    const tool = await localTool({ allow: [] })
    const out = await run(tool, { url: 'http://169.254.169.254/latest/meta-data/' })
    expect(out).toContain('169.254.169.254')
    expect(out).toMatch(/链路本地|元数据/)
  })
})

describe('fetch 出站边界：重定向逐跳校验', () => {
  it('B1) 302 到 127.0.0.1：就地停住（内网内容一个字节都不带回来）', async () => {
    // 只放行第一跳（公网那一跳的替身）；被重定向到的那台没在名单里
    const tool = await localTool({ allow: [`127.0.0.1:${hopPort}`] })
    const out = await run(tool, { url: `http://127.0.0.1:${hopPort}/hop` })

    process.stdout.write(`\n[B1] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).toMatch(/重定向/)
    expect(out).not.toContain('内网秘密')
    expect(secretHits).toBe(0)
  })

  it('B2) 302 到 localhost（名字就会被拒），同样停住', async () => {
    const tool = await localTool({ allow: [`127.0.0.1:${hopPort}`] })
    const out = await run(tool, { url: `http://127.0.0.1:${hopPort}/hop-localhost` })

    process.stdout.write(`[B2] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).not.toContain('内网秘密')
    expect(secretHits).toBe(0)
  })

  it('B3) 合法重定向照样跟（两跳、相对地址），最终地址回显', async () => {
    const tool = await localTool()
    const out = await run(tool, { url: `http://127.0.0.1:${hopPort}/chain` })

    process.stdout.write(`[B3] ${out}\n`)
    expect(out).toContain('chain-ok')
    expect(out).toContain(`final-url: http://127.0.0.1:${hopPort}/chain-done`)
  })

  it('B4) 无限重定向不会跟着转到底：有跳数上限', async () => {
    const tool = await localTool()
    const out = await run(tool, { url: `http://127.0.0.1:${hopPort}/loop` })

    process.stdout.write(`[B4] ${out}\n`)
    expect(out).toMatch(/重定向次数超过/)
  })

  it('B5) 跨源重定向不带凭据（Authorization 不跟着跳到别的源）', async () => {
    const tool = await localTool()
    const out = await run(tool, {
      url: `http://127.0.0.1:${hopPort}/hop-auth`,
      headers: { authorization: 'Bearer secret-key-1' }
    })

    process.stdout.write(`[B5] ${out}\n`)
    expect(out).toContain('auth=（没有授权头）')
    expect(out).not.toContain('secret-key-1')
    expect(seenAuthorization).toBe('（没有授权头）')
  })

  it('B6) 重定向到别的协议（file://）也被挡：只跟 http(s)', async () => {
    const tool = await localTool()
    const out = await run(tool, { url: `http://127.0.0.1:${hopPort}/hop-file` })

    process.stdout.write(`[B6] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).toMatch(/不支持的协议/)
    expect(out).not.toContain('root:')
  })
})

describe('fetch 出站边界：域名解析到私网', () => {
  it('C1) 名字解析到内网地址 → 拒绝（注入解析器，不依赖真实 DNS）', async () => {
    const tool = await localTool({ allow: [], lookup: async () => ['10.0.0.5'] })
    const out = await run(tool, { url: 'http://evil.example/x' })

    process.stdout.write(`\n[C1] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).toContain('10.0.0.5')
  })

  it('C2) 公网名字解析到公网地址：不拦（后面连不上是另一回事）', async () => {
    const tool = await localTool({ allow: [], lookup: async () => ['203.0.113.9'] })
    const out = await run(tool, { url: 'http://public.example/x', timeout_ms: 1500 })

    process.stdout.write(`[C2] ${out}\n`)
    expect(out).not.toContain('已阻断')
  })

  it('C3) 解析不出来 → 不冒险（fail closed），并且不谎称"是内网"', async () => {
    const tool = await localTool({
      allow: [],
      lookup: async () => {
        throw new Error('ENOTFOUND')
      }
    })
    const out = await run(tool, { url: 'http://nowhere.example/x' })

    process.stdout.write(`[C3] ${out}\n`)
    expect(out).toContain('已阻断')
    expect(out).toMatch(/解析不出|解析失败/)
  })
})

describe('fetch 出站边界：白名单是合法用法的出口', () => {
  it('D1) 显式放行 主机:端口 → 正常读到本机服务', async () => {
    const tool = await localTool({ allow: [`127.0.0.1:${secretPort}`] })
    const out = await run(tool, { url: `http://127.0.0.1:${secretPort}/secret` })

    process.stdout.write(`\n[D1] ${out}\n`)
    expect(out).toContain('HTTP 200')
    expect(out).toContain('内网秘密')
    expect(secretHits).toBe(1)
  })

  it('D2) 放行是主机粒度：放行了 A 不代表 B 也能读', async () => {
    const tool = await localTool({ allow: [`127.0.0.1:${secretPort}`] })
    const blocked = await run(tool, { url: `http://127.0.0.1:${hopPort}/plain` })
    expect(blocked).toContain('已阻断')
    expect(hopHits).toBe(0)
  })

  it('D3) 通配后缀 `*.local` 也认（用户自己填的白名单形态）', async () => {
    const tool = await localTool({
      allow: ['*.local'],
      lookup: async () => ['203.0.113.9']
    })
    const out = await run(tool, { url: 'http://nas.local/x', timeout_ms: 1500 })
    expect(out).not.toContain('已阻断')
  })

  it('D4) 环境变量也是白名单入口（设置页还没接上时的逃生门，现读）', async () => {
    process.env.KYCLAW_FETCH_ALLOW_HOSTS = `127.0.0.1:${secretPort}`
    try {
      // 一个字都不注入：判定全程走"设置(空) + 环境变量"
      const tool = await createFetchTool(bed.ctx)
      const out = await run(tool, { url: `http://127.0.0.1:${secretPort}/secret` })

      process.stdout.write(`[D4] ${out.split('\n')[0]}\n`)
      expect(out).toContain('内网秘密')
      expect(secretHits).toBe(1)
    } finally {
      delete process.env.KYCLAW_FETCH_ALLOW_HOSTS
    }
  })

  it('D5) 环境变量撤掉后同一条地址又被挡住（不是"放行一次就永久放行"）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = await run(tool, { url: `http://127.0.0.1:${secretPort}/secret` })
    expect(out).toContain('已阻断')
    expect(secretHits).toBe(0)
  })
})
