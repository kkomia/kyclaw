/**
 * 应用设置（spec §2.1「类型化 IPC（zod + 共享类型）」）：主进程落盘、IPC 入参、渲染端消费共用一份 schema。
 *
 * 落盘在主进程的 userData/settings.json（main/settings.ts），与窗口状态的 window-state.json 分开——
 * 窗口几何是"壳自己的事"，设置是"用户的事"，坏一个不该带走另一个。
 * providers（T8）已落地：元素 schema 在 shared/providers.ts；workspaces（T10）就地定义在下面，
 * 元素的取值只有 path + mode 两个字段；permissions.rules（T13）是审批记忆的"永久允许"。
 */
import { z } from './zod'
import { providerConfigSchema } from './providers'

/** 落盘文件名（userData 下） */
export const SETTINGS_FILE = 'settings.json'

/** 主题模式：跟随系统 / 显式亮色 / 显式暗色（对应 html[data-theme] 的解析结果，见 lib/theme.ts） */
export const themeModeSchema = z.enum(['system', 'light', 'dark'])

/** 字号用户档：整组换值，不做乘法缩放（spec §6.3） */
export const fontTierSchema = z.enum(['small', 'default', 'large'])

/**
 * 授权工作区的访问模式（spec §5.2）：ask = 写类默认询问；full = 这个工作区放行（Full access）。
 * 移动/删除（dangerous）不受 full 影响，永远默认问。
 */
export const workspaceModeSchema = z.enum(['ask', 'full'])

/**
 * 一条授权工作区。path 由主进程经**原生选择器**写入并校验（存在、是目录、非 UNC），见 main/workspace.ts；
 * 渲染端只能在 workspace:* 通道上增删与切模式 —— 补丁 schema 里没有这个字段，防止绕过校验直接写授权列表。
 */
export const workspaceSchema = z.strictObject({
  path: z.string().min(1),
  mode: workspaceModeSchema
})

/**
 * 审批记忆的"永久允许"规则（T13）：某工具（归一后的名字）在某工作区里不再逐次询问。
 * `mode` 目前只有 `allow` 一档（"拒绝"不落盘，那是一次性动作）；危险类工具不受规则影响。
 * 渲染端经 settings:update 整表替换，主进程落盘前会再校验一遍。
 */
export const permissionRuleSchema = z.strictObject({
  tool: z.string().min(1),
  workspace: z.string().min(1),
  mode: z.literal('allow')
})

export const permissionsSchema = z.strictObject({
  rules: z.array(permissionRuleSchema)
})

export const appSettingsSchema = z.strictObject({
  theme: themeModeSchema,
  fontTier: fontTierSchema,
  /** T8 的 provider 列表（模型与密钥页；密钥不在里面，见 main/secrets.ts） */
  providers: z.array(providerConfigSchema),
  /** T10 的授权工作区列表（添加/移除/切模式走 workspace:* 通道） */
  workspaces: z.array(workspaceSchema),
  /** T13 的审批记忆规则（审批卡的"永久允许"写这里）；旧落盘文件由 main/settings.ts 补空表 */
  permissions: permissionsSchema
})

/**
 * settings:update 的入参形状：只给要改的字段（缺省字段保持原值）。
 * **不含 workspaces**：授权目录的写入必须在主进程过路径校验，不能从渲染端直接改。
 */
export const appSettingsPatchSchema = appSettingsSchema.partial().omit({ workspaces: true })

export type ThemeMode = z.infer<typeof themeModeSchema>
export type FontTier = z.infer<typeof fontTierSchema>
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type PermissionRule = z.infer<typeof permissionRuleSchema>
export type Permissions = z.infer<typeof permissionsSchema>
export type AppSettings = z.infer<typeof appSettingsSchema>
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  fontTier: 'default',
  providers: [],
  workspaces: [],
  permissions: { rules: [] }
}

/** 默认值的新副本（含新数组/新对象）：调用方拿到的对象随便改，不污染模块级默认 */
export function defaultSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, providers: [], workspaces: [], permissions: { rules: [] } }
}
