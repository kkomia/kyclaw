/**
 * 错误文案要用的三件小事（主进程侧唯一一份）：密钥脱敏、端点地址脱敏、异常翻人话。
 * 这些文字都会**回给渲染端并显示在界面上**，所以脱敏不能只按"整串替换"来。
 */

/** 抹掉之后留下的占位 */
export const REDACTED = '********'

/** 比这还短的"密钥"不参与抹除（免得把正常文案打花） */
const MIN_SECRET_LENGTH = 8

/** 与密钥共享的最短连续片段：短于它的重合当作巧合，不动 */
const MIN_COMMON_RUN = 6

/**
 * 抹掉文案里的密钥。三种形态都盖：整串、URL 编码后的整串、以及**与密钥共享的任意一段
 * 连续 ≥ 6 字符的片段**（供应商只回显首尾几位时靠它兜住）。
 */
export function redactSecret(text: string, secret: string | undefined): string {
  const value = (secret ?? '').trim()
  if (value.length < MIN_SECRET_LENGTH) return text

  let out = replaceAll(text, encodeURIComponent(value), REDACTED)
  out = replaceAll(out, value, REDACTED)
  return redactCommonRuns(out, value)
}

function replaceAll(text: string, needle: string, replacement: string): string {
  if (needle === '') return text
  return text.split(needle).join(replacement)
}

/** 从头扫，每次取"从这一位起与密钥重合的最长一段"；够长就整段换掉，否则原样吐一个字 */
function redactCommonRuns(text: string, secret: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    let matched = 0
    for (let end = index + 1; end <= text.length; end += 1) {
      if (!secret.includes(text.slice(index, end))) break
      matched = end - index
    }
    if (matched >= MIN_COMMON_RUN) {
      out += REDACTED
      index += matched
    } else {
      out += text[index]
      index += 1
    }
  }
  return out
}

/**
 * 写进错误文案的端点地址：**只留 协议 + 主机 + 路径**。
 * userinfo（`user:pass@`）与 query / fragment 一律丢掉 —— 那两处都可能带凭据，
 * 原样回显到界面上等于把凭据交出去。解析不了的半截 URL 只写"供应商端点"，不猜。
 */
export function safeEndpoint(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '供应商端点'
  try {
    const url = new URL(raw)
    const auth = url.username === '' && url.password === '' ? '' : `${REDACTED}@`
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol}//${auth}${url.host}${path}`
  } catch {
    return '供应商端点'
  }
}

/**
 * 文案里出现的 URL 一律脱敏。错误信息经常**整条回显地址**（undici 的
 * "Request cannot be constructed from a URL that includes credentials: http://user:pass@…"
 * 就是原样把凭据打出来），所以从 `url` 字段之外也得扫一遍文本。
 * 只认 URL 合法字符集，中文标点不会被吞进来。
 */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi

export function safeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => safeEndpoint(match))
}

/**
 * 超时/中断：AbortSignal.timeout 抛 DOMException(TimeoutError)，SDK 各处也可能抛 AbortError
 */
export function isTimeoutLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /abort/i.test(message)
}

/** 供应商回的 API 错误（AI SDK 的 APICallError 形状；按字段判别，不 import SDK 类型） */
export interface ApiCallInfo {
  statusCode?: number
  responseBody?: string
  url?: string
  message?: string
}

export function apiCallInfo(error: unknown): ApiCallInfo | undefined {
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

/** 从供应商的错误体里取一句人话（OpenAI/DeepSeek/Kimi 都是 `{ error: { message } }`） */
export function providerMessage(responseBody: string | undefined): string | undefined {
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

/**
 * 各种失败 → 用户能照着排查的一句话（**不含密钥、不含带凭据的 URL**；调用方仍应再过一遍
 * `redactSecret`，因为供应商可能把密钥回显在 `responseBody` 里）。
 * 出口统一过 `safeUrlsInText`：错误信息经常整条回显地址，凭据不能跟着出去。
 */
export function describeCallError(error: unknown, timeoutMs: number, what: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (isTimeoutLike(error)) {
    const budget = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`
    return `${what}超时（${budget}）：检查 Base URL 或网络`
  }

  // Base URL 里带了用户名/密码：undici 直接拒发（原话还会把凭据打出来）—— 换成能照做的一句
  if (/url that includes credentials|includes credentials/i.test(raw)) {
    return 'Base URL 里不能带用户名/密码（user:pass@）：去掉再试'
  }

  // SDK 带重试时抛的是外层 RetryError（message 是 "Failed after N attempts"），扒到里层才有用
  const lastError =
    typeof error === 'object' && error !== null
      ? (error as { lastError?: unknown }).lastError
      : undefined
  if (lastError !== undefined && lastError !== error) {
    return describeCallError(lastError, timeoutMs, what)
  }

  const api = apiCallInfo(error)
  if (api) {
    const detail = providerMessage(api.responseBody) ?? api.message
    if (api.statusCode === undefined) {
      return safeUrlsInText(
        `网络错误：无法连接 ${safeEndpoint(api.url)}${detail ? `（${detail}）` : ''}`
      )
    }
    if (api.statusCode === 401 || api.statusCode === 403) {
      return safeUrlsInText(
        `认证失败（${api.statusCode}）：${detail ?? 'API Key 无效或没有该模型的权限'}`
      )
    }
    if (api.statusCode === 404) {
      return safeUrlsInText(`端点或模型不存在（404）：${detail ?? '检查 Base URL 与模型名'}`)
    }
    if (api.statusCode === 429) {
      return safeUrlsInText(`请求被限流（429）：${detail ?? '稍后重试或检查配额'}`)
    }
    return safeUrlsInText(`请求失败（${api.statusCode}）${detail ? `：${detail}` : ''}`)
  }

  return safeUrlsInText(`连接失败：${raw}`)
}

/** 探测/列清单这类"顺带问一句"的失败：措辞短一点（弹窗里那行字用） */
export function describeProbeError(error: unknown, timeoutMs: number, apiKey: string): string {
  return redactSecret(describeCallError(error, timeoutMs, '读模型清单'), apiKey)
}
