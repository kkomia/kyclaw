/**
 * 思考翻译的主进程侧（round 32）：一条 `POST {baseUrl}/chat/completions`，把结果翻成一句人话。
 *
 * 为什么在主进程（与 model-probe / connection-test 同一口径）：渲染端有 CSP、也不该拿着密钥；
 * 这里 fetch 直连，密钥只进 Authorization 头，**明文不进日志、不回渲染端**（错误文案里只写状态码，
 * 供应商回显的正文一律不转给用户）。
 *
 * 纪律：
 *   - 超时 60s（本地 2B 模型对长文本慢，但也不该把渲染端挂住；`AbortSignal.timeout` 自带）；
 *   - 解析逐项防御：`choices[0].message.content`（string 或 content-parts 数组）/ `choices[0].text`，
 *     取不到就是"没有内容"，不把半截响应当译文；
 *   - 失败 = `{ok:false, message}`（不抛）：译文拿不到是常态，界面留着原文 + 重试即可。
 */
import { translateEndpoint, translatePrompt, type TranslateResult } from '../shared/translate'

/** 单次翻译的超时（毫秒） */
export const TRANSLATE_TIMEOUT_MS = 60_000

/** 可注入的依赖（单测给假 fetch / 短超时，不碰真网络） */
export interface TranslateDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface TranslateInput extends TranslateDeps {
  text: string
  targetLanguage: string
  /** OpenAI 兼容 baseURL（调用方已按预置兜底） */
  baseUrl: string
  model: string
  /** 可选密钥；null / 空串 = 不带 Authorization（本 LAN 服务不需要） */
  apiKey: string | null
}

/** 网络层错误 → 人话（超时 / 连不上两档；不带堆栈、不带密钥） */
function networkMessage(error: unknown, url: string, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `翻译服务响应超时（${Math.round(timeoutMs / 1000)} 秒）`
  }
  return `连不上翻译服务（${url}）：检查服务地址与网络`
}

/** 从 OpenAI 兼容回包里取译文（取不到回 null；容忍 content 是 parts 数组的写法） */
function contentOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null

  const message = (first as { message?: unknown }).message
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts = content
        .map((part) =>
          typeof part === 'object' &&
          part !== null &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''
        )
        .join('')
      if (parts !== '') return parts
    }
  }

  const text = (first as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

/**
 * 翻一段文本。永远回 `TranslateResult`（不抛）：失败也是产品语言的一等结果。
 * 请求体刻意最小：单条 user 消息（提示词格式见 shared/translate.translatePrompt）+ 贪婪解码。
 */
export async function translateText(input: TranslateInput): Promise<TranslateResult> {
  const url = translateEndpoint(input.baseUrl)
  const timeoutMs = input.timeoutMs ?? TRANSLATE_TIMEOUT_MS

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (input.apiKey !== null && input.apiKey !== '') {
    headers.authorization = `Bearer ${input.apiKey}`
  }

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        messages: [{ role: 'user', content: translatePrompt(input.text, input.targetLanguage) }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    return { ok: false, message: networkMessage(error, url, timeoutMs) }
  }

  if (!response.ok) {
    return { ok: false, message: `翻译服务返回错误（HTTP ${response.status}）` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, message: '翻译服务的响应不是 JSON：这个地址不是 OpenAI 兼容接口？' }
  }

  const content = contentOf(payload)
  if (content === null || content.trim() === '') {
    return { ok: false, message: '翻译服务没有返回内容' }
  }
  return { ok: true, text: content.trim() }
}
