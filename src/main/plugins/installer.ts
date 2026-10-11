import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  pluginMcpServersToConfigs,
  resolveWithin,
  slugify,
  type PluginSource
} from '../../shared/plugins'
import type { InstalledPlugin, McpServerConfig, PluginMarketplace } from '../../shared/settings'
import {
  collectPluginServerMaps,
  firstLine,
  runGit,
  safeReadJson,
  scanPluginDir
} from './marketplace'
import { ensureDir, removeDir, type PluginsDirs } from './store'

/**
 * 插件安装 / 卸载（round 10）：目录解析 → MCP 服务器映射（`${CLAUDE_PLUGIN_ROOT}` 已替换）→
 * 技能复制；卸载按记录清理。
 *
 * 已实现：相对 source（住市场目录里）、`github` / `git-subdir` / `git(url)`（克隆到
 * `plugins/installed/<id>/`）；其余来源（archive/npm/command）给人话「暂不支持」。
 * 组件里只有 MCP 服务器与 skills 会真的装进 kyclaw；commands/agents/hooks 等**不装、不报错**
 * （报告里注明已知边界）。
 */
export interface InstallResult {
  record: InstalledPlugin
  mcpServers: McpServerConfig[]
}

export async function installPlugin(options: {
  marketplace: PluginMarketplace
  plugin: { name: string; source: PluginSource; version?: string }
  dirs: PluginsDirs
  existingServers: readonly McpServerConfig[]
  installed: readonly InstalledPlugin[]
  installedAt: string
}): Promise<InstallResult> {
  const { marketplace, plugin, dirs } = options
  const pluginSlug = slugify(plugin.name) || 'plugin'
  const id = `${marketplace.id}-${pluginSlug}`

  if (options.installed.some((record) => record.id === id)) {
    throw new Error(`「${plugin.name}」已经安装过了`)
  }

  // 1) 解析插件目录（远端 source 克隆到 installed/<id>/；失败不留目录）
  let pluginDir: string
  let installDir: string | null = null
  if (plugin.source.kind === 'relative') {
    const dir = resolveWithin(marketplace.path, plugin.source.path)
    if (dir === null) throw new Error(`插件来源逃出了市场目录：${plugin.source.path}`)
    if (!existsSync(dir)) throw new Error(`插件目录不存在：${plugin.source.path}`)
    pluginDir = dir
  } else if (plugin.source.kind === 'unsupported') {
    throw new Error(`暂不支持这种来源：${plugin.source.label}`)
  } else {
    const url =
      plugin.source.kind === 'github'
        ? `https://github.com/${plugin.source.repo}.git`
        : plugin.source.url
    ensureDir(dirs.installed)
    const target = join(dirs.installed, id)
    if (existsSync(target)) removeDir(target)
    const cloned = await runGit(['clone', '--depth', '1', url, target])
    if (!cloned.ok) {
      removeDir(target)
      throw new Error(`克隆失败：${firstLine(cloned.stderr) || 'git clone 返回非零'}`)
    }
    installDir = target
    if (plugin.source.kind === 'git-subdir') {
      const sub = resolveWithin(target, plugin.source.path)
      if (sub === null || !existsSync(sub)) {
        removeDir(target)
        throw new Error(`插件子目录不存在：${plugin.source.path}`)
      }
      pluginDir = sub
    } else {
      pluginDir = target
    }
  }

  const cleanupClone = (): void => {
    if (installDir !== null) removeDir(installDir)
  }

  // 2) MCP 服务器映射（解析器的人话错误原样上抛；失败连克隆一起清）
  let mcpServers: McpServerConfig[]
  try {
    mcpServers = pluginMcpServersToConfigs({
      servers: collectPluginServerMaps(pluginDir),
      pluginRoot: pluginDir,
      pluginSlug: id,
      existingIds: options.existingServers.map((server) => server.id)
    })
  } catch (error) {
    cleanupClone()
    throw error
  }

  // 3) 技能复制到 <userData>/skills/<id>-<技能目录名>/
  const skillDirs: string[] = []
  try {
    ensureDir(dirs.skills)
    for (const skill of scanPluginDir(pluginDir).skills) {
      const dirName = `${id}-${skill}`
      const target = join(dirs.skills, dirName)
      removeDir(target)
      cpSync(join(pluginDir, 'skills', skill), target, { recursive: true })
      skillDirs.push(dirName)
    }
  } catch (error) {
    cleanupClone()
    for (const dirName of skillDirs) removeDir(join(dirs.skills, dirName))
    throw new Error(
      `复制技能失败：${firstLine(error instanceof Error ? error.message : String(error))}`
    )
  }

  const manifest = safeReadJson(join(pluginDir, '.claude-plugin', 'plugin.json')) as {
    version?: unknown
  } | null
  const version =
    typeof manifest?.version === 'string' && manifest.version !== ''
      ? manifest.version
      : plugin.version

  return {
    record: {
      id,
      marketplaceId: marketplace.id,
      name: plugin.name,
      ...(version === undefined || version === '' ? {} : { version }),
      installedAt: options.installedAt,
      mcpServerIds: mcpServers.map((server) => server.id),
      skillDirs,
      installDir
    },
    mcpServers
  }
}

/** 卸载（纯文件清理；mcpServers 条目与记录由调用方从 settings 摘掉） */
export function uninstallPluginFiles(record: InstalledPlugin, dirs: PluginsDirs): void {
  for (const dirName of record.skillDirs) removeDir(join(dirs.skills, dirName))
  if (record.installDir !== null) removeDir(record.installDir)
}
