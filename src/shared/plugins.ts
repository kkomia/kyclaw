import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from './zod'
import { parseMcpServersJson } from './mcp'
import { pluginMarketplaceSchema, installedPluginSchema } from './settings'
import type { McpServerConfig } from './settings'

/**
 * 插件市场与插件的**纯逻辑**（round 10；文件系统/ git 动作在 main/plugins/ 里）；
 * 只读例外：`resolveWithin` 的 realpath 硬化会读一次 fs（`existsSync`/`realpathSync`，绝不写入）。
 *
 * 生态格式（Claude Code 事实标准，Codex 的 Add a marketplace 同构）：
 *   - 市场 = git 仓库或本机目录，根下 `.claude-plugin/marketplace.json`（name/version/owner/plugins[]）；
 *   - 插件 = 目录：`.claude-plugin/plugin.json`（可选）+ `skills/<name>/SKILL.md` + `.mcp.json`
 *     （`{"mcpServers": {...}}`，与 round 9 的解析器同格式）+ plugin.json 的 `mcpServers` 字段；
 *   - `${CLAUDE_PLUGIN_ROOT}`：MCP 服务器的 command/args/env（stdio）与 url/headers（http）里
 *     替换成插件安装根（绝对路径、正斜杠）。
 */

/** marketplace.json 的最小形状（宽松：不认识的字段忽略；缺 name / plugins 数组才是错） */
export const marketplaceManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  owner: z
    .object({ name: z.string().optional(), email: z.string().optional() })
    .catchall(z.unknown())
    .optional(),
  plugins: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      version: z.string().optional(),
      category: z.string().optional(),
      /** round 23：图标声明（相对插件目录的路径，如 `logo.svg`；认不出/越界就当没有） */
      icon: z.string().optional(),
      source: z.union([z.string(), z.record(z.string(), z.unknown())])
    })
  )
})

export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>

/** 插件的来源归一（brief 定的四种 + unsupported）——schema 与主进程回包共用一份 */
export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relative'), path: z.string() }),
  z.strictObject({ kind: z.literal('github'), repo: z.string() }),
  z.strictObject({ kind: z.literal('git-subdir'), url: z.string(), path: z.string() }),
  z.strictObject({ kind: z.literal('git'), url: z.string() }),
  z.strictObject({ kind: z.literal('unsupported'), label: z.string() })
])

export type PluginSource = z.infer<typeof pluginSourceSchema>

function isHttpOrGitUrl(value: string): boolean {
  return /^(https?:|git@|ssh:|git\+)/i.test(value)
}

/** `source` 字段（string 或对象）→ 归一来源；认不出的进 unsupported（安装时给人话） */
export function normalizePluginSource(raw: string | Record<string, unknown>): PluginSource {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (value.startsWith('./') || value.startsWith('.\\') || value.startsWith('/')) {
      return { kind: 'relative', path: value }
    }
    if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { kind: 'github', repo: value }
    if (isHttpOrGitUrl(value)) return { kind: 'git', url: value }
    return { kind: 'unsupported', label: value }
  }

  const type = typeof raw.source === 'string' ? raw.source.trim() : ''
  if (type === 'github') {
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
    if (repo === '') return { kind: 'unsupported', label: 'github（缺 repo）' }
    return { kind: 'github', repo }
  }
  if (type === 'git-subdir') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    const sub = typeof raw.path === 'string' ? raw.path.trim() : ''
    if (url === '' || sub === '') return { kind: 'unsupported', label: 'git-subdir（缺 url/path）' }
    return { kind: 'git-subdir', url, path: sub }
  }
  if (type === 'url' || type === 'git') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (url === '') return { kind: 'unsupported', label: `${type}（缺 url）` }
    return { kind: 'git', url }
  }
  return { kind: 'unsupported', label: type === '' ? '未知来源' : type }
}

/**
 * 相对路径的 containment：把 `relative` 并在 `root` 里，逃逸（`..` 出头）或绝对路径回 null。
 * 市场的相对 `source`、git-subdir 的 `path`、plugin.json 里 `mcpServers` 的文件路径都用它。
 *
 * 两道判定：
 *   ① 词法（不碰 fs）：绝对路径（含 `C:` 盘符）/ `..` 出头一律拒；
 *   ② realpath 硬化（仅当 root 存在）：对目标**最深存在的祖先**与 root 各做一次 realpath 再验包含
 *      —— 市场里塞一个指到外面的 symlink / junction（Windows 免管理员可建）也读不到外面，
 *      与 main/permission/realpath.ts 的防线同口径。root 不存在（或整条链都不存在）时保持
 *      纯词法语义：那些路径将来只会在 root 内按 slug 创建，不再有链接可穿。
 */
export function resolveWithin(root: string, relative: string): string | null {
  if (relative === '' || relative.startsWith('/') || relative.startsWith('\\')) return null
  if (/^[a-zA-Z]:[\\/]/.test(relative)) return null
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const parts: string[] = []
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  if (parts.length === 0) return null
  const candidate = `${cleanRoot}/${parts.join('/')}`
  return escapesRoot(cleanRoot, candidate) ? null : candidate
}

/** true = 目标（或其最深存在的祖先）realpath 后不在 root（realpath 后）内；root 不存在时不拦 */
function escapesRoot(root: string, candidate: string): boolean {
  if (!existsSync(root)) return false
  // 往上找到第一个真实存在的路径段（它的 realpath 已经消化了沿途所有链接）
  let probe = candidate
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return true // 兜底：走到盘根还没见到存在的路径 → 保守拒绝
    probe = parent
  }
  const realRoot = canonicalPath(root)
  const realProbe = canonicalPath(probe)
  return !(realProbe === realRoot || realProbe.startsWith(`${realRoot}/`))
}

/** realpath（失败就退回原样）；统一正斜杠、去尾斜杠，Windows 上再折成小写后比较 */
function canonicalPath(path: string): string {
  let resolved = path
  try {
    resolved = realpathSync(path)
  } catch {
    resolved = path
  }
  const slashed = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** 目录名 / id 用的 slug：小写、非法字符→-、去首尾-、截 32 位 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** `${CLAUDE_PLUGIN_ROOT}` 替换：只动 MCP 服务器里那几处字符串（值，不动键） */
export function substituteMcpServerRoot(
  servers: Record<string, unknown>,
  pluginRoot: string
): Record<string, unknown> {
  const replacement = pluginRoot.replace(/\\/g, '/')
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.split('${CLAUDE_PLUGIN_ROOT}').join(replacement)
    }
    if (Array.isArray(value)) return value.map(substitute)
    if (typeof value === 'object' && value !== null) {
      const next: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) next[key] = substitute(item)
      return next
    }
    return value
  }

  const next: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(servers)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) {
      next[name] = server
      continue
    }
    const record = server as Record<string, unknown>
    const rewritten: Record<string, unknown> = { ...record }
    for (const key of ['command', 'args', 'env', 'url', 'headers'] as const) {
      if (key in record) rewritten[key] = substitute(record[key])
    }
    next[name] = rewritten
  }
  return next
}

/** 多份 mcpServers 来源（.mcp.json + plugin.json 若干形态）合并：后到者覆盖同名条目 */
export function mergeServerMaps(
  sources: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const source of sources) Object.assign(merged, source)
  return merged
}

/** 从一份 `{"mcpServers": {...}}` 形状里取服务器表（不是这个形状 → 空表，由调用方判要不要报错） */
export function serversFromMcpJson(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const servers = (parsed as { mcpServers?: unknown }).mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null
  return servers as Record<string, unknown>
}

/**
 * 插件的 mcpServers → 我们的 McpServerConfig（复用 round 9 的解析器：type 归一、键值容忍、
 * 人话错误都同一份）。id 改成 `plugin-<插件slug>-<原服务名>`（截 32、与 existingIds 及批内去重）。
 */
export function pluginMcpServersToConfigs(input: {
  servers: Record<string, unknown>
  pluginRoot: string
  pluginSlug: string
  existingIds: readonly string[]
}): McpServerConfig[] {
  const substituted = substituteMcpServerRoot(input.servers, input.pluginRoot)
  const parsed = parseMcpServersJson(JSON.stringify({ mcpServers: substituted }), [])
  const used = new Set(input.existingIds)
  return parsed.map((config) => {
    const base = slugify(`plugin-${input.pluginSlug}-${config.id}`) || `plugin-${input.pluginSlug}`
    let id = base.slice(0, 32)
    let index = 2
    while (used.has(id)) {
      const suffix = `-${index}`
      id = `${base.slice(0, 32 - suffix.length)}${suffix}`
      index += 1
    }
    used.add(id)
    return { ...config, id }
  })
}

/**
 * 插件总览（`plugins:overview` 的回包；preload 用同一份 schema 解析）：
 * 市场（含各自的插件清单与组件摘要） + 安装记录 + 已装技能。
 */
export const marketplacePluginViewSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  version: z.string().optional(),
  category: z.string().optional(),
  source: pluginSourceSchema,
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  supported: z.boolean(),
  /** round 23：有可用的本地图标（≤256KB 的常见图片文件）——渲染端据此取 data URL，没有画字母头像 */
  icon: z.boolean()
})

export const marketplaceViewSchema = pluginMarketplaceSchema.extend({
  plugins: z.array(marketplacePluginViewSchema),
  error: z.string().optional()
})

export const installedSkillViewSchema = z.strictObject({
  /** `<userData>/skills` 下的目录名（内置技能 = 它在 `resources/skills` 下的目录名） */
  dir: z.string().min(1),
  /** 技能名（SKILL.md 的 frontmatter `name`；没有就用目录名去掉插件前缀；显示与查找都用它） */
  name: z.string().min(1),
  /** 来自哪个已安装插件（对不上就 null） */
  pluginId: z.string().nullable(),
  pluginName: z.string().nullable(),
  /**
   * round 64：技能来源标记。**内置**技能给 `'builtin'`（随包分发的 office 四件套）；
   * round 94：**我的**技能给 `'user'`（用户从 URL / 本地导入、或模型用 create_skill 建的 ——
   * 判据是"`<userData>/skills` 下没有插件记录认领它"）。插件技能带 `'plugin'`。
   * 内置与我自己建的都进 installedSkills：插件页的「技能」面板与 composer 的 `+ → 引用技能`
   * 都读这一份，用户在那里就能看到并引用它们。
   */
  source: z.enum(['builtin', 'user', 'plugin']).optional()
})

export const pluginsOverviewSchema = z.strictObject({
  marketplaces: z.array(marketplaceViewSchema),
  installed: z.array(installedPluginSchema),
  installedSkills: z.array(installedSkillViewSchema)
})

/** round 23：`plugins:icon` 的回包（没有可用图标 / 读不出来 → dataUrl null，渲染端回字母头像） */
export const pluginIconResponseSchema = z.strictObject({
  dataUrl: z.string().nullable()
})

/**
 * round 94：导入一个技能的回包（两个通道共用）。
 * `added` = 导入进来的技能（名字 + 目录名，见 skill-add.ts 的命名口径）；
 * 用户在原生选择器里点了取消 = `null`（什么都没发生）。**失败是抛错**（人话原因由界面行内显示），
 * 不在这里塞一个"失败"形状 —— 总览与技能两个字段要么都真、要么整次调用不成立。
 *
 * `blocked`（**唯一一个不抛的"没做成"**）：出站边界挡下了，而且挡的是**本机/内网**这一档 ——
 * 界面据此给一个"允许这台主机"的按钮（用户点了才会写 `network.allowLocalHosts`，见插件页）。
 * 其余被挡的形状（解析不出 IP、域名指向私网、协议不对）照旧走抛错，**不给按钮**：
 * 那几档要么判不出、要么要替用户再解析一次才判得出，按钮会变成"点一下绕过 fail-closed"。
 */
export const pluginSkillEgressBlockSchema = z.strictObject({
  /** 要允许的**确切** `主机:端口`（与白名单写法同形；没有通配） */
  host: z.string().min(1),
  /** 被拦下的地址（回显用） */
  url: z.string().min(1),
  /** 主进程给的那句人话（与其它失败路径上用户看到的是同一句，界面直接显示） */
  message: z.string().min(1)
})

export const pluginSkillImportSchema = z.strictObject({
  overview: pluginsOverviewSchema,
  added: z.strictObject({ name: z.string().min(1), dir: z.string().min(1) }).nullable(),
  blocked: pluginSkillEgressBlockSchema.nullable()
})

export type MarketplacePluginView = z.infer<typeof marketplacePluginViewSchema>
export type MarketplaceView = z.infer<typeof marketplaceViewSchema>
export type InstalledSkillView = z.infer<typeof installedSkillViewSchema>
export type PluginsOverview = z.infer<typeof pluginsOverviewSchema>
export type PluginIconResponse = z.infer<typeof pluginIconResponseSchema>
export type PluginSkillEgressBlock = z.infer<typeof pluginSkillEgressBlockSchema>
export type PluginSkillImport = z.infer<typeof pluginSkillImportSchema>
