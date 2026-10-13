/**
 * 设置落盘（唯一一份：userData/settings.json）——与窗口状态（store.ts）分开落文件。
 *
 * 读：文件不存在 / 不是 JSON / 过不了 schema → 默认值（坏文件当没写过，应用照常起）。
 * 写：**会抛**。窗口几何丢了无所谓，用户刚改的设置丢了要让人知道，所以不吞写失败。
 * 路径由调用方给（main/index.ts 传 app.getPath('userData')），这里是纯函数、可单测。
 *
 * round 75 的**副作用**（只有这一处，别再加）：读 / 写都会把「工作区之外」那一档刷进
 * `permission/outside-mode.ts` 的运行期镜像 —— 审批判定（mastra/tools/guard）拿不到设置文件路径，
 * 又不能经 kyclaw 的 toolOptions 注入（那一轮那个文件由别处持有），所以走这条已有的注册表通道。
 * 于是"设置页改了档位 → 下一轮工具调用就按新档位判"，与 permissionRules 的现读口径一致。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appSettingsSchema,
  DEFAULT_REASONING_TRANSLATE,
  DEFAULT_SEMANTIC_RECALL,
  defaultSettings,
  LANGFUSE_PRESET,
  SETTINGS_FILE,
  type AppSettings
} from '../shared/settings'
import { DEFAULT_WEB_SEARCH } from '../shared/search'
import { setOutsideMode } from './permission/outside-mode'

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, SETTINGS_FILE)
}

/**
 * 读盘兼容：这一版之前的 settings.json 缺后来追加的字段——
 * T13 的 permissions、T12 的 mcpServers、T18 的 defaultWorkspace / projects、T17 的 langfuse、
 * round 10 的 pluginMarketplaces / installedPlugins、round 18 的 modelPrefs、
 * round 20 的 pinnedThreads / archivedThreads、round 22 的 probedModels、
 * round 28 的 semanticRecall（含 v1 形状 → v2 形状的迁移）、round 32 的 reasoningTranslate、
 * round 45 的 webSearch、round 63 的 updateUrl、round 67 的 langfuse.proxyUrl、
 * round 75 的 outsideWorkspaceMode（"工作区之外"那一档，缺了补 `ask`：保守档）。
 * 缺了就直接进 strict  schema 会把整份设置当坏文件（主题/provider/工作区全丢），所以先补空值再解析。
 * 只补这些"追加型"字段：其余字段的缺失仍按"坏文件"处理（既有口径）。
 *
 * 反向还有一件事（round 48）：**删掉的老字段要在这里剥掉**。模块 2 的 `modelCapabilities`
 * （"支持看图"手动开关年代留下的键）已经不在 schema 里了，而 appSettingsSchema 用的是
 * strictObject —— 多一个未知键就整份校验失败（设置全丢回默认）。所以带旧键的文件必须先在这里
 * 清理干净才进解析：这一条不是"补空值"，是"迁移时丢掉废除字段"。
 * round 66 的 `pptTemplate` 同理：PPT 模板选择改成会话级（落 libsql 的 session_ppt_templates），
 * 全局那个字段连同它的落盘值一起丢掉——留着会让 strict 校验失败（整份设置回默认），
 * 而它的旧值一律**不迁移**进任何会话（用户口径：每个会话各是各的，不继承别人的选择）。
 */
function migrateStoredSettings(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const next = { ...record }
  if (next.permissions === undefined) next.permissions = { rules: [] }
  if (next.mcpServers === undefined) next.mcpServers = []
  if (next.defaultWorkspace === undefined) next.defaultWorkspace = null
  if (next.projects === undefined) next.projects = []
  if (next.langfuse === undefined) {
    next.langfuse = { endpoint: LANGFUSE_PRESET.endpoint, proxyUrl: '' }
  } else {
    // round 67：代理是后加的字段（T17 那版只有 endpoint）——补空串，用户原来填的地址原样留着
    const langfuse = next.langfuse
    if (typeof langfuse === 'object' && langfuse !== null && !Array.isArray(langfuse)) {
      const entry = langfuse as Record<string, unknown>
      if (entry.proxyUrl === undefined) next.langfuse = { ...entry, proxyUrl: '' }
    }
  }
  if (next.pluginMarketplaces === undefined) next.pluginMarketplaces = []
  if (next.installedPlugins === undefined) next.installedPlugins = []
  if (next.modelPrefs === undefined) next.modelPrefs = {}
  // round 48：手动"支持看图"开关删除——旧的覆盖记录不再读，直接剥掉（留着的键会让 strict 校验失败）
  delete next.modelCapabilities
  if (next.probedModels === undefined) next.probedModels = {}
  if (next.pinnedThreads === undefined) next.pinnedThreads = []
  if (next.pinnedProjects === undefined) next.pinnedProjects = []
  if (next.archivedThreads === undefined) next.archivedThreads = []
  if (next.archivedProjects === undefined) next.archivedProjects = []
  next.semanticRecall = migrateSemanticRecall(next.semanticRecall)
  if (next.reasoningTranslate === undefined) {
    next.reasoningTranslate = { ...DEFAULT_REASONING_TRANSLATE }
  }
  if (next.webSearch === undefined) next.webSearch = { ...DEFAULT_WEB_SEARCH }
  if (next.updateUrl === undefined) next.updateUrl = ''
  // round 75："工作区之外"那一档 —— 缺了补保守档 `ask`；取值不合法也当没设过（缺省就是安全方向）
  if (next.outsideWorkspaceMode !== 'full') next.outsideWorkspaceMode = 'ask'
  // round 66：PPT 模板选择改会话级（libsql 的 session_ppt_templates）——全局字段废除，旧值不迁移
  delete next.pptTemplate
  return next
}

/**
 * 语义召回设置的形状迁移（模块 3 v1 → v2 → v2.1）。
 * v1 是「本地 fastembed / 远程」两路（`source: 'local' | 'remote'` + `remoteBaseUrl` / `remoteModel`），
 * v2 统一成 OpenAI 兼容嵌入服务（`source: 'remote'` + `baseUrl` / `model`）；
 * v2.1（模块 3B）多一个 `source: 'localEngine'` 与一个 `idleMinutes`。
 * v1 从未发布过，但开发机上可能落过盘——不迁移的话，strict schema 会把整份设置当坏文件（主题/密钥全丢）。
 * 只做"字段名搬家"：**落过盘的取值原样保留**（空串也保留——用户清空就是清空，
 * 读回来必须还是空；预置只是"没这个字段时"的缺省，见 shared/settings 的
 * SEMANTIC_RECALL_PRESET）。`enabled: false` 是用户显式关掉，同样原样保留。
 *
 * 注意 `source` **不能**在这里写死成 `'remote'`：模块 3B 起它是用户的真实选择
 * （选「本机引擎」就得活过每一次读盘），迁移只会把 v1 的 `local` 翻成 `remote`。
 */
function migrateSemanticRecall(raw: unknown): unknown {
  if (raw === undefined) return { ...DEFAULT_SEMANTIC_RECALL }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ...DEFAULT_SEMANTIC_RECALL }
  const record = raw as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const baseUrl = text(record.baseUrl) === '' ? text(record.remoteBaseUrl) : text(record.baseUrl)
  const model = text(record.model) === '' ? text(record.remoteModel) : text(record.model)
  const source =
    record.source === 'localEngine'
      ? 'localEngine'
      : record.source === 'remote'
        ? 'remote'
        : 'remote'
  const idle = record.idleMinutes
  return {
    enabled: record.enabled !== false,
    source,
    baseUrl,
    model,
    idleMinutes:
      typeof idle === 'number' && Number.isInteger(idle) && idle >= 0 && idle <= 240
        ? idle
        : DEFAULT_SEMANTIC_RECALL.idleMinutes
  }
}

/** 读：拿不到一份完整合法的设置就回默认值（新对象，调用方随便改） */
export function readSettings(file: string): AppSettings {
  let settings: AppSettings
  try {
    const parsed = appSettingsSchema.safeParse(
      migrateStoredSettings(JSON.parse(readFileSync(file, 'utf8')))
    )
    settings = parsed.success ? parsed.data : defaultSettings()
  } catch {
    settings = defaultSettings()
  }
  // round 75：读设置是应用里**唯一**读口（service 的每个取值函数都落到这里），顺手把"工作区之外"
  // 那一档刷进运行期镜像 —— 审批判定读的就是它（见 permission/outside-mode.ts 的"谁来写"）。
  setOutsideMode(settings.outsideWorkspaceMode)
  return settings
}

/** 写：目录不存在就建（userData 首次创建），同步写——用户改完就该立刻落盘 */
export function writeSettings(file: string, settings: AppSettings): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  // 写这一侧也刷一次：`updateSettings` 是设置的唯一写口，落盘即生效（与读侧同一条通道）
  setOutsideMode(settings.outsideWorkspaceMode)
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
