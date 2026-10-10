/**
 * 会话标题生成（T9 Step 4）：首轮对话结束后，用**默认 provider**的小请求生成短中文标题。
 *
 * 三条边界：
 *   1. 只用首条用户消息做素材（标题是给侧栏看的，不需要整段对话）；
 *   2. 失败一律降级"截断首句"——标题是装饰性数据，不值得让"provider 半截/网络抖动"
 *      把会话卡在"无标题"状态；降级也照常落库（下一轮不会反复重试）；
 *   3. 落库失败照常往上抛：那是存储层的问题，调用方（路由）要看见。
 *
 * 模型调用与"测试连接"（connection-test.ts）同一条装配路径：resolveModel（每轮现读设置与密钥）
 * → ai 的 generateText；超时 15s、不重试——首轮结束后的补充动作，宁可降级也别挂着。
 */
import type { MastraMemory } from '@mastra/core/memory'
import type { KyclawModel } from './model'
import type { ModelResolver } from './agents/kyclaw'

/** 标题长度上限（中文按字算；模型指令里给的更短） */
export const TITLE_MAX_LENGTH = 30

/** 生成超时（模型慢/网络掐住时降级） */
export const TITLE_TIMEOUT_MS = 15_000

/** 送给模型的素材上限（首条用户消息可能很长） */
export const TITLE_INPUT_MAX_LENGTH = 500

/** 输出上限：标题只要几个 token，给 32 就是防跑飞 */
export const TITLE_MAX_OUTPUT_TOKENS = 32

/** 连首句都没有时的兜底标题（侧栏显示"新会话"） */
export const FALLBACK_TITLE = '新会话'

/** 模型指令：只出标题本身，不要解释/引号/标点 */
export const TITLE_INSTRUCTIONS =
  '你是会话标题生成器。根据用户的第一条消息，生成一个简短的中文标题（不超过 12 个字）。' +
  '只输出标题本身：不要引号、不要句号、不要解释、不要任何前缀。'

/** 标题两边的装饰字符（引号/书名号/括号类）与收尾标点：清理时剥掉 */
const EDGE_DECORATION = /^[\s"'“”‘’「」『』《》【】]+/
const TRAILING_DECORATION = /[\s"'“”‘’「」『』《》【】。！？!?.,，、;；:：…]+$/

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/**
 * 清理模型输出：剥思考块、取首个非空行、去掉两边的引号与收尾标点、压平空白。
 * 清理后为空返回 null（调用方按"没生成出来"处理，走降级）。
 */
export function sanitizeTitle(raw: string): string | null {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const line = firstNonEmptyLine(withoutThink)
  const cleaned = line
    .replace(EDGE_DECORATION, '')
    .replace(TRAILING_DECORATION, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return null
  return cleaned.slice(0, TITLE_MAX_LENGTH)
}

/** 降级标题：取首句（句号/问号/叹号切分），截到上限；什么都没有时给"新会话" */
export function fallbackTitle(text: string): string {
  const line = firstNonEmptyLine(text)
  const sentence =
    line
      .split(/[。！？!?]/)
      .find((piece) => piece.trim() !== '')
      ?.trim() ?? ''
  if (sentence === '') return FALLBACK_TITLE
  return sentence.slice(0, TITLE_MAX_LENGTH)
}

/** 生成模型 + 选项 → 文本（测试注入假件；默认走 ai 的 generateText） */
export type GenerateTitleText = (
  model: KyclawModel,
  options: {
    system: string
    prompt: string
    maxOutputTokens: number
    abortSignal: AbortSignal
    maxRetries: number
  }
) => Promise<{ text: string }>

async function defaultGenerate(
  model: KyclawModel,
  options: Parameters<GenerateTitleText>[1]
): Promise<{ text: string }> {
  const { generateText } = await import('ai')
  return generateText({ model, ...options })
}

/** 落库用到的 memory 面（收窄依赖，单测给假件） */
export type TitleMemory = Pick<MastraMemory, 'updateThread'>

export interface GenerateThreadTitleOptions {
  memory: TitleMemory
  threadId: string
  /** 首条用户消息的文本（标题素材与降级素材共用） */
  firstUserText: string
  /** 默认 provider 的解析器（每轮现读设置与密钥） */
  resolveModel: ModelResolver
  /** 测试注入 */
  generate?: GenerateTitleText
}

export interface GeneratedTitle {
  title: string
  source: 'model' | 'fallback'
}

/**
 * 生成并落库：模型成功 → 清理后的标题（source 'model'）；任何失败 → 截断首句（'fallback'）。
 * 返回实际写入的标题，调用方不用再回读。
 */
export async function generateThreadTitle(
  options: GenerateThreadTitleOptions
): Promise<GeneratedTitle> {
  const generate = options.generate ?? defaultGenerate
  let title: string | null = null

  try {
    const model = await options.resolveModel()
    const result = await generate(model, {
      system: TITLE_INSTRUCTIONS,
      prompt: options.firstUserText.slice(0, TITLE_INPUT_MAX_LENGTH),
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      maxRetries: 0
    })
    title = sanitizeTitle(result.text)
  } catch (error) {
    console.warn(
      '[kyclaw] 标题生成失败，降级截断首句：',
      error instanceof Error ? error.message : error
    )
  }

  const source: GeneratedTitle['source'] = title === null ? 'fallback' : 'model'
  const finalTitle = title ?? fallbackTitle(options.firstUserText)

  await options.memory.updateThread({ id: options.threadId, title: finalTitle })
  return { title: finalTitle, source }
}
