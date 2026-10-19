// @vitest-environment node
/**
 * R14（PB-038/PB-032）内核 read 探针：html 文本 / MZ 二进制 / **image 分支** / **vision=false 零图片**。
 *
 * 旧 `src/mastra/tools/read*` spec 只证明 0.1.6 宿主 read；本探针证明**内核 read 工具**：
 * - html 返回内容、MZ 拒绝（R14 原两条）；
 * - read 一张图片后，**第二轮模型请求体真实携带图片**（file/image 块 + 非空字节，PB-032 断言 1）；
 * - 模型 catalog 标记 text-only（vision=false）时，第二轮请求体**一个图片字节都不带**（PB-032 断言 2）。
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\deepseekharness\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='E:\gitlab\kyclaw\resources\kernel\rc.2'
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import type { KernelFollowValue } from '../sse-map'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
/** 红态复现：把 image 用例强制跑在 text-only catalog 上（期望断言 1 红）。 */
const FORCE_TEXT_ONLY = process.env.KYCLAW_R14_FORCE_TEXT_ONLY === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'E:\\gitlab\\kyclaw\\resources\\kernel\\rc.2'
const HTML_MARKER = 'R14_HTML_MARKER'
const HTML_TEXT = `<!doctype html><html><body><h1>${HTML_MARKER}</h1><p>read me</p></body></html>`
/** 1x1 透明 PNG（67 字节）；用 base64 固定，避免依赖图片库。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

/** 让模型 catalog 变成 text-only（vision=false）：写内核 profile patch（adapter 会保留预置 patch）。 */
const TEXT_ONLY_PATCH = [
  '- id: llm-deepseek',
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '        name: DeepSeek-V4.1-Flash (text-only test)',
  '        inputModalities:',
  '          - text',
  ''
].join('\n')

interface ImageOccurrence {
  path: string
  block: Record<string, unknown>
}

/** 递归找 Anthropic 内容块里的 image 块（tool_result 的 content 里也可能嵌套）。 */
function collectImages(value: unknown, path = '$'): ImageOccurrence[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectImages(item, `${path}[${String(index)}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const own = record.type === 'image' ? [{ path, block: record }] : []
  return own.concat(
    Object.entries(record).flatMap(([key, child]) => collectImages(child, `${path}.${key}`))
  )
}

/** 内核会产生额外请求（如会话标题），第二轮工具结果请求要按 `tool_result` 找。 */
function findToolResultBody(bodies: unknown[]): unknown {
  return bodies.slice(1).find((body) => JSON.stringify(body).includes('"tool_result"'))
}

/** 会话标题请求与 agent 轮次共用一个 stub：标题请求不计入工具调用次数（否则首次调用会被标题抢走）。 */
function isTitleRequest(raw: string): boolean {
  try {
    const body = JSON.parse(raw) as { tools?: unknown; system?: unknown }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    const system = typeof body.system === 'string' ? body.system : ''
    return !hasTools && system.includes('concise title')
  } catch {
    return false
  }
}

/** 一次工具调用：第一次模型请求发 read(file_path)，第二次回最终文本；记录两次请求体。 */
function startReadStub(
  filePath: string,
  toolName: 'read' | 'read_image'
): Promise<{
  server: Server
  baseUrl: string
  bodies: () => unknown[]
}> {
  let calls = 0
  const bodies: unknown[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      const isTitle = isTitleRequest(raw)
      if (!isTitle) calls += 1
      try {
        bodies.push(JSON.parse(raw) as unknown)
      } catch {
        bodies.push({ unparsed: raw.slice(0, 2000) })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_r14_${String(calls)}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 }
        }
      })
      if (calls === 1) {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_r14_1',
            name: toolName,
            input: { file_path: filePath }
          }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      } else {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '读完了。' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      }
      send('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        bodies: () => bodies
      })
    })
  })
}

function textOfToolResult(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const message = (value as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? [(part as { text?: unknown }).text]
        : []
    )
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

async function runRead(
  filePath: string,
  options: {
    textOnlyModel?: boolean
    toolName?: 'read' | 'read_image'
    /** vision=false 时内核可能在工具执行前就拒绝，不产生 tool/result；此时允许为空。 */
    allowEmptyToolResult?: boolean
  } = {}
): Promise<{
  text: string
  isError: boolean
  bodies: unknown[]
}> {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-r14-'))
  const appDataDir = join(root, 'appdata')
  const textOnlyModel = options.textOnlyModel ?? FORCE_TEXT_ONLY
  if (textOnlyModel) {
    const profileDir = join(appDataDir, 'dsh-kernel-home', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), TEXT_ONLY_PATCH, 'utf8')
  }
  const stub = await startReadStub(filePath, options.toolName ?? 'read')
  let adapter: KernelAdapter | null = null
  try {
    const values: KernelFollowValue[] = []
    const allValues: KernelFollowValue[] = []
    adapter = await startKernelAdapter({
      electronExecutable: ELECTRON,
      asarPath: ASAR,
      appDataDir,
      extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      readyTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      onFollowValue: (value) => {
        allValues.push(value)
        if (value.type === 'event' && value.event.type === 'tool/result') values.push(value)
      }
    })
    await adapter.startTurn('读这个文件')
    if (values.length === 0)
      console.log('[r14] no tool/result; all types', JSON.stringify(allValues).slice(0, 6000))
    if (!options.allowEmptyToolResult) expect(values.length).toBeGreaterThanOrEqual(1)
    const data = values[0]?.type === 'event' ? values[0].event.data : undefined
    const result = data as { message?: { isError?: unknown } } | undefined
    return {
      text: textOfToolResult(data),
      isError: result?.message?.isError === true,
      bodies: stub.bodies()
    }
  } finally {
    await adapter?.stop()
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

describe.runIf(ENABLED)('R14 内核 read 工具探针', () => {
  it('html 返回文本内容（带路径/行号）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-r14-html-'))
    const file = join(root, 'sample.html')
    writeFileSync(file, HTML_TEXT, 'utf8')
    try {
      const result = await runRead(file)
      expect(result.isError).toBe(false)
      expect(result.text).toContain(HTML_MARKER)
      expect(result.text).toContain('<path>')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 120_000)

  it('MZ 二进制仍拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-r14-bin-'))
    const file = join(root, 'sample.bin')
    writeFileSync(file, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03]))
    try {
      const result = await runRead(file)
      expect(result.isError).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 120_000)

  it('PB-032-①：read 图片 → 第二轮请求体真实携带图片（非空字节）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-r14-img-'))
    const file = join(root, 'pixel.png')
    writeFileSync(file, PNG_BYTES)
    try {
      const result = await runRead(file, { toolName: 'read_image' })
      console.log('[r14][image] isError =', result.isError, 'text =', result.text.slice(0, 800))
      expect(result.isError).toBe(false)
      const second = findToolResultBody(result.bodies)
      expect(second, '第二轮模型请求不存在（read 工具没触发 follow-up）').toBeDefined()
      const images = collectImages(second)
      console.log(
        '[r14][image] second request image blocks =',
        JSON.stringify(images.map((item) => ({ path: item.path, type: item.block.type }))).slice(
          0,
          2000
        )
      )
      console.log(
        '[r14][image] second request body snippet =',
        JSON.stringify(second).slice(0, 3000)
      )
      expect(images.length).toBeGreaterThanOrEqual(1)
      const source = images[0]?.block.source as Record<string, unknown> | undefined
      expect(source?.type).toBe('base64')
      expect(typeof source?.data).toBe('string')
      expect(String(source?.data).length).toBeGreaterThan(0)
      // 字节必须真的是这张 PNG（允许 provider 做尺寸/编码处理后前缀不同，但 base64 解码后必须是 PNG 头）
      const decoded = Buffer.from(String(source?.data), 'base64')
      expect(decoded.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 120_000)

  it('PB-032-②：vision=false（text-only catalog）→ 第二轮请求体一个图片字节都不带', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-r14-novision-'))
    const file = join(root, 'pixel.png')
    writeFileSync(file, PNG_BYTES)
    try {
      const result = await runRead(file, {
        textOnlyModel: true,
        toolName: 'read_image',
        allowEmptyToolResult: true
      })
      // text-only 模型下 read 图片可能直接报错（内核拒绝/占位），也可能成功但请求体无图；两种都接受。
      const followups = result.bodies.slice(1)
      const second = findToolResultBody(result.bodies)
      console.log(
        '[r14][no-vision] isError =',
        result.isError,
        'tool-result body present =',
        second !== undefined
      )
      const images = followups.flatMap((body) => collectImages(body))
      console.log('[r14][no-vision] second request image blocks =', images.length)
      console.log(
        '[r14][no-vision] second request body snippet =',
        second === undefined ? '(none)' : JSON.stringify(second).slice(0, 3000)
      )
      expect(images).toHaveLength(0)
      expect(JSON.stringify(second ?? {})).not.toContain(PNG_BASE64.slice(0, 24))
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 120_000)
})
