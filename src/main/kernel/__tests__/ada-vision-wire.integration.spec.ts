// @vitest-environment node
/**
 * PB-033：内核 vision **wire 形状**探针（独立文件，不扩展 b3-2-tool-probe）。
 *
 * 为什么单独建：
 * - `b3-2-tool-probe` 只采 `session/follow` 的工具事件夹具；本探针要断言**模型请求体**的
 *   Anthropic content 块形状/顺序（stub provider 捕获真实请求体），关注点不同；
 * - 与 PB-032 的 read 语义探针分离，失败时能一眼区分「工具没带图」还是「wire 形状变了」。
 *
 * 断言（都要求 stub 捕获真实请求体，打印片段作证据）：
 * 1. vision 开（默认 catalog）：read 图片后第二轮请求体里出现 image 块，source.type=base64/url、
 *    载荷非空、media_type 为 image/*；image 块出现在 tool_result 槽位（或紧随其后），且在文本块之前。
 * 2. vision=false（text-only catalog）：第二轮请求体 image 块数 = 0，且不含 PNG 的 base64 前缀；
 *    tool_result 块仍存在（说明是「模型不支持图」而不是「工具没执行」）。
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

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
/** 红态复现：把 vision=false 用例强制跑在默认（image-capable）catalog 上（期望断言 2 红）。 */
const FORCE_VISION_ON = process.env.KYCLAW_VISION_WIRE_FORCE_ON === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'E:\\gitlab\\kyclaw\\resources\\kernel\\rc.2'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')
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

interface WireBody {
  messages?: Array<{ role?: unknown; content?: unknown }>
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 顶层 content 数组里「该块包含 image」的下标（image 可能嵌在 tool_result.content 里）。 */
function imageBlockIndexes(blocks: unknown[]): number[] {
  return blocks.flatMap((block, index) => (containsImage(block) ? [index] : []))
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage)
  if (!isRecord(value)) return false
  if (value.type === 'image') return true
  return Object.values(value).some(containsImage)
}

function findFirstImage(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findFirstImage(item)
      if (hit !== null) return hit
    }
    return null
  }
  if (!isRecord(value)) return null
  if (value.type === 'image') return value
  for (const child of Object.values(value)) {
    const hit = findFirstImage(child)
    if (hit !== null) return hit
  }
  return null
}

/** 内核会产生额外请求（如会话标题），工具结果请求要按 `tool_result` 找。 */
function findToolResultBody(bodies: unknown[]): unknown {
  return bodies.slice(1).find((body) => JSON.stringify(body).includes('"tool_result"'))
}

/** 一次 read 工具调用 + 捕获第二轮请求体。 */
function startWireStub(filePath: string): Promise<{
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
      calls += 1
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
          id: `msg_pb033_${String(calls)}`,
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
            id: 'toolu_pb033_1',
            name: 'read_image',
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
          delta: { type: 'text_delta', text: '看到了。' }
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

async function captureReadWire(options: { textOnlyModel?: boolean } = {}): Promise<{
  bodies: unknown[]
  isError: boolean
}> {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-pb033-'))
  const appDataDir = join(root, 'appdata')
  const textOnlyModel = FORCE_VISION_ON ? false : options.textOnlyModel === true
  if (textOnlyModel) {
    const profileDir = join(appDataDir, 'dsh-kernel-home', 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), TEXT_ONLY_PATCH, 'utf8')
  }
  const image = join(root, 'pixel.png')
  writeFileSync(image, PNG_BYTES)
  const stub = await startWireStub(image)
  let adapter: KernelAdapter | null = null
  try {
    let isError = false
    let sawToolResult = false
    adapter = await startKernelAdapter({
      electronExecutable: ELECTRON,
      asarPath: ASAR,
      appDataDir,
      extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
      readyTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
      onFollowValue: (value) => {
        if (value.type !== 'event' || value.event.type !== 'tool/result') return
        sawToolResult = true
        const data = value.event.data as { message?: { isError?: unknown } } | undefined
        if (data?.message?.isError === true) isError = true
      }
    })
    await adapter.startTurn('读这张图片并告诉我内容')
    expect(sawToolResult, 'read 工具没有产生 tool/result').toBe(true)
    return { bodies: stub.bodies(), isError }
  } finally {
    await adapter?.stop()
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

describe.runIf(ENABLED)('PB-033 内核 vision wire 形状', () => {
  it('vision 开：第二轮请求体 image 块形状正确、位于 tool_result 槽位且在文本前', async () => {
    const { bodies } = await captureReadWire()
    const second = findToolResultBody(bodies) as WireBody | undefined
    expect(second, '第二轮模型请求不存在').toBeDefined()
    console.log('[pb033][on] second request body snippet =', JSON.stringify(second).slice(0, 4000))

    const messages = Array.isArray(second?.messages) ? second.messages : []
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    expect(lastUser, '第二轮请求里没有 user 消息（工具结果）').toBeDefined()
    const blocks = Array.isArray(lastUser?.content) ? lastUser.content : []
    const toolResultIndex = blocks.findIndex(
      (block) => isRecord(block) && block.type === 'tool_result'
    )
    expect(toolResultIndex, '第二轮 user 消息里没有 tool_result 块').toBeGreaterThanOrEqual(0)

    const imageIndexes = imageBlockIndexes(blocks)
    expect(imageIndexes.length, 'vision 开但第二轮请求体没有 image 块').toBeGreaterThanOrEqual(1)
    const imageIndex = imageIndexes[0] ?? -1
    // 形状：image 在 tool_result 槽位内，或紧随其后；不允许跑到文本后面。
    expect(imageIndex).toBeGreaterThanOrEqual(toolResultIndex)
    expect(imageIndex).toBeLessThanOrEqual(toolResultIndex + 1)
    const firstText = blocks.findIndex((block) => isRecord(block) && block.type === 'text')
    if (firstText >= 0) expect(imageIndex).toBeLessThan(firstText)

    const image = findFirstImage(blocks[imageIndex])
    expect(image, 'image 块解析失败').not.toBeNull()
    expect(image?.type).toBe('image')
    const source = image?.source
    expect(isRecord(source), 'image.source 不是对象').toBe(true)
    if (isRecord(source)) {
      expect(['base64', 'url']).toContain(source.type)
      const payload = source.type === 'base64' ? source.data : source.url
      expect(typeof payload).toBe('string')
      expect(String(payload).length).toBeGreaterThan(0)
      if (source.type === 'base64') {
        expect(String(source.media_type)).toMatch(/^image\//)
        const decoded = Buffer.from(String(source.data), 'base64')
        expect(decoded.subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )
      }
    }
  }, 120_000)

  it('vision=false：第二轮请求体 image 块 = 0，且不含 PNG base64 前缀；tool_result 仍在', async () => {
    const { bodies } = await captureReadWire({ textOnlyModel: true })
    const second = findToolResultBody(bodies) as WireBody | undefined
    console.log('[pb033][off] tool-result body present =', second !== undefined)
    console.log(
      '[pb033][off] second request body snippet =',
      second === undefined ? '(none)' : JSON.stringify(second).slice(0, 4000)
    )
    const messages = Array.isArray(second?.messages) ? second.messages : []
    const lastUser = [...messages].reverse().find((message) => message.role === 'user')
    const blocks = Array.isArray(lastUser?.content) ? lastUser.content : []
    expect(
      blocks.some((block) => isRecord(block) && block.type === 'tool_result'),
      'vision=false 下 tool_result 仍在（是模型不支持图，不是工具没跑）'
    ).toBe(true)
    expect(imageBlockIndexes(blocks), 'vision=false 但请求体出现 image 块').toEqual([])
    expect(JSON.stringify(bodies.slice(1))).not.toContain(PNG_BASE64.slice(0, 24))
  }, 120_000)
})
