import { DefaultChatTransport } from 'ai'
import type { ChatTransport, UIMessage } from 'ai'
import type { AgentEndpoint } from '@shared/ipc'
import { threadMemoryBody } from '@shared/threads'
import { probedKeyOf, requestProviderOptions } from '@shared/models'
import { useSettingsStore } from './settings-store'

/**
 * 对话传输（T7 裁决）：渲染端直连主进程内嵌的 agent 服务。
 *
 * 两条硬要求：
 *   1. 端点要现取 —— baseUrl 是随机端口、token 每次启动都换，只能经 IPC 问主进程；
 *      拿到 `{baseUrl, token}` 之前不建 transport（服务没起来时错误在 ChatPage 那层就有得显示）。
 *   2. token 走 Authorization 头，不进 URL / 不进日志。
 *
 * 路由与 agent id 对齐 T6（`chatRoute({ path: '/chat/:agentId' })`，agent id = kyclaw-agent）。
 */
export function agentChatUrl(baseUrl: string): string {
  return `${baseUrl}/chat/kyclaw-agent`
}

/**
 * 端点解析一次拿到手的那一份。
 *
 * **为什么单独有这个函数**：一份端点可以喂给同一屏上的多个取数口 —— ChatPage 就是这么用的
 * （解析一次 → 既拼 chat 传输、又交给会话级 PPT 模板预取），省掉一次重复的 IPC 往返，
 * 也让"这一屏用的是哪一份端点"只有一个来源。
 *
 * **刻意不做缓存**（这是既有契约，见 `lib/__tests__/agent.spec.ts` 的"取端点在先：每次调用都等
 * endpoint() 的结果"）：要不要复用是**调用方**的事 —— 需要共享就在一屏的入口解析一次再往下传，
 * 而不是让这里背一个全局可变值。全局缓存会让"换端点 / 服务重启后再取"这类场景无从表达，
 * 也会让同一份模块状态跨用例泄漏（`window.kyclaw.agent.endpoint` 是可被替换的）。
 *
 * **必须是 async 的**（别改成同步返回）：桥根本不在时（jsdom 里没装 kyclaw、主进程没起）
 * `window.kyclaw.agent` 这一下会抛，同步抛会从 effect 里炸出去把整页带崩；`async` 把抛转成
 * rejected promise，交给调用方那条 `.catch` 落到错误卡 —— "服务没起来"这条路径靠的就是它
 * （routes.spec / app.spec 直接渲染 App 且不装桥，钉的正是这件事）。
 */
export async function resolveAgentEndpoint(): Promise<AgentEndpoint> {
  return window.kyclaw.agent.endpoint()
}

/**
 * 提问续跑请求的「服务端已接收」回执（0.1.2 / 001）。
 *
 * `Chat.sendMessage` 的 Promise 要等**整条模型流消费完**才 resolve（`makeRequestImpl` 里
 * `await consumeStream(...)` 之后才收尾），拿它当"提交成功"的边界，提问卡就会一直挂到整轮跑完。
 * 真边界是 `HttpChatTransport.sendMessages` 里 `await fetch(...)` 拿到响应那一刻 —— 2xx、body 流
 * 建立就 return，**不读 body**：与"这一轮跑完"不是同一个量级（请求级 vs 可能几十秒的模型轮）。
 *
 * 回执借 `ChatRequestOptions.metadata` 按请求带一枚回调：AI SDK 只把它交给 transport
 * （`prepareSendMessagesRequest` 的 `requestMetadata`），**不进请求体、不上线**；`transportFor`
 * 在 `inner.sendMessages()` resolve 之后、把流交还 SDK 之前触发一次。
 *
 * 非 2xx / 网络失败时 `inner.sendMessages` 直接抛，回调不响 —— "确认前失败"与"已确认"因此天然
 * 分得开（不靠"点击即成功"含糊）。反过来，回调响了也只说明**请求被接收**：之后的流失败照旧在
 * 聊天层报错，提问卡不因此复辟（服务端已消费掉那次挂起）。
 */
export type AskUserAccepted = () => void

/** 附在 `ChatRequestOptions.metadata` 上的那一格（形状只在这里定义） */
export interface AskUserAcceptedMetadata {
  askUserAccepted: AskUserAccepted
}

/** 组一次请求的 metadata（调用方拿不到形状细节） */
export function askUserAcceptedMetadata(accepted: AskUserAccepted): AskUserAcceptedMetadata {
  return { askUserAccepted: accepted }
}

/** 从 per-request metadata 里取回执回调（真 transport 与测试用的假 transport 共用这一份协议） */
export function askUserAcceptedOf(metadata: unknown): AskUserAccepted | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const accepted = (metadata as Partial<AskUserAcceptedMetadata>).askUserAccepted
  return typeof accepted === 'function' ? accepted : null
}

/**
 * 用一份已解析的端点拼对话传输（URL 与 Bearer 头只在这一处拼）。
 *
 * 外面这层只做一件事：把 `DefaultChatTransport` 的**响应到手**那一刻暴露给请求自己
 * （见 `AskUserAccepted`）—— 解析、URL、请求体一个字没动，也不 tee / 不复读流。
 */
export function transportFor(endpoint: AgentEndpoint): ChatTransport<UIMessage> {
  const inner = new DefaultChatTransport({
    api: agentChatUrl(endpoint.baseUrl),
    headers: { Authorization: `Bearer ${endpoint.token}` },
    prepareSendMessagesRequest: ({ body, id, messages, trigger, messageId }) => {
      const resume = body?.askUserResume
      if (typeof resume === 'object' && resume !== null) {
        return { api: `${endpoint.baseUrl}/ask-user/resume`, body: resume }
      }
      return { body: { ...body, id, messages, trigger, messageId } }
    }
  })
  return {
    async sendMessages(options) {
      const accepted = askUserAcceptedOf(options.metadata)
      const stream = await inner.sendMessages(options)
      // 到手的流还没被读一个 chunk：这一刻只是"服务端已接收并开始响应"
      accepted?.()
      return stream
    },
    reconnectToStream: (options) => inner.reconnectToStream(options)
  }
}

export async function getTransport(): Promise<ChatTransport<UIMessage>> {
  return transportFor(await resolveAgentEndpoint())
}

/**
 * 每轮请求带的线程上下文（T9）：threadId 由会话状态给（草稿就是本地生成的 uuid，
 * 服务端据此建线程）。形状来自 shared/threads 的 `threadMemoryBody`（Mastra 只认
 * `memory.thread` / `memory.resource`），走 sendMessage/regenerate 的 per-request body
 * （DefaultChatTransport 会把它合并进请求体），transport 本身保持无状态。
 *
 * round 18：带上当前默认 provider 的思考挡位（`providerOptions`）。@mastra/ai-sdk 的
 * chat 路由会把请求体里 `providerOptions` 合并进 agent 的流选项（handleChatStream 的
 * `{ ...defaultOptionsRest, ...restOptions }`），所以这是**真透传**：DeepSeek 官方端点走
 * `deepseek.reasoningEffort`（low|high|max），其余 openai 兼容走 `kyclaw-openai-compatible`
 * （字符串原样交端点）；Anthropic 与未知模型不传（如实：只保存与显示）。
 */
export function threadRequestOptions(threadId: string): {
  body: {
    memory: { thread: string; resource: string }
    providerOptions?: Record<string, Record<string, unknown>>
  }
} {
  const settings = useSettingsStore.getState().settings
  const provider = settings.providers.find((item) => item.isDefault) ?? settings.providers[0]
  // round 22：挡位取值同样 probed 实测优先（default_level 当初始档；没探测过回落注册表）
  const probed =
    provider === undefined
      ? undefined
      : settings.probedModels[probedKeyOf(provider.id, provider.model)]
  const providerOptions =
    provider === undefined
      ? null
      : requestProviderOptions(
          provider,
          settings.modelPrefs[`${provider.id}/${provider.model}`]?.thinkingEffort,
          probed
        )
  return {
    body: {
      ...threadMemoryBody(threadId),
      ...(providerOptions === null ? {} : { providerOptions })
    }
  }
}
