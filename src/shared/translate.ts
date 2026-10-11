/**
 * 思考翻译的契约（round 32）：把"这段思考要不要翻、怎么翻、翻完回什么"收敛在三个纯函数里，
 * 主进程（发请求）、渲染端（决定显不显示）各取所需 —— 语言判定的口径只在这里写一次。
 *
 * 背景（用户口径 2026-10-11）：现代大模型的思维链基本是纯英文，用户看不懂模型在想什么。
 * 启用「思考翻译」后，思考段的显示**先调翻译模型翻一遍、再回显**。
 *
 * 翻译服务是用户局域网里的 llama.cpp（OpenAI 兼容、**不需要 key**）：
 *   `POST {baseUrl}/chat/completions`，model 填 `Index-Translate-2B`；实测 383ms 往返。
 * 地址/模型/目标语言是普通设置（shared/settings 的 reasoningTranslate），可选 API Key
 * 与 provider 密钥同一套 safeStorage 保留槽位（见下面的 TRANSLATE_KEY_SECRET_ID）。
 */
import { z } from './zod'

/**
 * 可选 API Key 在 secrets.json 里的槽位 id：与 provider 密钥 / 嵌入密钥同一套通道
 * （`setProviderKey` / `getProviderKey` 的 id 参数），但它不属于任何 provider —— 本 LAN 服务
 * 留空即可，填了只进 Authorization 头（明文不回渲染端、不进日志）。
 */
export const TRANSLATE_KEY_SECRET_ID = 'reasoning-translate'

/** 单次翻译的原文上限（超过就不发请求：本地 2B 模型拖这么长的输入只会超时） */
export const TRANSLATE_MAX_CHARS = 20000

/**
 * 翻译提示词（用户给定的格式，**原样照用**：单条 user 消息、不要任何 system/解释性文字）。
 * 实测这一句在 Index-Translate-2B 上效果最好（贪婪解码 + thinking 关闭）。
 */
export function translatePrompt(text: string, targetLanguage: string): string {
  return `请将以下文本翻译为${targetLanguage}，直接输出翻译结果，不要进行任何解释。\n\n${text}`
}

/** OpenAI 兼容的对话端点：`{baseUrl}/chat/completions`（尾斜杠归一，避免 `//chat`） */
export function translateEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

/** 主进程回来的结果：判别字段是 `ok`（UI、preload、handler 用同一份 schema） */
export const translateResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), text: z.string().min(1) }),
  z.strictObject({ ok: z.literal(false), message: z.string().min(1) })
])

export type TranslateResult = z.infer<typeof translateResultSchema>

/**
 * 文字脚本（够判断"这段是不是目标语言"就行，不追求语言学上的文字体系分类）：
 * han 汉字 / latin 拉丁字母 / kana 假名 / hangul 谚文 / cyrillic 西里尔。
 */
export type TextScript = 'han' | 'latin' | 'kana' | 'hangul' | 'cyrillic'

/** 一段文字里各脚本的字母数（只数字母：数字、标点、空白不参与判定） */
export type ScriptCounts = Record<TextScript, number>

function isHan(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0x20000 && code <= 0x2fa1f) // 扩展 B 及以后
  )
}

function isKana(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x31f0 && code <= 0x31ff) || // 片假名扩展
    (code >= 0xff66 && code <= 0xff9d) // 半角片假名
  )
}

function isHangul(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) || // 字母
    (code >= 0x3130 && code <= 0x318f) || // 兼容字母
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) // 音节
  )
}

function isCyrillic(code: number): boolean {
  return (code >= 0x0400 && code <= 0x052f) || (code >= 0x2de0 && code <= 0x2dff)
}

function isLatin(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7) // 带变音的拉丁字母
  )
}

/** 按码点归类统计字母数（纯函数；emoji / 数字 / 标点都不计入） */
export function scriptCounts(text: string): ScriptCounts {
  const counts: ScriptCounts = { han: 0, latin: 0, kana: 0, hangul: 0, cyrillic: 0 }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isHan(code)) counts.han += 1
    else if (isKana(code)) counts.kana += 1
    else if (isHangul(code)) counts.hangul += 1
    else if (isCyrillic(code)) counts.cyrillic += 1
    else if (isLatin(code)) counts.latin += 1
  }
  return counts
}

/**
 * 目标语言 → 预期脚本（zh/en/ja/ko/ru 起步；认不出来 = null）。
 * 日语这一档只认**假名**：日文正文一定有假名（汉字单独出现更可能是中文），
 * 所以"纯汉字 + 目标日语"= 不确定 → 按不一致处理（宁可翻）。
 */
export function targetScriptOf(targetLanguage: string): TextScript | null {
  const target = targetLanguage.trim().toLowerCase()
  if (target === '') return null

  if (/中文|汉语|漢語|简体|繁體|繁体|chinese/.test(target)) return 'han'
  if (target.startsWith('zh') || /(^|[^a-z])(zh|cn)([^a-z]|$)/.test(target)) return 'han'
  if (/日文|日语|日本語|japanese/.test(target)) return 'kana'
  if (/(^|[^a-z])ja([^a-z]|$)/.test(target)) return 'kana'
  if (/韩文|韩语|韓語|朝鲜语|한국어|korean/.test(target)) return 'hangul'
  if (/(^|[^a-z])ko([^a-z]|$)/.test(target)) return 'hangul'
  if (/俄文|俄语|русск|russian/.test(target)) return 'cyrillic'
  if (/(^|[^a-z])ru([^a-z]|$)/.test(target)) return 'cyrillic'
  if (/英文|英语|英語|english/.test(target)) return 'latin'
  if (/(^|[^a-z])(en|eng)([^a-z]|$)/.test(target)) return 'latin'
  return null
}

/** "明确是目标语言"的字母占比门槛（半数以上）：达不到就按不一致处理（宁可给翻译） */
const SAME_LANGUAGE_RATIO = 0.5

/** 太短的一段（字母少于这个数）看不出语言，按不一致处理 */
const MIN_LETTERS = 4

/**
 * 这段思考要不要翻译（纯函数）——**只有"明确是目标语言"才不用翻**：
 *   - 认不出目标语言（未知目标 / 空串）→ 要翻（不确定就按不一致走）；
 *   - 一个字母都没有（纯数字/符号/代码片段）→ 不翻（没有语言可言，翻了也没有意义）；
 *   - 字母太少（< 4）→ 要翻（保守：宁可多翻一次，也别让用户对着看不懂的英文发呆）；
 *   - 目标脚本占比 ≥ 50% → 不翻；否则要翻（混排里英文占多数时给翻译）。
 */
export function needsTranslation(text: string, targetLanguage: string): boolean {
  const expected = targetScriptOf(targetLanguage)
  if (expected === null) return true

  const counts = scriptCounts(text)
  const total = counts.han + counts.latin + counts.kana + counts.hangul + counts.cyrillic
  if (total === 0) return false
  if (total < MIN_LETTERS) return true
  return counts[expected] / total < SAME_LANGUAGE_RATIO
}
