/**
 * "测试连接"（用户反馈 005）：走聊天那条同一条装配链（buildLanguageModel → AI SDK），
 * 分三步问清楚"这个模型到底能不能用"：
 *
 *   ① 连通：非流式往返 —— 地址 / 密钥 / 模型名这条路通不通；
 *   ② 流式：`streamText` 真消费 SSE，**拿到正文**才算数；
 *   ③ 流式工具：带一条只读探针工具再走一次**流式**调用（本应用每一轮都是"流式 + 工具表"），
 *      端点收下工具定义、模型**合法**调用探针、探针真被执行拿到返回值，才算数。
 *
 * 四档结论（含义见 shared/ipc.ts）：通过 / 失败 / 未验证 / 没跑。凡是拿不到正面证据的都不算通过——
 * HTTP 200、只有思考没有正文、被输出上限截断、流没收到结束标记、模型没调工具、
 * 工具参数没通过校验、工具名对不上，都只能是"未验证"或"明确失败"。
 *
 * 三条纪律：失败不封锁注册（这是诊断，不是准入闸门）；永不抛（失败翻成一句人话）；
 * 永不回密钥（文案经 main/error-text.ts 抹一遍，端点地址只回 协议 + 主机 + 路径）。
 * 超时有界：每步一个步超时，整趟一个总超时兜底（后面几步只拿剩余预算）。
 */
import type { ToolSet } from 'ai'
import { buildLanguageModel, type KyclawModel } from './model'
import {
  CONNECTION_TEST_SCOPE_NOTE,
  type ConnectionTestResult,
  type ConnectionTestStep,
  type ConnectionTestStepId,
  type ConnectionTestStepStatus
} from '../shared/ipc'
import type { ProviderConfig } from '../shared/providers'
import { describeCallError, redactSecret } from './error-text'

/** 最小请求的正文：只为"通不通"，不为回答质量 */
export const TEST_PROMPT = 'ping'

/**
 * 输出预算：思考模型会先把预算烧在 reasoning 上，给太小连一小段正文都换不来，
 * 这一步就什么都验不出（只探出不完整的结果，会被如实标成"未验证"）。
 */
export const TEST_MAX_OUTPUT_TOKENS = 1024

/** 工具那一步的预算：要够模型写思考 + 一个很小的参数对象 */
export const TEST_TOOL_MAX_OUTPUT_TOKENS = 1024

/** 每一步的超时：网络掐住时用户也该立刻看出不对劲（重试交给用户再点一次） */
export const DEFAULT_TEST_TIMEOUT_MS = 15_000

/** 三步的**总**超时：把整趟钉在这里，后面几步只拿到剩下的预算 */
export const DEFAULT_TEST_TOTAL_TIMEOUT_MS = 30_000

/** 探针工具的名字 / 唯一合法参数 / 返回值（三处共用一份，判"合法调用"与"真执行过"都用它） */
export const PROBE_TOOL_NAME = 'kyclaw_probe'
export const PROBE_ECHO = 'ok'
export const PROBE_TOOL_OUTPUT = 'kyclaw-probe-ok'

/** 探针工具那一步的提示：明确要求调那一个工具（不然模型多半只回一句话） */
export const TEST_TOOL_PROMPT = `请调用 ${PROBE_TOOL_NAME} 工具一次，把 echo 参数填成 "${PROBE_ECHO}"。不要用文字回答。`

/** 结果里那句"没跑到"的固定措辞（统一一处，界面读起来一致） */
const SKIPPED_DETAIL = '上一步没有通过，这一步没有跑'

/** 正文预览与错误文案的截断长度（detail 里只放一句人话，不抄模型的整段回答） */
const PREVIEW_MAX = 40
const ERROR_TEXT_MAX = 200

/** 探针参数不合法时抛的东西（execute 与 validate 共用一句） */
const PROBE_INVALID_INPUT = `探针参数不合法：只接受 echo="${PROBE_ECHO}"`

/** 连通那一步的调用参数 */
export interface GenerateOptions {
  prompt: string
  maxOutputTokens: number
  abortSignal: AbortSignal
  /** 连接测试不做 SDK 重试：用户点一下就该立刻看到结论（重试交给用户自己再点） */
  maxRetries: number
}

/** 流式那一步的调用参数 */
export type StreamOptions = GenerateOptions

/** 流式工具那一步的调用参数 */
export interface ToolStreamOptions extends GenerateOptions {
  tools: ToolSet
}

/** 流式那一步观察到的东西（默认实现真消费 fullStream 后归一成这样） */
export interface StreamOutcome {
  /** 收到的正文增量总字符数（SSE 的 text-delta） */
  textChars: number
  /** 收到的思考增量总字符数（reasoning-delta） */
  reasoningChars: number
  /** 统一结束原因（`stop` / `length` / `content-filter` / `error` / `other`…） */
  finishReason: string
  /** 流里有没有收到**结束标记**（中途断流/被掐断时为 false，不能算"完整拿到了"） */
  sawFinish: boolean
  /** 正文开头的一小段（写进 detail，已压平空白并截断） */
  textPreview: string
}

/** 流式工具那一步观察到的东西 */
export interface ToolRunOutcome {
  /** 流里报出来的工具调用；SDK 把校验不过的调用标成 `invalid` */
  calls: ReadonlyArray<{ name: string; invalid: boolean }>
  /** 流里报出来的工具错误（参数不合法 / execute 抛错 / 端点回错都在这儿） */
  errors: readonly string[]
  /** 工具返回的原文（探针的返回值能证明"参数校验过了且真被执行"） */
  outputs: readonly string[]
  finishReason: string
  sawFinish: boolean
}

export interface ConnectionTestDeps {
  /** 每一步的超时（缺省 DEFAULT_TEST_TIMEOUT_MS） */
  timeoutMs?: number
  /** 三步的总超时（缺省 DEFAULT_TEST_TOTAL_TIMEOUT_MS） */
  totalTimeoutMs?: number
  /** 测试注入：真实链路 = ai 的 generateText（动态 import，主进程产物是 CJS） */
  generate?: (model: KyclawModel, options: GenerateOptions) => Promise<unknown>
  /** 测试注入：真实链路 = ai 的 streamText + 真消费 fullStream */
  stream?: (model: KyclawModel, options: StreamOptions) => Promise<StreamOutcome>
  /** 测试注入：真实链路 = 带 tools 的 streamText + 真消费 fullStream */
  toolStream?: (model: KyclawModel, options: ToolStreamOptions) => Promise<ToolRunOutcome>
}

async function defaultGenerate(model: KyclawModel, options: GenerateOptions): Promise<unknown> {
  const { generateText } = await import('ai')
  return generateText({
    model,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
    maxRetries: options.maxRetries
  })
}

/** 压平成一句人话（错误体里可能有换行/超长堆栈） */
function oneLine(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, ERROR_TEXT_MAX)
}

/**
 * 真消费 fullStream（"真正消费 SSE"就是这件事）。
 * `error` 分片一律抛出（供应商的流断在中途时，SDK 就是从这个分片报的）；
 * `finish` 分片是"完整拿到"的唯一凭据，记下来供判据用。
 */
async function defaultStream(model: KyclawModel, options: StreamOptions): Promise<StreamOutcome> {
  const { streamText } = await import('ai')
  const result = streamText({
    model,
    prompt: options.prompt,
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
    maxRetries: options.maxRetries,
    // 流中途断掉也不重试：这是一次"问一句就走"的诊断，重试只会拖长用户等待
    streamRetries: 0
  })

  let textChars = 0
  let reasoningChars = 0
  let preview = ''
  let finishReason = 'other'
  let sawFinish = false

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        textChars += part.text.length
        if (preview.length < PREVIEW_MAX) preview += part.text
        break
      case 'reasoning-delta':
        reasoningChars += part.text.length
        break
      case 'finish':
        sawFinish = true
        finishReason = part.finishReason
        break
      case 'error':
        throw part.error
      default:
        break
    }
  }

  return {
    textChars,
    reasoningChars,
    finishReason,
    sawFinish,
    textPreview: preview.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
  }
}

/** 带工具的流式调用：观察工具调用 / 工具错误 / 工具返回值（tools 由调用方现造，见 testConnection） */
async function defaultToolStream(
  model: KyclawModel,
  options: ToolStreamOptions
): Promise<ToolRunOutcome> {
  const { streamText } = await import('ai')
  const result = streamText({
    model,
    prompt: options.prompt,
    tools: options.tools,
    toolChoice: 'auto',
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
    maxRetries: options.maxRetries,
    streamRetries: 0
  })

  const calls: Array<{ name: string; invalid: boolean }> = []
  const errors: string[] = []
  const outputs: string[] = []
  let finishReason = 'other'
  let sawFinish = false

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'tool-call': {
        // SDK 把"不完整 JSON / 参数校验不过 / 工具名不认识"的调用标成 dynamic + invalid。
        // 类型上这里收窄到静态分支（dynamic 恒为 false），所以按字段读、不按类型读。
        const raw = part as { dynamic?: unknown; invalid?: unknown }
        calls.push({
          name: String(part.toolName),
          invalid: raw.dynamic === true || raw.invalid === true
        })
        break
      }
      case 'tool-error':
        errors.push(oneLine(part.error))
        break
      case 'tool-result':
        outputs.push(typeof part.output === 'string' ? part.output : oneLine(part.output))
        break
      case 'finish':
        sawFinish = true
        finishReason = part.finishReason
        break
      case 'error':
        throw part.error
      default:
        break
    }
  }

  return { calls, errors, outputs, finishReason, sawFinish }
}

/** 探针参数校验：只有 `echo === 'ok'` 算合法探针调用 */
function probeInputOk(value: unknown): value is { echo: string } {
  return (
    typeof value === 'object' && value !== null && (value as { echo?: unknown }).echo === PROBE_ECHO
  )
}

/** `validate` 的回包形状（本地声明，不 import provider-utils 的类型） */
type ProbeValidation = { success: true; value: { echo: string } } | { success: false; error: Error }

/**
 * 探针工具：**只读、零副作用**（把参数报回来，不碰磁盘、不跑命令）。
 *
 * 两条防"假成功"：
 *   - `jsonSchema` **自己不做运行时校验**，所以显式挂一个 `validate`：参数不是
 *     `{ echo: "ok" }` 的调用会被 SDK 标成 invalid 并且**不会被执行**；
 *   - `execute` 里再兜一次：SDK 万一没走 validate，也绝不把 `{}` 之类当成功执行。
 * JSON Schema 手写而不是由 zod 推导：顶层 `type: object` 且 `properties` 存在这两条是
 * DeepSeek 官方端点与 LM Studio 的硬要求（见 `__tests__/tool-schema-compat.spec.ts`）。
 */
async function buildProbeTools(): Promise<ToolSet> {
  const { tool, jsonSchema } = await import('ai')
  const probe = tool({
    description: '连通性探针：把参数原样报回来。只读、没有任何副作用。',
    inputSchema: jsonSchema<{ echo: string }>(
      {
        type: 'object',
        properties: { echo: { type: 'string' } },
        required: ['echo'],
        additionalProperties: false
      },
      {
        validate: (value): ProbeValidation =>
          probeInputOk(value)
            ? { success: true, value }
            : { success: false, error: new Error(PROBE_INVALID_INPUT) }
      }
    ),
    execute: async (input: { echo: string }): Promise<string> => {
      if (!probeInputOk(input)) throw new Error(PROBE_INVALID_INPUT)
      return PROBE_TOOL_OUTPUT
    }
  })
  return { [PROBE_TOOL_NAME]: probe }
}

/** 流式那一步的判据：只有"正常收尾 + 有正文"才算通过 */
function classifyStream(outcome: StreamOutcome): {
  status: ConnectionTestStepStatus
  detail: string
} {
  const preview = outcome.textPreview === '' ? '' : `（开头：「${outcome.textPreview}」）`
  if (outcome.finishReason === 'error') {
    return { status: 'failed', detail: '流式在结束前报错（finish_reason=error）' }
  }
  if (outcome.textChars === 0) {
    return outcome.reasoningChars > 0
      ? {
          status: 'unverified',
          detail: `流里只有思考内容（${outcome.reasoningChars} 个字符）、没有正文`
        }
      : {
          status: 'unverified',
          detail: `流里没有任何正文（finish_reason=${outcome.finishReason}）`
        }
  }
  if (!outcome.sawFinish) {
    return {
      status: 'failed',
      detail: `流收到 ${outcome.textChars} 个字符的正文之后就断了（没有结束标记）`
    }
  }
  if (outcome.finishReason !== 'stop') {
    const why =
      outcome.finishReason === 'length'
        ? '被输出上限截断'
        : `不是正常收尾（finish_reason=${outcome.finishReason}）`
    return {
      status: 'unverified',
      detail: `流式拿到 ${outcome.textChars} 个字符的正文${preview}，但${why}`
    }
  }
  return {
    status: 'passed',
    detail: `流式拿到 ${outcome.textChars} 个字符的正文${preview}（finish_reason=stop）`
  }
}

/**
 * 流式工具那一步的判据。只有"合法调用 + 真执行 + 正常收尾"才算通过：
 * 参数没通过校验、JSON 不完整、工具名对不上、工具报错、没有结束标记、被截断，
 * 以及"模型压根没调工具"（未验证）——全都不是通过。
 */
function classifyToolRun(outcome: ToolRunOutcome): {
  status: ConnectionTestStepStatus
  detail: string
} {
  if (outcome.finishReason === 'error') {
    return { status: 'failed', detail: '带工具的流式调用在结束前报错（finish_reason=error）' }
  }
  const foreign = outcome.calls.find((call) => call.name !== PROBE_TOOL_NAME)
  if (foreign !== undefined) {
    return {
      status: 'failed',
      detail: `流里报出来的工具名是 ${foreign.name}、不是 ${PROBE_TOOL_NAME}——工具定义没原样过去`
    }
  }
  const invalid = outcome.calls.find((call) => call.invalid)
  if (invalid !== undefined) {
    return {
      status: 'failed',
      detail: `模型调了 ${invalid.name}，但这次调用不合法（${outcome.errors[0] ?? '参数没通过校验'}）`
    }
  }
  if (outcome.errors.length > 0) {
    return { status: 'failed', detail: `工具执行报错（${outcome.errors[0]}）` }
  }
  if (!outcome.sawFinish) {
    return {
      status: 'failed',
      detail: '带工具的流式调用没有收到结束标记（连接被掐断或请求被中断）'
    }
  }
  if (outcome.finishReason === 'length') {
    return {
      status: 'unverified',
      detail: '带工具的流式调用被输出上限截断（finish_reason=length）'
    }
  }
  if (outcome.calls.length === 0) {
    return {
      status: 'unverified',
      detail: '端点收下了工具定义（没有报错），但这次模型没有调工具——工具链路本身没被验证'
    }
  }
  if (!outcome.outputs.includes(PROBE_TOOL_OUTPUT)) {
    return {
      status: 'failed',
      detail: `模型调了 ${PROBE_TOOL_NAME}，却没拿到探针的返回值——工具没有被真正执行`
    }
  }
  return {
    status: 'passed',
    detail: `流式 + 工具都通：端点收下工具定义，模型合法调用 ${PROBE_TOOL_NAME} 并拿到了返回值`
  }
}

interface StepDraft {
  id: ConnectionTestStepId
  status: ConnectionTestStepStatus
  latencyMs?: number
  detail: string
}

/** 配置本身就不全 / 连 provider 都找不到：三步全没跑，直接给一句人话（IPC handler 用） */
export function connectionTestNotRun(message: string): ConnectionTestResult {
  return {
    ok: false,
    latencyMs: 0,
    steps: [
      { id: 'connectivity', status: 'failed', detail: message },
      { id: 'streaming', status: 'skipped', detail: SKIPPED_DETAIL },
      { id: 'tools', status: 'skipped', detail: SKIPPED_DETAIL }
    ],
    message,
    scopeNote: CONNECTION_TEST_SCOPE_NOTE
  }
}

/**
 * 分项验证一条 provider 配置。正常回一份三步结论；**任何失败都不抛**，
 * 且所有文案里都不含密钥（连"只回显一半"的也抹掉）。
 */
export async function testConnection(
  config: ProviderConfig,
  apiKey: string,
  deps: ConnectionTestDeps = {}
): Promise<ConnectionTestResult> {
  const stepTimeoutMs = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS
  const totalTimeoutMs = deps.totalTimeoutMs ?? DEFAULT_TEST_TOTAL_TIMEOUT_MS
  const started = Date.now()
  const deadline = started + totalTimeoutMs
  /** 这一步实际能用多久（步超时与总预算取小；至少 1ms，别造出已经没有意义的 signal） */
  const budget = (): number => Math.max(1, Math.min(stepTimeoutMs, deadline - Date.now()))

  /** 所有回给渲染端的文字都从这一处出去：脱敏只做一次，漏不了 */
  const safe = (text: string): string => redactSecret(text, apiKey)

  const assemble = (drafts: readonly StepDraft[]): ConnectionTestResult => {
    const steps: ConnectionTestStep[] = drafts.map((draft) => ({
      ...draft,
      detail: safe(draft.detail)
    }))
    const statusOf = (id: ConnectionTestStepId): ConnectionTestStepStatus | undefined =>
      steps.find((step) => step.id === id)?.status
    // "能对话" = 连通 + 流式都明确通过；工具那一步不参与 ok（它是另一件事的诊断，见 steps）
    const ok = statusOf('connectivity') === 'passed' && statusOf('streaming') === 'passed'
    const firstGap = steps.find((step) => step.status === 'failed' || step.status === 'unverified')
    const tools = steps.find((step) => step.id === 'tools')

    let message: string | undefined
    if (!ok) {
      message = firstGap?.detail ?? '没有拿到明确的结论'
    } else if (tools !== undefined && tools.status !== 'passed') {
      message = `工具那一步没通过（${tools.detail}）——本应用每一轮对话都带工具表，这个模型的真实可用性以第一轮对话为准。`
    }

    return {
      ok,
      latencyMs: Date.now() - started,
      steps,
      ...(message === undefined ? {} : { message }),
      scopeNote: CONNECTION_TEST_SCOPE_NOTE
    }
  }

  let model: KyclawModel
  try {
    model = await buildLanguageModel(config, apiKey)
  } catch (error) {
    return assemble([
      {
        id: 'connectivity',
        status: 'failed',
        detail: describeCallError(error, stepTimeoutMs, '连接')
      },
      { id: 'streaming', status: 'skipped', detail: SKIPPED_DETAIL },
      { id: 'tools', status: 'skipped', detail: SKIPPED_DETAIL }
    ])
  }

  const drafts: StepDraft[] = []
  const generate = deps.generate ?? defaultGenerate
  const stream = deps.stream ?? defaultStream
  const toolStream = deps.toolStream ?? defaultToolStream

  // ① 连通：非流式往返。只看"有没有回来一条能解析的响应"——正文由第 ② 步说话
  const connectStart = Date.now()
  const connectTimeout = budget()
  try {
    await generate(model, {
      prompt: TEST_PROMPT,
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(connectTimeout),
      maxRetries: 0
    })
    drafts.push({
      id: 'connectivity',
      status: 'passed',
      latencyMs: Date.now() - connectStart,
      detail: '端点返回了一条可解析的响应：地址、密钥、模型名这条路是通的'
    })
  } catch (error) {
    drafts.push({
      id: 'connectivity',
      status: 'failed',
      latencyMs: Date.now() - connectStart,
      detail: describeCallError(error, connectTimeout, '连接')
    })
    return assemble([
      ...drafts,
      { id: 'streaming', status: 'skipped', detail: SKIPPED_DETAIL },
      { id: 'tools', status: 'skipped', detail: SKIPPED_DETAIL }
    ])
  }

  // ② 流式：真消费 SSE。只有"正常收尾 + 拿到正文"才算通过（截断/只有思考/断流都不算）
  const streamStart = Date.now()
  const streamTimeout = budget()
  try {
    const outcome = await stream(model, {
      prompt: TEST_PROMPT,
      maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(streamTimeout),
      maxRetries: 0
    })
    drafts.push({
      id: 'streaming',
      latencyMs: Date.now() - streamStart,
      ...classifyStream(outcome)
    })
  } catch (error) {
    drafts.push({
      id: 'streaming',
      status: 'failed',
      latencyMs: Date.now() - streamStart,
      detail: describeCallError(error, streamTimeout, '流式请求')
    })
    return assemble([...drafts, { id: 'tools', status: 'skipped', detail: SKIPPED_DETAIL }])
  }

  // ③ 流式 + 工具：本应用每一轮对话都长这样。探针只读、零副作用，
  //    真正算通过的条件见 classifyToolRun（合法调用 + 真执行 + 正常收尾）
  const toolsStart = Date.now()
  const toolsTimeout = budget()
  try {
    const tools = await buildProbeTools()
    const outcome = await toolStream(model, {
      prompt: TEST_TOOL_PROMPT,
      tools,
      maxOutputTokens: TEST_TOOL_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(toolsTimeout),
      maxRetries: 0
    })
    drafts.push({
      id: 'tools',
      latencyMs: Date.now() - toolsStart,
      ...classifyToolRun(outcome)
    })
  } catch (error) {
    drafts.push({
      id: 'tools',
      status: 'failed',
      latencyMs: Date.now() - toolsStart,
      detail: describeCallError(error, toolsTimeout, '工具请求')
    })
  }

  return assemble(drafts)
}
