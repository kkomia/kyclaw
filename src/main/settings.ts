/**
 * 设置落盘（唯一一份：userData/settings.json）——与窗口状态（store.ts）分开落文件。
 *
 * 读：文件不存在 / 不是 JSON / 过不了 schema → 默认值（坏文件当没写过，应用照常起）。
 * 写：**会抛**。窗口几何丢了无所谓，用户刚改的设置丢了要让人知道，所以不吞写失败。
 * 路径由调用方给（main/index.ts 传 app.getPath('userData')），这里是纯函数、可单测。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appSettingsSchema,
  defaultSettings,
  SETTINGS_FILE,
  type AppSettings
} from '../shared/settings'

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, SETTINGS_FILE)
}

/**
 * 读盘兼容：这一版之前的 settings.json 缺后来追加的字段——
 * T13 的 permissions、T12 的 mcpServers、T18 的 defaultWorkspace / projects。缺了就直接进 strict
 * schema 会把整份设置当坏文件（主题/provider/工作区全丢），所以先补空值再解析。
 * 只补这些"追加型"字段：其余字段的缺失仍按"坏文件"处理（既有口径）。
 */
function migrateStoredSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const next = { ...record }
  if (next.permissions === undefined) next.permissions = { rules: [] }
  if (next.mcpServers === undefined) next.mcpServers = []
  if (next.defaultWorkspace === undefined) next.defaultWorkspace = null
  if (next.projects === undefined) next.projects = []
  return next
}

/** 读：拿不到一份完整合法的设置就回默认值（新对象，调用方随便改） */
export function readSettings(file: string): AppSettings {
  try {
    const parsed = appSettingsSchema.safeParse(
      migrateStoredSettings(JSON.parse(readFileSync(file, 'utf8')))
    )
    return parsed.success ? parsed.data : defaultSettings()
  } catch {
    return defaultSettings()
  }
}

/** 写：目录不存在就建（userData 首次创建），同步写——用户改完就该立刻落盘 */
export function writeSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * 打补丁：读当前 → 合并 → 全量校验 → 落盘 → 回吐合并后的完整设置。
 * IPC 闸门已经把补丁拦过一道，这里再 parse 一遍是因为"合并结果"才是真正落盘的东西
 * （跨字段约束将来若加进来，只有这里看得见全貌）。校验不过就不落盘，避免半截状态。
 *
 * 补丁类型故意比 `AppSettingsPatch` 宽：渲染端经 settings:update 只能改 AppSettingsPatch 里的字段，
 * 而**主进程内部**改工作区（workspace:* 通道，已经过路径校验）也走这里 —— 这是渲染端拿不到的写权限。
 */
export function updateSettings(file: string, patch: Partial<AppSettings>): AppSettings {
  const next = appSettingsSchema.parse({ ...readSettings(file), ...patch })
  writeSettings(file, next)
  return next
}
