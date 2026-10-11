// @vitest-environment node
/**
 * fetch 工具（round28 模块 1）：真起一个本机 HTTP server 打这些面 ——
 * GET 文本 / POST 透传（method + headers + body）/ 非 2xx 也回正文 /
 * 二进制与超大响应的元信息与截断 / save_to 下载与"仅 2xx 才写" / 超时与 URL 校验 / 审批 gate。
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFetchTool } from '../fetch'
import { callTool, createBed, type TestBed } from './helpers'

let server: Server
let baseUrl = ''
/** 最后一次请求的回显（POST 透传用例用） */
let seen: { method: string; header?: string; body: string } = { method: '', body: '' }

const DOWNLOAD_BYTES = Buffer.alloc(64 * 1024, 7)

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen = {
        method: request.method ?? '',
        header: request.headers['x-kyclaw'] as string | undefined,
        body
      }
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname

      switch (path) {
        case '/text':
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('你好，文本')
          return
        case '/echo':
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              method: seen.method,
              header: seen.header,
              body: seen.body
            })
          )
          return
        case '/404':
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found body')
          return
        case '/binary':
          response.writeHead(200, { 'content-type': 'image/png' })
          response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
          return
        case '/binary-no-type':
          response.writeHead(200)
          response.end(Buffer.from([1, 2, 0, 3, 4]))
          return
        case '/big': {
          response.writeHead(200, { 'content-type': 'text/plain' })
          for (let index = 1; index <= 8000; index++) {
            response.write(`line-${String(index).padStart(4, '0')}\n`)
          }
          response.end()
          return
        }
        case '/download':
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(DOWNLOAD_BYTES.length)
          })
          response.end(DOWNLOAD_BYTES)
          return
        case '/slow':
          setTimeout(() => {
            response.writeHead(200)
            response.end('late')
          }, 5000)
          return
        default:
          response.writeHead(404)
          response.end('nope')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('拿不到测试端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('fetch：请求与响应', () => {
  it('GET 文本：状态行 + content-type + 正文（中文原样）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/text` }))

    expect(out).toContain('HTTP 200')
    expect(out).toContain('content-type: text/plain; charset=utf-8')
    expect(out).toContain('你好，文本')
  })

  it('POST 透传：method / headers / body 都到服务端', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(
      await callTool(tool, {
        url: `${baseUrl}/echo`,
        method: 'POST',
        headers: { 'x-kyclaw': 'v1' },
        body: 'payload-中文'
      })
    )

    expect(out).toContain('"method":"POST"')
    expect(out).toContain('"header":"v1"')
    expect(out).toContain('payload-中文')
  })

  it('非 2xx：状态码 + 正文都给模型（不是异常）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/404` }))

    expect(out).toContain('HTTP 404')
    expect(out).toContain('not found body')
  })

  it('二进制（content-type 是 image/png）：只回元信息，不回字节', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/binary` }))

    expect(out).toContain('二进制响应')
    expect(out).toContain('image/png')
    expect(out).not.toContain('PNG')
  })

  it('没有 content-type 但有 NUL 字节：按二进制处理（保守）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/binary-no-type` }))
    expect(out).toContain('二进制响应')
  })

  it('超大文本：超过 64KB 首尾保留 + 截断说明（中间行不在）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/big` }))

    expect(out).toContain('line-0001')
    expect(out).toContain('line-8000')
    expect(out).not.toContain('line-4000')
    expect(out).toMatch(/\[输出已截断：共 \d+ 字节/)
  })

  it('GET 带 body：中文人话错误', async () => {
    const tool = await createFetchTool(bed.ctx)
    await expect(callTool(tool, { url: `${baseUrl}/text`, body: 'x' })).rejects.toThrow(
      /GET 请求不能带 body/
    )
  })

  it('非 http(s) 协议：拒绝', async () => {
    const tool = await createFetchTool(bed.ctx)
    await expect(callTool(tool, { url: 'ftp://example.com/x' })).rejects.toThrow(/只支持 http/)
  })

  it('超时：中文人话错误（不是挂着）', async () => {
    const tool = await createFetchTool(bed.ctx)
    await expect(callTool(tool, { url: `${baseUrl}/slow`, timeout_ms: 500 })).rejects.toThrow(
      /请求超时/
    )
  }, 20_000)
})

describe('fetch：save_to 下载', () => {
  it('2xx：流式落盘（父目录自动建），回执带路径与字节数', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/download`, save_to: 'dl/out.bin' }))

    const target = join(bed.root, 'dl', 'out.bin')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).length).toBe(DOWNLOAD_BYTES.length)
    expect(out).toContain('已下载')
    expect(out).toContain(target)
    expect(out).toContain(`${DOWNLOAD_BYTES.length} 字节`)
  })

  it('非 2xx：不写文件（避免把 404 页面当"下载成功"），状态码与正文照回', async () => {
    const tool = await createFetchTool(bed.ctx)
    const out = String(await callTool(tool, { url: `${baseUrl}/404`, save_to: 'dl/404.txt' }))

    expect(existsSync(join(bed.root, 'dl', '404.txt'))).toBe(false)
    expect(out).toContain('HTTP 404')
    expect(out).toContain('未写入')
    expect(out).toContain('not found body')
  })

  it('save_to 在工作区外：拒绝（fail closed），不落盘', async () => {
    const tool = await createFetchTool(bed.ctx)
    await expect(
      callTool(tool, { url: `${baseUrl}/download`, save_to: join(bed.outside, 'x.bin') })
    ).rejects.toThrow(/授权工作区/)
    expect(existsSync(join(bed.outside, 'x.bin'))).toBe(false)
  })

  it('save_to 指向目录：拒绝', async () => {
    const tool = await createFetchTool(bed.ctx)
    await expect(callTool(tool, { url: `${baseUrl}/download`, save_to: '.' })).rejects.toThrow(
      /目录/
    )
  })
})

describe('fetch：审批 gate', () => {
  it('默认问；full 工作区免审；规则放行；save_to 越界不问（执行 fail closed）', async () => {
    const tool = await createFetchTool(bed.ctx)
    const gate = tool.requireApproval as unknown as (input: {
      url: string
      save_to?: string
    }) => boolean

    expect(gate({ url: 'https://example.com/api' })).toBe(true)
    bed.roots[0].mode = 'full'
    expect(gate({ url: 'https://example.com/api' })).toBe(false)
    bed.roots[0].mode = 'ask'

    bed.rules.push({ tool: 'fetch', workspace: bed.root, mode: 'allow' })
    expect(gate({ url: 'https://example.com/api' })).toBe(false)
    expect(gate({ url: 'https://example.com/api', save_to: 'out.bin' })).toBe(false)
    // save_to 解析不出去：执行层会 fail closed，弹卡是噪音（与内置文件工具同口径）
    expect(gate({ url: 'https://example.com/api', save_to: join(bed.outside, 'x.bin') })).toBe(
      false
    )
  })
})
