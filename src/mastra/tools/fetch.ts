/**
 * fetch 工具：发起任意 HTTP(S) 请求（round28 模块 1 的"网络请求"能力）。
 *
 * 能力面：GET / POST（method / headers / body 透传）、超时、重定向跟随（最终地址回显）、
 * **阅读模式（round 45）**：`mode: 'reader'` 时改走 Jina Reader（`{阅读端点}/{url}`）拉干净正文。
 * 契约与取舍：
 *   - **非 2xx 也把状态码 + 正文交给模型**（404 的页面/JSON 是排障信息，不是异常）；
 *     网络层错误（DNS、拒绝连接、超时）才抛中文人话错误。
 *   - **阅读模式（round 45）**：只支持 GET；配了 Jina Key 就带 `Authorization: Bearer`（升配额），
 *     没配就走免费档。它失败时给人话 + "可以直接用默认模式抓原始内容"的出口（默认模式行为一字不动）。
 *   - **无 save_to**：正文最多读 1MB（多的截停，防把内存/上下文撑爆）；文本类回传正文
 *     （超过 64KB 首尾保留），二进制类只回元信息 —— 把 PNG 的字节塞给模型没有意义。
 *   - **有 save_to**：响应体流式落盘（走 guard 的工作区边界与审批；父目录自动建），
 *     **仅 2xx 才写**（404 页面不该以"下载成功"落地）；下载上限 100MB，超限中止并删半截。
 *   - 二进制判定：content-type 明确是文本/JSON/XML 类就按文本；否则看前 8KB 有没有 NUL；
 *     两者都不像文本就按二进制（保守：宁可少回字节，也不吐一屏乱码）。
 *   - v1 不做 SSRF 过滤（个人本机上"能请求任意地址"正是需求）；审批由 guard 的
 *     capability 分支兜底（默认问；fetch 不吃 Full access，只有显式"永久允许"规则能豁免）。
 */
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { WEB_SEARCH_PRESET, readerTargetUrl } from '../../shared/search'
import { clipText, formatSeconds } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'

/** 默认超时（毫秒） */
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000
/** 超时上限（毫秒） */
export const FETCH_MAX_TIMEOUT_MS = 600_000
/** 无 save_to 时最多读取的响应体字节数（之后再读的截停） */
export const FETCH_READ_LIMIT_BYTES = 1024 * 1024
/** 回传给模型的正文上限（字节；超过首尾保留） */
export const FETCH_TEXT_LIMIT_BYTES = 64 * 1024
/** save_to 的下载上限（字节）：超限中止并删掉半截文件 */
export const FETCH_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** 明确按文本处理的 content-type（其余不带 charset 的类型按二进制，保守） */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'application/xhtml+xml',
  'image/svg+xml'
])

export const fetchInputSchema = z.object({
  url: z.string().min(1).describe('请求地址（http:// 或 https://）'),
  method: z.enum(['GET', 'POST']).optional().describe('请求方法（缺省 GET）'),
  headers: z.record(z.string(), z.string()).optional().describe('请求头（可选）'),
  body: z.string().optional().describe('请求体（POST 用；GET 带 body 会被拒绝）'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(FETCH_MAX_TIMEOUT_MS)
    .optional()
    .describe('超时毫秒（缺省 30000，上限 600000）'),
  save_to: z
    .string()
    .optional()
    .describe('把响应保存到工作区里的这个路径（父目录自动建；仅 2xx 才写）'),
  mode: z
    .enum(['raw', 'reader'])
    .optional()
    .describe('raw（缺省）= 直接抓原始响应；reader = 走阅读服务抓干净正文（Markdown，只支持 GET）')
})

export type FetchInput = z.infer<typeof fetchInputSchema>

/**
 * 阅读模式（round 45）的依赖：端点与可选 Key 都**现读**（改设置当场生效，不必重启工具）。
 * 缺省端点 = shared/search 的预置；缺省没有 Key（走免费档）。
 */
export interface FetchReaderOptions {
  endpoint?: () => string
  apiKey?: () => string | null
}

/** 本工具抛出的错误（中文，已可给用户看）：catch 时原样放行，不再包一层 */
const FETCH_ERROR_NAME = 'KyclawFetchError'

function toolError(message: string): Error {
  const error = new Error(message)
  error.name = FETCH_ERROR_NAME
  return error
}

export async function createFetchTool(
  ctx: ToolContext,
  reader?: FetchReaderOptions
): Promise<Tool<FetchInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'fetch',
    description:
      '发起 HTTP(S) 请求（GET/POST，可带 headers 与 body），返回状态码与响应正文（非 2xx 也回正文）。' +
      '响应是二进制或很大时：不带 save_to 只回元信息；带 save_to 则把响应下载到工作区该路径' +
      '（仅 2xx 才写）。**要看一个网页的干净正文（去导航/广告）就带 mode: "reader"**' +
      '（走阅读服务抓 Markdown，只支持 GET）。执行前会请求用户批准。',
    inputSchema: fetchInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'fetch', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const url = parseHttpUrl(input.url)
      const method = input.method ?? 'GET'
      if (method === 'GET' && input.body !== undefined) {
        throw toolError('fetch 失败：GET 请求不能带 body（要发数据请用 method: "POST"）')
      }
      const useReader = input.mode === 'reader'
      if (useReader && method !== 'GET') {
        throw toolError('fetch 失败：阅读模式（mode: "reader"）只支持 GET')
      }

      // save_to 先解析：批了再打的目标写不进去就整单失败（fail closed，不打无意义的请求）
      const saveAbs =
        input.save_to === undefined || input.save_to.trim() === ''
          ? null
          : toolTarget(ctx, input.save_to, sessionKey(context)).abs
      if (saveAbs !== null) {
        const existing = await statOrNull(ctx, saveAbs)
        if (existing?.isDirectory() === true) {
          throw toolError(`fetch 失败：save_to 指向一个目录（${input.save_to}），请给文件路径`)
        }
      }

      // 阅读模式：请求打的是阅读服务（`{端点}/{原 url}`），可选 Jina Key 只进 Authorization 头
      const readerKey = useReader ? (reader?.apiKey?.() ?? null) : null
      const requestUrl = useReader
        ? parseHttpUrl(
            readerTargetUrl(reader?.endpoint?.() ?? WEB_SEARCH_PRESET.readerEndpoint, url.href)
          )
        : url
      const requestHeaders = useReader
        ? {
            accept: 'text/plain',
            ...(readerKey === null || readerKey === ''
              ? {}
              : { authorization: `Bearer ${readerKey}` }),
            ...input.headers
          }
        : input.headers

      const timeoutMs = input.timeout_ms ?? FETCH_DEFAULT_TIMEOUT_MS
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)

      try {
        let response: Response
        try {
          response = await fetch(requestUrl.href, {
            method,
            headers: requestHeaders,
            body: useReader ? undefined : input.body,
            signal: controller.signal,
            redirect: 'follow'
          })
        } catch (error) {
          const failure = fetchFailure(error, timedOut, requestUrl.href, timeoutMs)
          // 阅读模式失败给出口：默认模式一字未改，随时可以退回去抓原始内容
          if (useReader) {
            throw toolError(`${failure.message}；可以改用默认模式（不带 mode）抓原始内容`)
          }
          throw failure
        }

        if (useReader && !response.ok) {
          throw toolError(
            `阅读模式抓取失败：HTTP ${response.status}${response.statusText.trim() === '' ? '' : ` ${response.statusText.trim()}`}` +
              `（${url.href}）；可以改用默认模式（不带 mode）抓原始内容`
          )
        }

        try {
          return saveAbs === null
            ? await readResponseText(response, requestUrl.href)
            : await downloadResponse(response, saveAbs, input.save_to ?? '', requestUrl.href)
        } catch (error) {
          if (error instanceof Error && error.name === FETCH_ERROR_NAME) throw error
          if (isAbortLike(error) || timedOut) {
            throw fetchFailure(error, timedOut, requestUrl.href, timeoutMs)
          }
          throw toolError(`请求失败：${detailOf(error)}（${requestUrl.href}）`)
        }
      } finally {
        clearTimeout(timer)
      }
    }
  })
}

function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw toolError(`fetch 失败：不是合法的 URL（${raw}）`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw toolError(`fetch 失败：只支持 http:// 与 https://，收到 ${url.protocol}//`)
  }
  return url
}

/** 无 save_to：读一段正文回给模型（文本回正文，二进制回元信息） */
async function readResponseText(response: Response, requestedHref: string): Promise<string> {
  const contentType = response.headers.get('content-type')
  const { bytes, more } = await readCapped(response, FETCH_READ_LIMIT_BYTES)

  const header = [
    statusLine(response),
    ...(contentType === null ? [] : [`content-type: ${contentType}`]),
    ...(response.url === requestedHref || response.url === ''
      ? []
      : [`final-url: ${response.url}`]),
    ''
  ]

  if (sniffBinary(contentType, bytes)) {
    const size = bytes.length
    const suffix = more ? `（响应更大，只读取了前 ${size} 字节）` : ''
    return [
      ...header,
      `[二进制响应（${contentType ?? '类型未知'}，已读取 ${size} 字节）${suffix}；未回传正文 —— 要保存请带 save_to]`
    ].join('\n')
  }

  const text = bytes.toString('utf8')
  const clipped = clipText(text, FETCH_TEXT_LIMIT_BYTES)
  const moreNote = more ? `\n[响应超出 ${FETCH_READ_LIMIT_BYTES} 字节上限，已截停]` : ''
  return [...header, clipped.text === '' ? '（空响应体）' : clipped.text + moreNote].join('\n')
}

/** 有 save_to：仅 2xx 流式落盘；非 2xx 按普通响应回状态码 + 正文 */
async function downloadResponse(
  response: Response,
  saveAbs: string,
  saveLabel: string,
  requestedHref: string
): Promise<string> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type')
    const { bytes } = await readCapped(response, FETCH_READ_LIMIT_BYTES)
    const text = sniffBinary(contentType, bytes)
      ? `[二进制响应（${contentType ?? '类型未知'}，${bytes.length} 字节）]`
      : clipText(bytes.toString('utf8'), FETCH_TEXT_LIMIT_BYTES).text || '（空响应体）'
    return [
      statusLine(response),
      ...(contentType === null ? [] : [`content-type: ${contentType}`]),
      `[非 2xx 响应：未写入 ${saveLabel}]`,
      '',
      text
    ].join('\n')
  }

  await mkdir(dirname(saveAbs), { recursive: true })
  const file = await open(saveAbs, 'w')
  let total = 0
  let overflow = false
  try {
    for await (const chunk of response.body ?? []) {
      const buffer = Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > FETCH_MAX_DOWNLOAD_BYTES) {
        overflow = true
        break
      }
      await file.write(buffer)
    }
  } catch (error) {
    await file.close()
    await rm(saveAbs, { force: true })
    // 超时/中止由外层统一映射成"请求超时"；其它错误给人话
    if (isAbortLike(error)) throw error
    throw toolError(`下载中断：${detailOf(error)}（${requestedHref}）`)
  }
  await file.close()

  if (overflow) {
    await rm(saveAbs, { force: true })
    throw toolError(
      `fetch 失败：响应超过 ${FETCH_MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB 下载上限，已中止并删除半截文件`
    )
  }

  const contentType = response.headers.get('content-type')
  return `已下载 → ${saveAbs}（HTTP ${response.status}，${total} 字节${contentType === null ? '' : `，${contentType}`}）`
}

/** 最多读 limit 字节；more=true 表示响应还有未读内容（被我们截停） */
async function readCapped(
  response: Response,
  limit: number
): Promise<{ bytes: Buffer; more: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { bytes: Buffer.alloc(0), more: false }

  const chunks: Buffer[] = []
  let total = 0
  let more = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buffer = Buffer.from(value)
    const room = limit - total
    if (room <= 0) {
      more = true
      await reader.cancel().catch(() => {})
      break
    }
    if (buffer.length > room) {
      chunks.push(buffer.subarray(0, room))
      total += room
      more = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(buffer)
    total += buffer.length
  }
  return { bytes: Buffer.concat(chunks), more }
}

/** content-type 与字节内容合起来的二进制判定（见文件头注） */
export function sniffBinary(contentType: string | null, bytes: Buffer): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type !== '') {
    if (type.startsWith('text/')) return false
    if (TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return false
    return true
  }
  return bytes.subarray(0, 8192).includes(0)
}

function statusLine(response: Response): string {
  const statusText = response.statusText.trim()
  return `HTTP ${response.status}${statusText === '' ? '' : ` ${statusText}`}`
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string' && code !== '') return code
    return error.message
  }
  return String(error)
}

function fetchFailure(error: unknown, timedOut: boolean, href: string, timeoutMs: number): Error {
  if (timedOut) {
    return toolError(`请求超时：超过 ${formatSeconds(timeoutMs)} 秒未完成（${href}）`)
  }
  return toolError(`请求失败：${detailOf(error)}（${href}）`)
}
