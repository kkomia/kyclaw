/**
 * 插件通道的 handler（IPC 契约的"服务端"，round 10）：市场增/刷/删 + 插件装/卸 + 总览。
 * 与 workspace/projects 同一套范式（入参闸门 → 动作 → 回吐新的总览）；
 * 写 settings 的两族字段（pluginMarketplaces / installedPlugins）只有这一条路，
 * 安装/卸载连带增删的 mcpServers 条目也在这里落盘（新增一律停用，与 MCP 面板口径一致）。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  pluginAddMarketplaceArgsSchema,
  pluginIconArgsSchema,
  pluginIdArgsSchema,
  pluginInstallArgsSchema,
  pluginMarketplaceIdArgsSchema
} from '../../shared/ipc'
import type { PluginsOverview } from '../../shared/plugins'
import { installPlugin, uninstallPluginFiles } from '../plugins/installer'
import {
  addMarketplace,
  readMarketplacePlugins,
  readPluginIconDataUrl,
  refreshMarketplace,
  removeMarketplaceFiles
} from '../plugins/marketplace'
import { installedSkillViews, skillSourcesFor } from '../plugins/skills'
import { pluginsDirs, pluginSettingsStore } from '../plugins/store'

/**
 * round 64：内置技能根目录（`resources/skills`）。由调用方（main/index.ts，那边才有 app）
 * 算好传进来 —— 本模块不 import electron，测试给个临时目录就能钉住"内置技能进总览"这条行为。
 * 缺省 = 没有内置技能（老调用方/单测形状不变）。
 */
export interface PluginIpcOptions {
  builtinSkillsDir?: string | null
}

export function registerPluginIpc(userDataDir: string, options: PluginIpcOptions = {}): void {
  const dirs = pluginsDirs(userDataDir)
  const store = pluginSettingsStore(userDataDir)

  const overview = (): PluginsOverview => {
    const settings = store.read()
    const marketplaces = settings.pluginMarketplaces.map((marketplace) => ({
      ...marketplace,
      ...readMarketplacePlugins(marketplace)
    }))
    // 技能（round 64）：内置 + 插件一份清单两处用（插件页「技能」面板 / composer 的引用菜单）。
    // 名字走 SKILL.md 的 frontmatter（插件技能没有 frontmatter name 时退回"目录名去前缀"，
    // 与 round 10 的行为一致）；内置技能带 source='builtin' 标记。
    const installedSkills = installedSkillViews(
      skillSourcesFor({
        skillsDir: dirs.skills,
        installed: settings.installedPlugins,
        builtinDir: options.builtinSkillsDir ?? null
      })
    )
    return { marketplaces, installed: settings.installedPlugins, installedSkills }
  }

  ipcMain.handle(IPC_CHANNELS.plugins.overview, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.plugins.overview)
    return overview()
  })

  ipcMain.handle(IPC_CHANNELS.plugins.addMarketplace, async (_event, ...args) => {
    const [input] = parseIpcArgs(
      pluginAddMarketplaceArgsSchema,
      args,
      IPC_CHANNELS.plugins.addMarketplace
    )
    const settings = store.read()
    const marketplace = await addMarketplace({
      input,
      dirs,
      existing: settings.pluginMarketplaces,
      addedAt: new Date().toISOString()
    })
    store.save({ pluginMarketplaces: [...settings.pluginMarketplaces, marketplace] })
    return overview()
  })

  ipcMain.handle(IPC_CHANNELS.plugins.refreshMarketplace, async (_event, ...args) => {
    const [id] = parseIpcArgs(
      pluginMarketplaceIdArgsSchema,
      args,
      IPC_CHANNELS.plugins.refreshMarketplace
    )
    const settings = store.read()
    const target = settings.pluginMarketplaces.find((marketplace) => marketplace.id === id)
    if (target === undefined) throw new Error('这条市场不在列表里（可能已被移除）')
    const refreshed = await refreshMarketplace(target)
    store.save({
      pluginMarketplaces: settings.pluginMarketplaces.map((marketplace) =>
        marketplace.id === id ? refreshed : marketplace
      )
    })
    return overview()
  })

  ipcMain.handle(IPC_CHANNELS.plugins.removeMarketplace, (_event, ...args) => {
    const [id] = parseIpcArgs(
      pluginMarketplaceIdArgsSchema,
      args,
      IPC_CHANNELS.plugins.removeMarketplace
    )
    const settings = store.read()
    const target = settings.pluginMarketplaces.find((marketplace) => marketplace.id === id)
    if (target === undefined) throw new Error('这条市场不在列表里（可能已被移除）')

    // 连带卸载：该市场下已安装的插件先清文件，再摘记录与它们的 mcpServers 条目
    const doomed = settings.installedPlugins.filter((record) => record.marketplaceId === id)
    for (const record of doomed) uninstallPluginFiles(record, dirs)
    const doomedMcpIds = new Set(doomed.flatMap((record) => record.mcpServerIds))
    removeMarketplaceFiles(target)

    store.save({
      pluginMarketplaces: settings.pluginMarketplaces.filter(
        (marketplace) => marketplace.id !== id
      ),
      installedPlugins: settings.installedPlugins.filter((record) => record.marketplaceId !== id),
      mcpServers: settings.mcpServers.filter((server) => !doomedMcpIds.has(server.id))
    })
    return overview()
  })

  ipcMain.handle(IPC_CHANNELS.plugins.install, async (_event, ...args) => {
    const [input] = parseIpcArgs(pluginInstallArgsSchema, args, IPC_CHANNELS.plugins.install)
    const settings = store.read()
    const marketplace = settings.pluginMarketplaces.find((item) => item.id === input.marketplaceId)
    if (marketplace === undefined) throw new Error('这条市场不在列表里（可能已被移除）')
    const plugin = readMarketplacePlugins(marketplace).plugins.find(
      (item) => item.name === input.name
    )
    if (plugin === undefined) throw new Error(`市场清单里没有这个插件：${input.name}`)

    const result = await installPlugin({
      marketplace,
      plugin,
      dirs,
      existingServers: settings.mcpServers,
      installed: settings.installedPlugins,
      installedAt: new Date().toISOString()
    })
    store.save({
      mcpServers: [...settings.mcpServers, ...result.mcpServers],
      installedPlugins: [...settings.installedPlugins, result.record]
    })
    return overview()
  })

  ipcMain.handle(IPC_CHANNELS.plugins.uninstall, (_event, ...args) => {
    const [id] = parseIpcArgs(pluginIdArgsSchema, args, IPC_CHANNELS.plugins.uninstall)
    const settings = store.read()
    const record = settings.installedPlugins.find((item) => item.id === id)
    if (record === undefined) throw new Error('这个插件不在已安装列表里')

    uninstallPluginFiles(record, dirs)
    const removedMcpIds = new Set(record.mcpServerIds)
    store.save({
      installedPlugins: settings.installedPlugins.filter((item) => item.id !== id),
      mcpServers: settings.mcpServers.filter((server) => !removedMcpIds.has(server.id))
    })
    return overview()
  })

  // round 23：插件图标（data URL）。目录解析/containment/大小上限都在主进程；
  // 没有可用图标回 { dataUrl: null }（渲染端画字母头像）
  ipcMain.handle(IPC_CHANNELS.plugins.icon, (_event, ...args) => {
    const [marketplaceId, name] = parseIpcArgs(
      pluginIconArgsSchema,
      args,
      IPC_CHANNELS.plugins.icon
    )
    const marketplace = store.read().pluginMarketplaces.find((item) => item.id === marketplaceId)
    if (marketplace === undefined) return { dataUrl: null }
    return { dataUrl: readPluginIconDataUrl(marketplace, name) }
  })
}
