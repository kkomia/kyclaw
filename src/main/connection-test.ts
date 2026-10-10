/**
 * "测试连接"：主进程发一条最小请求，验证 配置（type/baseUrl/model）+ 密钥 真的能打通。
 *
 * 走的就是聊天那条路（buildLanguageModel → AI SDK 的 generateText），所以"测试通过"与"能对话"
 * 是同一件事，而不是另写一套探活逻辑。
 *
 * 结果只有两种：延迟（ms）或一句人话错误——**永不抛**（IPC 上不扔原始堆栈），且错误文案里
 * 会把密钥抹掉（供应商偶尔会把 key 回显在错误信息里，而这条文案要回给渲染端）。
 */
import { buildLanguageModel, type KyclawModel } from '../mastra/model'
import type { ConnectionTestResult } from '../shared/ipc'
import type { ProviderConfig } from '../shared/providers'

/** 最小请求的内容与输出上限：只为"通不通"，不为回答质量 */
export const TEST_PROMPT = 'ping'
export const TEST_MAX_OUTPUT_TOKENS = 8

/** 默认超时：网络掐住 20s，用户也该看出不对劲了 */
export const DEFAULT_TEST_TIMEOUT_MS = 20_000

/** 错误文案里可能出现的密钥长度下限（太短的值不replace，免得把正常文案打花） */
const MIN_REDACT_LENGTH = 6

interface GenerateOptions {
  prompt: string
  maxOutputTokens: number
  abortSignal: AbortSignal
  /** 连接测试不做 SDK 重试：用户点一下就该立刻看到通/不通（重试交给用户自己再点） */
  maxRetries: number
}

type GenerateOnce = (model: KyclawModel, options: GenerateOptions) => Promise<unknown>

export interface ConnectionTestDeps {
  timeoutMs?: number
  /** 测试注入：默认用 ai 的 generateText（动态 import，主进程产物是 CJS） */
  generate?: GenerateOnce
}

async function defaultGenerate(model: KyclawModel, options: GenerateOptions): Promise<unknown> {
  const { generateText } = await import('ai')
  return generateText({ model, ...options })
}

/** 抹掉文案里的密钥（精确匹配，不去猜"像不像密钥"） */
function redactSecret(text: string, secret: string): string {
  if (secret.length < MIN_REDACT_LENGTH) return text
  return text.split(secret).join('********')
}

/** 超时/中断：AbortSignal.timeout 抛 DOMException(TimeoutError)，SDK 各处也可能抛 AbortError */
function isTimeoutLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /abort/i.test(message)
}

/** 供应商回的 API 错误（AI SDK 的 APICallError 形状；按字段判别，不 import SDK 类型） */
function apiCallInfo(
  error: unknown
): { statusCode?: number; responseBody?: string; url?: string; message?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as Record<string, unknown>
  if (!('statusCode' in candidate) && !('responseBody' in candidate)) return undefined
  return {
    statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined,
    responseBody: typeof candidate.responseBody === 'string' ? candidate.responseBody : undefined,
    url: typeof candidate.url === 'string' ? candidate.url : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined
  }
}

/** 从供应商的错误体里取一句人话（OpenAI/DeepSeek/Kimi 都是 { error: { message } }） */
function providerMessage(responseBody: string | undefined): string | undefined {
  if (!responseBody) return undefined
  try {
    const parsed = JSON.parse(responseBody) as { error?: unknown; message?: unknown }
    const nested =
      typeof parsed.error === 'object' && parsed.error !== null
        ? (parsed.error as { message?: unknown }).message
        : undefined
    const text =
      typeof nested === 'string'
        ? nested
        : typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : undefined
    return text ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

/** 把各种失败翻译成用户能照着排查的一句话 */
function describeConnectionError(error: unknown, timeoutMs: number): string {
  if (isTimeoutLike(error)) {
    return `连接超时（${Math.round(timeoutMs / 1000)}s）：检查 Base URL 或网络`
  }

  // SDK 带重试时抛的是外层 RetryError（message 是 "Failed after N attempts"），扒到里层才有用
  const lastError =
    typeof error === 'object' && error !== null
      ? (error as { lastError?: unknown }).lastError
      : undefined
  if (lastError !== undefined && lastError !== error) {
    return describeConnectionError(lastError, timeoutMs)
  }

  const api = apiCallInfo(error)
  if (api) {
    const detail = providerMessage(api.responseBody) ?? api.message
    if (api.statusCode === undefined) {
      return `网络错误：无法连接 ${api.url ?? '供应商端点'}${detail ? `（${detail}）` : ''}`
    }
    if (api.statusCode === 401 || api.statusCode === 403) {
      return `认证失败（${api.statusCode}）：${detail ?? 'API Key 无效或没有该模型的权限'}`
    }
    if (api.statusCode === 404) {
      return `端点或模型不存在（404）：${detail ?? '检查 Base URL 与模型名'}`
    }
    if (api.statusCode === 429) {
      return `请求被限流（429）：${detail ?? '稍后重试或检查配额'}`
    }
    return `请求失败（${api.statusCode}）${detail ? `：${detail}` : ''}`
  }

  const message = error instanceof Error ? error.message : String(error)
  return `连接失败：${message}`
}

/**
 * 发一条最小请求。正常返回 `{ok:true, latencyMs}`；任何失败都翻译成 `{ok:false, message}`，
 * 且文案里不含密钥。
 */
export async function testConnection(
  config: ProviderConfig,
  apiKey: string,
  deps: ConnectionTestDeps = {}
): Promise<ConnectionTestResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  const started = Date.now()

  try {
    const model = await buildLanguageModel(config, apiKey)
    const generate = deps.generate ?? defaultGenerate
    await generate(model, {
      prompt: TEST_PROMPT,
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(timeoutMs),
      maxRetries: 0
    })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, message: redactSecret(describeConnectionError(error, timeoutMs), apiKey) }
  }
}
