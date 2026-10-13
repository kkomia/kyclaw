// @vitest-environment node
/**
 * 通用 openai 兼容通道的"工具结果里的图片"（render_ppt 的页图是唯一通路）：
 *   1. 造 provider 时 `supportsMultiPartToolContent` **真的传进去了**（默认 true，逃生门可关）——
 *      这一项是 false 时，AI SDK 会把工具结果里的 content 数组 `JSON.stringify` 成字符串，
 *      图**静默消失**（不报错、模型看不到），所以必须钉住它真的为 true；
 *   2. **坏端点不把整轮打挂**：端点不接数组形态的 tool content 时（回 400），
 *      去掉媒体块重试一次并打日志；回落也失败则把第一次的错误抛出去（不循环、不吞）。
 *
 * 全部用假 provider（`@ai-sdk/openai-compatible` 被替身接管）：零网络、零真实密钥。
 * 这里**不**验证"某个真端点到底接不接图"—— 手上只有 DeepSeek 的 key，而 DeepSeek 走的是
 * 官方包（另一条分支），不在这个替身的覆盖范围里。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../shared/providers'
import { TOOL_MEDIA_ENV, type KyclawModel } from '../model'

/** 1×1 真 PNG 的 base64（形状对不对才是这一轮的关键，内容是什么不重要） */
const TOOL_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 另一张真 PNG（用户附件那条路）：回落后它**必须还在**，用来区分两类图片 */
const USER_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 替身 provider 记下的东西：构造选项 + 每次调用收到的 prompt */
const harness = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  prompts: [] as unknown[],
  /** 按调用顺序排的"这次要抛什么"；取完就给 undefined（= 成功） */
  failures: [] as Array<Error | undefined>
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (options: Record<string, unknown>) => {
    harness.options.push(options)
    const model = {
      specificationVersion: 'v4',
      provider: `${String(options.name)}.chat`,
      modelId: 'stub-model',
      supportedUrls: {},
      doGenerate: async (call: { prompt: unknown }) => {
        harness.prompts.push(call.prompt)
        const failure = harness.failures.shift()
        if (failure !== undefined) throw failure
        return {
          content: [],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {},
          warnings: []
        }
      },
      doStream: async (call: { prompt: unknown }) => {
        harness.prompts.push(call.prompt)
        const failure = harness.failures.shift()
        if (failure !== undefined) throw failure
        return { stream: '替身流' }
      }
    }
    return { chatModel: () => model }
  }
}))

const KEY = 'sk-test-fake-key-1234'

/** 一条**非 DeepSeek** 的兼容端点（走通用兼容层那条分支） */
const COMPATIBLE: ProviderConfig = {
  id: 'custom-1',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3:8b',
  isDefault: true
}

type CallOptions = Parameters<KyclawModel['doStream']>[0]

/** 用户消息里的一段（文本 / 附件图片）—— 从 prompt 类型里推，免得手写形状与 SDK 对不上 */
type UserPart = Extract<CallOptions['prompt'][number], { role: 'user' }>['content'][number]

/** 一轮 prompt：工具结果里带一张图（render_ppt 的 toModelOutput 就是这个形状），
 *  外加一张**用户附件**里的图（走 image_url 那条路，回落时不许动它） */
function promptWithToolImage(withImage = true, withUserImage = true): CallOptions {
  const content: UserPart[] = [{ type: 'text', text: '看看这份 PPT' }]
  if (withUserImage) {
    content.push({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: USER_IMAGE } })
  }
  return {
    prompt: [
      { role: 'user', content },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好，我渲染一遍。' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'render_ppt',
            input: { path: 'demo.pptx' }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'render_ppt',
            output: {
              type: 'content',
              value: withImage
                ? [
                    { type: 'text', text: '已渲染 2 页，页图在 demo_页图/。' },
                    {
                      type: 'file',
                      mediaType: 'image/png',
                      data: { type: 'data', data: TOOL_IMAGE }
                    }
                  ]
                : [{ type: 'text', text: '已渲染 2 页，页图在 demo_页图/。' }]
            }
          }
        ]
      }
    ]
  }
}

/** 这次调用收到的 prompt 里还有没有**工具结果**那张图 */
function hasToolImage(prompt: unknown): boolean {
  return JSON.stringify(prompt).includes(TOOL_IMAGE)
}

async function build(env: Record<string, string | undefined> = {}): Promise<KyclawModel> {
  const { buildLanguageModel } = await import('../model')
  return buildLanguageModel(COMPATIBLE, KEY, env)
}

let warnings: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  harness.options.length = 0
  harness.prompts.length = 0
  harness.failures.length = 0
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('通用兼容层 · 工具结果里的图片开关', () => {
  it('造 provider 时 `supportsMultiPartToolContent` 默认就是 true（不打开就等于静默丢图）', async () => {
    await build()

    expect(harness.options).toHaveLength(1)
    expect(harness.options[0].supportsMultiPartToolContent).toBe(true)
    // 顺带钉住既有的三件事没被动过
    expect(harness.options[0]).toMatchObject({
      name: 'kyclaw-openai-compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKey: KEY
    })
  })

  it(`逃生门 ${TOOL_MEDIA_ENV}=off 时关掉（关掉的写法认 0 / off / false）`, async () => {
    for (const value of ['off', '0', 'false', 'OFF']) {
      harness.options.length = 0
      await build({ [TOOL_MEDIA_ENV]: value })
      expect(harness.options[0].supportsMultiPartToolContent).toBe(false)
    }

    // 不认得的值（字面量 true / 空串）仍然当开着 —— 默认值只许是"图能到"
    for (const value of ['true', '']) {
      harness.options.length = 0
      await build({ [TOOL_MEDIA_ENV]: value })
      expect(harness.options[0].supportsMultiPartToolContent).toBe(true)
    }
  })

  it('关掉时不套回落层：prompt 里的图片不会触发任何重试', async () => {
    const model = await build({ [TOOL_MEDIA_ENV]: 'off' })
    harness.failures.push(new Error('400 invalid tool content'))

    await expect(model.doStream(promptWithToolImage())).rejects.toThrow('400 invalid tool content')
    expect(harness.prompts).toHaveLength(1)
  })
})

describe('通用兼容层 · 端点接不住图片时的回落', () => {
  it('doStream 第一次失败 → 去掉图片重试一次，模型这一轮仍能继续（并有日志说明）', async () => {
    const model = await build()
    harness.failures.push(new Error('400: tool message content must be a string'))

    await expect(model.doStream(promptWithToolImage())).resolves.toEqual({ stream: '替身流' })

    expect(harness.prompts).toHaveLength(2)
    expect(hasToolImage(harness.prompts[0])).toBe(true)
    // 第二次真的没有工具结果里的图了，且留下一句"这儿原本有图"的人话（模型知道少了什么）
    expect(hasToolImage(harness.prompts[1])).toBe(false)
    expect(JSON.stringify(harness.prompts[1])).toContain('图片已省略')
    // 正文里那句工具回执还在（不是把整条工具结果丢掉）
    expect(JSON.stringify(harness.prompts[1])).toContain('已渲染 2 页')
    // 用户附件里的图**不碰**（那条路走 image_url，不属于这次要兜的风险）
    expect(JSON.stringify(harness.prompts[1])).toContain(USER_IMAGE)
    expect(warnings).toHaveBeenCalledTimes(1)
    expect(String(warnings.mock.calls[0][0])).toContain('看不到那些图')
  })

  it('doGenerate 同一条口径（两条路都得兜）', async () => {
    const model = await build()
    harness.failures.push(new Error('422 unsupported content part'))

    await expect(model.doGenerate(promptWithToolImage())).resolves.toMatchObject({
      finishReason: { unified: 'stop' }
    })
    expect(harness.prompts).toHaveLength(2)
    expect(hasToolImage(harness.prompts[1])).toBe(false)
  })

  it('回落那次也失败 → 抛**第一次**的错误，不循环重试（只试两次）', async () => {
    const model = await build()
    harness.failures.push(new Error('第一次：400 invalid tool content'))
    harness.failures.push(new Error('第二次：502 bad gateway'))

    await expect(model.doStream(promptWithToolImage())).rejects.toThrow(
      '第一次：400 invalid tool content'
    )
    expect(harness.prompts).toHaveLength(2)
    expect(warnings).toHaveBeenCalledTimes(2)
  })

  it('这一轮本来就没有图片 → 失败原样抛出，不白重试一次（不打日志）', async () => {
    const model = await build()
    harness.failures.push(new Error('500 boom'))

    await expect(model.doStream(promptWithToolImage(false))).rejects.toThrow('500 boom')
    expect(harness.prompts).toHaveLength(1)
    expect(warnings).not.toHaveBeenCalled()
  })
})

/** 假端点回的一段合法 SSE（内容不重要，端点只要能收） */
function sseBody(): string {
  const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
  return (
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'probe',
      choices: [{ index: 0, delta: { role: 'assistant', content: '收到。' }, finish_reason: null }]
    }) +
    chunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'probe',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

/**
 * 这一节用**真的** `@ai-sdk/openai-compatible`（`vi.importActual`）+ 本地假端点：
 * 上面那些替身只能证明"选项传进去了"，这一节证明**这一项到底改变什么** ——
 * 开了 → 工具结果里的图真的变成请求体里的 `image_url`；没开 → 被 `JSON.stringify` 成一坨字符串
 * （`image_url` 一个都没有，模型看不到图）。这就是这次要修的"静默丢图"的现场。
 */
describe('真 provider + 假端点 · 工具结果里的图到底进没进请求体', () => {
  it('开了：以 image_url 进请求体；没开：被 JSON.stringify 成字符串（图就没了）', async () => {
    const { createServer } = await import('node:http')
    const bodies: string[] = []
    const stub = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        bodies.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sseBody())
      })
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const address = stub.address()
    if (address === null || typeof address === 'string') throw new Error('假端点监听失败')

    const { createOpenAICompatible } = await vi.importActual<
      typeof import('@ai-sdk/openai-compatible')
    >('@ai-sdk/openai-compatible')

    /** 造一个真 provider、跑一次真请求，回这次请求体（排空流，确保请求真的发完） */
    const requestBody = async (supportsMultiPartToolContent: boolean): Promise<string> => {
      const model = createOpenAICompatible({
        name: 'probe',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'stub-key',
        supportsMultiPartToolContent
      }).chatModel('probe')

      // 不带用户附件：这样请求体里出现 image_url 只可能来自**工具结果**那张图
      const { stream } = await model.doStream(promptWithToolImage(true, false))
      const reader = stream.getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      return bodies.at(-1) ?? ''
    }

    try {
      const on = await requestBody(true)
      expect(on).toContain('image_url')
      expect(on).toContain(TOOL_IMAGE)
      expect(on).toContain('已渲染 2 页')

      const off = await requestBody(false)
      expect(off).not.toContain('image_url')
      // 图还在请求体里，但已经被压成一串 JSON 文本 —— 模型拿到的是字符，不是图
      expect(off).toContain('\\"type\\":\\"file\\"')
      expect(off).toContain(TOOL_IMAGE)
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()))
    }
  }, 30_000)
})
