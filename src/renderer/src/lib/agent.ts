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

/** 用一份已解析的端点拼对话传输（URL 与 Bearer 头只在这一处拼） */
export function transportFor(endpoint: AgentEndpoint): ChatTransport<UIMessage> {
  return new DefaultChatTransport({
    api: agentChatUrl(endpoint.baseUrl),
    headers: { Authorization: `Bearer ${endpoint.token}` }
  })
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
