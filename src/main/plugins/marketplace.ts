import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  marketplaceManifestSchema,
  normalizePluginSource,
  resolveWithin,
  serversFromMcpJson,
  slugify,
  type MarketplaceManifest,
  type MarketplacePluginView
} from '../../shared/plugins'
import type { PluginMarketplace } from '../../shared/settings'
import { ensureDir, removeDir, type PluginsDirs } from './store'

/**
 * 插件市场（round 10）：按 URL / 本地目录添加、刷新、移除。
 *
 * 来源三态（brief）：本机已存在目录 → local（不克隆，直接读）；`owner/repo` → GitHub https；
 * 其余当 git URL。git 动作全走 `spawn('git', …)`（**无 shell**），失败取 stderr 首行人话；
 * `git` 不存在时给明确指引。清单（`.claude-plugin/marketplace.json`）**先校验后落盘**，
 * 校验失败连克隆目录一起清掉（不留半个市场）。
 */

/** git 子进程（无 shell）；`git` 不存在时抛人话 */
export function runGit(args: string[], cwd?: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })
    child.stdout?.on('data', () => {})
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectPromise(new Error('没找到 git，请先安装 Git 再添加市场'))
        return
      }
      rejectPromise(error)
    })
    child.on('close', (code) => {
      resolvePromise({ ok: code === 0, stderr })
    })
  })
}

/**
 * URL 里的 userinfo 脱敏：`scheme://user:secret@host` → `scheme://user:***@host`（保留 host/path）。
 * git 出错时常原样回显带凭据的 URL，不脱敏就会把 token 落在错误条上；没有冒号的 userinfo
 * （`ssh://git@host` 这类正常写法）不动。
 */
export function redactUserInfo(text: string): string {
  return text.replace(/\/\/([^/@\s:]*):([^/@\s]+)@/g, (_match, user: string) => `//${user}:***@`)
}

/** stderr 取首行、脱敏、裁长（错误只给一句人话） */
export function firstLine(text: string, max = 200): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '')
  if (line === undefined) return ''
  const redacted = redactUserInfo(line)
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted
}

export type NormalizedSource =
  { kind: 'local'; path: string } | { kind: 'git'; url: string; label: string }

/** 用户填的「来源」→ 三态判定；认不出就抛人话 */
export function normalizeSourceForAdd(source: string): NormalizedSource {
  const raw = source.trim()
  if (raw === '') throw new Error('填一个来源：owner/repo、git URL 或本机文件夹')

  // 本机已存在目录（普通路径写法；`file://` 按 git 写法对待，走克隆）
  if (!raw.startsWith('file://')) {
    try {
      if (
        (isAbsolute(raw) || raw.startsWith('.')) &&
        existsSync(raw) &&
        statSync(raw).isDirectory()
      ) {
        return { kind: 'local', path: resolve(raw) }
      }
    } catch {
      // 路径形态但读不了 → 继续按 URL 试
    }
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    return { kind: 'git', url: `https://github.com/${raw}.git`, label: basename(raw) }
  }
  if (/^(https?:|git@|ssh:|git\+|file:)/i.test(raw)) {
    return { kind: 'git', url: raw, label: slugify(basename(raw.replace(/\.git$/, ''))) }
  }
  throw new Error('来源认不出：填 owner/repo、git URL 或本机文件夹')
}

/** 市场清单（缺失/坏 JSON/缺字段/相对 source 逃逸 → 人话错误） */
export function readMarketplaceManifest(root: string): MarketplaceManifest {
  const file = join(root, '.claude-plugin', 'marketplace.json')
  if (!existsSync(file)) {
    throw new Error('没找到 .claude-plugin/marketplace.json：这个目录不是插件市场')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('市场清单不是合法的 JSON（.claude-plugin/marketplace.json）')
  }
  const result = marketplaceManifestSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(
      `市场清单少了必填字段：${issue?.path.join('.') || '(根)'}（${issue?.message ?? ''}）`
    )
  }
  for (const plugin of result.data.plugins) {
    if (typeof plugin.source === 'string') {
      if (resolveWithin(root, plugin.source) === null) {
        throw new Error(`市场清单里的 source 逃出了市场目录：${plugin.name} → ${plugin.source}`)
      }
    }
  }
  return result.data
}

/** 把用户输入 + 克隆结果落成一条市场记录（id 去重；名字用清单里的） */
export function marketplaceRecord(options: {
  input: { source: string; ref?: string; sparsePaths?: string[] }
  normalized: NormalizedSource
  path: string
  manifestName: string
  existing: readonly PluginMarketplace[]
  addedAt: string
}): PluginMarketplace {
  const used = new Set(options.existing.map((item) => item.id))
  const base =
    slugify(
      options.normalized.kind === 'local'
        ? basename(options.normalized.path)
        : options.normalized.label
    ) || 'marketplace'
  let id = base
  let index = 2
  while (used.has(id)) {
    id = `${base.slice(0, 30)}-${index}`
    index += 1
  }
  return {
    id,
    name: options.manifestName,
    source: options.input.source.trim(),
    ...(options.input.ref !== undefined && options.input.ref.trim() !== ''
      ? { ref: options.input.ref.trim() }
      : {}),
    ...(options.input.sparsePaths !== undefined && options.input.sparsePaths.length > 0
      ? { sparsePaths: options.input.sparsePaths }
      : {}),
    kind: options.normalized.kind,
    path: options.path,
    addedAt: options.addedAt
  }
}

/** 添加：git 模式克隆到 `marketplaces/<id>/`（先占位 id 再克隆）→ 校验清单。失败清掉克隆。 */
export async function addMarketplace(options: {
  input: { source: string; ref?: string; sparsePaths?: string[] }
  dirs: PluginsDirs
  existing: readonly PluginMarketplace[]
  addedAt: string
}): Promise<PluginMarketplace> {
  const normalized = normalizeSourceForAdd(options.input.source)
  // sparse-checkout 的位置参数：以 `-` 开头会被 git 当 flag（不会被我们拼成真实选项，
  // 但会把检出模式改歪），拒绝在动 git/磁盘之前
  for (const sparsePath of options.input.sparsePaths ?? []) {
    if (sparsePath.startsWith('-')) {
      throw new Error(`稀疏路径不能以 - 开头：${sparsePath}`)
    }
  }

  if (normalized.kind === 'local') {
    const manifest = readMarketplaceManifest(normalized.path)
    return marketplaceRecord({
      input: options.input,
      normalized,
      path: normalized.path,
      manifestName: manifest.name,
      existing: options.existing,
      addedAt: options.addedAt
    })
  }

  ensureDir(options.dirs.marketplaces)
  // 先算一个占位 id 用于目录名（清单还没读到，用来源标签）
  const placeholder = marketplaceRecord({
    input: options.input,
    normalized,
    path: '',
    manifestName: normalized.label || 'marketplace',
    existing: options.existing,
    addedAt: options.addedAt
  })
  const target = join(options.dirs.marketplaces, placeholder.id)
  if (existsSync(target)) removeDir(target)

  const cloneArgs = ['clone', '--depth', '1']
  if (placeholder.ref !== undefined) cloneArgs.push('--branch', placeholder.ref)
  cloneArgs.push(normalized.url, target)
  const cloned = await runGit(cloneArgs)
  if (!cloned.ok) {
    removeDir(target)
    throw new Error(`克隆失败：${firstLine(cloned.stderr) || 'git clone 返回非零'}`)
  }

  if (placeholder.sparsePaths !== undefined) {
    const sparse = await runGit([
      '-C',
      target,
      'sparse-checkout',
      'set',
      '--no-cone',
      ...placeholder.sparsePaths
    ])
    if (!sparse.ok) {
      removeDir(target)
      throw new Error(`稀疏检出失败：${firstLine(sparse.stderr) || 'git sparse-checkout 返回非零'}`)
    }
  }

  let manifest: MarketplaceManifest
  try {
    manifest = readMarketplaceManifest(target)
  } catch (error) {
    removeDir(target)
    throw error
  }

  return marketplaceRecord({
    input: options.input,
    normalized,
    path: target,
    manifestName: manifest.name,
    existing: options.existing,
    addedAt: options.addedAt
  })
}

/** 刷新：git 模式 `pull --ff-only` 后重读清单（名字变了跟着更新）；local 直接重读 */
export async function refreshMarketplace(
  marketplace: PluginMarketplace
): Promise<PluginMarketplace> {
  if (marketplace.kind === 'git') {
    const pulled = await runGit(['-C', marketplace.path, 'pull', '--ff-only'])
    if (!pulled.ok) throw new Error(`刷新失败：${firstLine(pulled.stderr) || 'git pull 返回非零'}`)
  }
  const manifest = readMarketplaceManifest(marketplace.path)
  return { ...marketplace, name: manifest.name }
}

/** 移除：git 模式删克隆目录（local 不动用户目录）；记录由调用方从 settings 摘掉 */
export function removeMarketplaceFiles(marketplace: PluginMarketplace): void {
  if (marketplace.kind === 'git') removeDir(marketplace.path)
}

/** 读一个市场的插件清单 + 组件摘要（相对来源扫目录；远端来源只报名字与描述） */
export function readMarketplacePlugins(marketplace: PluginMarketplace): {
  plugins: MarketplacePluginView[]
  error?: string
} {
  let manifest: MarketplaceManifest
  try {
    manifest = readMarketplaceManifest(marketplace.path)
  } catch (error) {
    return { plugins: [], error: error instanceof Error ? error.message : String(error) }
  }

  const plugins = manifest.plugins.map((plugin) => {
    const source = normalizePluginSource(plugin.source)
    const components =
      source.kind === 'relative'
        ? scanPluginDir(resolveWithin(marketplace.path, source.path) ?? '')
        : { skills: [], mcpServers: [] }
    return {
      name: plugin.name,
      description: plugin.description ?? '',
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      ...(plugin.category === undefined ? {} : { category: plugin.category }),
      source,
      skills: components.skills,
      mcpServers: components.mcpServers,
      supported: source.kind !== 'unsupported'
    }
  })
  return { plugins }
}

/**
 * 扫插件目录的组件：技能 = `skills/*` 下有 `SKILL.md` 的目录名；
 * MCP = `.mcp.json` 的键 + plugin.json 里 `mcpServers` 的键（string 路径/对象/数组三种形态）。
 * 目录不存在 → 空表（不报错）。
 */
export function scanPluginDir(dir: string): { skills: string[]; mcpServers: string[] } {
  if (dir === '' || !existsSync(dir)) return { skills: [], mcpServers: [] }

  const skillsDir = join(dir, 'skills')
  let skills: string[] = []
  try {
    skills = readdirSync(skillsDir).filter((name) => {
      try {
        return statSync(join(skillsDir, name, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
  } catch {
    skills = []
  }

  return { skills, mcpServers: Object.keys(collectPluginServerMaps(dir)) }
}

/** 该插件目录声明的 mcpServers 全集（`.mcp.json` + plugin.json 各形态；后到者覆盖同名） */
export function collectPluginServerMaps(pluginDir: string): Record<string, unknown> {
  const maps: Array<Record<string, unknown>> = []

  const mcpJson = safeReadJson(join(pluginDir, '.mcp.json'))
  const fromMcpJson = serversFromMcpJson(mcpJson)
  if (fromMcpJson !== null) maps.push(fromMcpJson)

  const manifest = safeReadJson(join(pluginDir, '.claude-plugin', 'plugin.json')) as {
    mcpServers?: unknown
  } | null
  const declared = manifest?.mcpServers
  const fromDeclared = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === 'string') {
      const file = resolveWithin(pluginDir, value)
      if (file === null) return null
      const parsed = serversFromMcpJson(safeReadJson(file))
      return parsed
    }
    if (Array.isArray(value)) return null
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
    return null
  }
  if (typeof declared === 'string') {
    const parsed = fromDeclared(declared)
    if (parsed !== null) maps.push(parsed)
  } else if (Array.isArray(declared)) {
    for (const item of declared) {
      const parsed = fromDeclared(item)
      if (parsed !== null) maps.push(parsed)
    }
  } else if (declared !== undefined) {
    const parsed = fromDeclared(declared)
    if (parsed !== null) maps.push(parsed)
  }

  const merged: Record<string, unknown> = {}
  for (const map of maps) Object.assign(merged, map)
  return merged
}

export function safeReadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
