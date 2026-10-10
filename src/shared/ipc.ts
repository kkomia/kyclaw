/**
 * IPC 契约（主进程 / preload / 渲染端共用一处，spec §2.1「类型化 IPC（zod + 共享类型）」）：
 * 通道名常量 + 入参/出参 zod schema + 入参闸门。
 *
 * 两个校验边界：
 *   1. 主进程 handler 的入参 —— 渲染端是"不可信输入"侧，走 `parseIpcArgs`（非法即抛，不静默吞）；
 *   2. 渲染端收到的推送 payload —— preload 用同一份 schema 解析，结构不对就不交给上层。
 * 窗口几何（宽高/位置）只落盘在主进程（main/store.ts），不过桥：渲染端用不到，越小越稳。
 */
import { z } from './zod'
import { providerKeyStateSchema, type ProviderKeyState } from './providers'
import { appSettingsPatchSchema, type AppSettings, type AppSettingsPatch } from './settings'

export const IPC_CHANNELS = {
  window: {
    /** 最小化窗口 */
    minimize: 'window:minimize',
    /** 最大化 ⇄ 还原（按当前状态切换） */
    maximize: 'window:maximize',
    /** 关闭窗口 */
    close: 'window:close',
    /** 查询是否最大化（返回 boolean） */
    isMaximized: 'window:is-maximized',
    /** 主进程 → 渲染端：窗口状态变化推送 */
    stateChanged: 'window:state-changed'
  },
  settings: {
    /** 读当前设置（返回 AppSettings） */
    get: 'settings:get',
    /** 打补丁改设置（入参 AppSettingsPatch，返回合并后的 AppSettings） */
    update: 'settings:update',
    /** 写一条 provider 的密钥（入参 [id, key]，返回 {hasKey:true}——永远不回明文） */
    setProviderKey: 'settings:set-provider-key',
    /** 各 provider 的密钥状态（无入参，返回 { [id]: {hasKey, needsReentry} }） */
    providerKeyStates: 'settings:provider-key-states',
    /** 测试连接（入参 [id]，主进程发一条最小请求，返回延迟或错误文案） */
    testProvider: 'settings:test-provider',
    /** 删除一条 provider 配置（连同它的密钥；入参 [id]，返回合并后的 AppSettings） */
    removeProvider: 'settings:remove-provider'
  },
  agent: {
    /** 读本地 agent 服务端点（返回 AgentEndpoint：baseUrl + token） */
    endpoint: 'agent:endpoint'
  }
} as const

/** 窗口状态推送 payload（目前只有最大化标记） */
export const windowStateSchema = z.strictObject({ maximized: z.boolean() })
export type WindowState = z.infer<typeof windowStateSchema>

/**
 * 本地 agent 服务的端点：渲染端拿它直连主进程内嵌的 chat 服务。
 * token 是每次启动新生成的 Bearer 串——它只经这条 IPC 交给本应用的渲染端，不进设置、不落盘。
 */
export const agentEndpointSchema = z.strictObject({
  baseUrl: z.string(),
  token: z.string()
})
export type AgentEndpoint = z.infer<typeof agentEndpointSchema>

/** settings:update 的入参：单元素元组（payload 形状在 shared/settings.ts） */
export const settingsUpdateArgsSchema = z.tuple([appSettingsPatchSchema])

/** settings:set-provider-key 的入参：[id, key]（都非空；key 只在主进程内存里短暂存在） */
export const providerKeyArgsSchema = z.tuple([z.string().min(1), z.string().min(1)])

/** settings:test-provider / settings:remove-provider 的入参：[id] */
export const providerIdArgsSchema = z.tuple([z.string().min(1)])

/** 写密钥的回包：只有"有没有"，没有明文（strict：连字段名都锁死） */
export const setProviderKeyResultSchema = z.strictObject({ hasKey: z.literal(true) })

/** settings:provider-key-states 的回包：键是 provider id */
export const providerKeyStatesSchema = z.record(z.string(), providerKeyStateSchema)

/**
 * "测试连接"的结果：成功给延迟（ms），失败给一句人话（已抹掉可能被供应商回显的密钥）。
 * 判别字段是 `ok`，UI 与 preload 用同一份 schema。
 */
export const connectionTestResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), latencyMs: z.number() }),
  z.strictObject({ ok: z.literal(false), message: z.string() })
])

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>

/** 无入参通道的入参 schema：ipcRenderer.invoke 不给参数时 args 为空数组 */
export const noArgsSchema = z.tuple([])

/** 跨边界入参不合法（主进程侧抛这个，不静默忽略） */
export class IpcInputError extends Error {
  constructor(channel: string, detail: string) {
    super(`IPC 入参不合法（${channel}）：${detail}`)
    this.name = 'IpcInputError'
  }
}

/**
 * 主进程 handler 的统一入参闸门。
 * `channel` 只用于报错信息（handler 里手写一遍通道名，报错时能直接指到是哪条通道）。
 */
export function parseIpcArgs<S extends z.ZodType>(
  schema: S,
  args: readonly unknown[],
  channel: string
): z.infer<S> {
  const result = schema.safeParse(args)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(入参)'}: ${issue.message}`)
      .join('; ')
    throw new IpcInputError(channel, detail)
  }
  return result.data
}

/** preload 暴露给渲染端的窗口控制面（白名单方法的契约） */
export interface KyclawWindowApi {
  minimize(): void
  /** 最大化 ⇄ 还原 */
  maximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /** 订阅窗口状态变化，返回退订函数 */
  onStateChanged(listener: (state: WindowState) => void): () => void
}

/** preload 暴露给渲染端的设置面（落盘在主进程，渲染端只经 IPC 读写） */
export interface KyclawSettingsApi {
  get(): Promise<AppSettings>
  /** 只给要改的字段，返回合并后的完整设置 */
  update(patch: AppSettingsPatch): Promise<AppSettings>
  /** 写一条 provider 的密钥：成功只回 {hasKey:true}（明文永不回渲染端） */
  setProviderKey(id: string, key: string): Promise<{ hasKey: true }>
  /** 各 provider 的密钥状态（键是 provider id；解不开的密钥体现在 needsReentry） */
  providerKeyStates(): Promise<Record<string, ProviderKeyState>>
  /** 主进程发一条最小请求验证连通性（返回延迟或错误文案） */
  testProvider(id: string): Promise<ConnectionTestResult>
  /** 删除一条 provider 配置（连同它的密钥），返回合并后的完整设置 */
  removeProvider(id: string): Promise<AppSettings>
}

/** preload 暴露给渲染端的 agent 服务面（服务未起时 endpoint() 会 reject） */
export interface KyclawAgentApi {
  endpoint(): Promise<AgentEndpoint>
}

/** `window.kyclaw` 的全部能力（后续任务按通道族追加） */
export interface KyclawApi {
  window: KyclawWindowApi
  settings: KyclawSettingsApi
  agent: KyclawAgentApi
}
