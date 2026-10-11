import type { PluginsOverview } from '@shared/plugins'

/**
 * 插件面的渲染端口（round 10）：全部走 `window.kyclaw.plugins`（preload 白名单 IPC）。
 * 与工作区面同一纪律：每个动作都回**新的总览**，界面以主进程的真相为准；
 * 通道缺失（浏览器/单测没装桥）时给出明确错误，不静默。
 */
function pluginsApi(): NonNullable<Window['kyclaw']>['plugins'] {
  const api = window.kyclaw?.plugins
  if (!api) throw new Error('插件通道不可用（window.kyclaw 缺失），改动没有生效')
  return api
}

export async function fetchPluginsOverview(): Promise<PluginsOverview> {
  return pluginsApi().overview()
}

export async function addPluginMarketplace(input: {
  source: string
  ref?: string
  sparsePaths?: string[]
}): Promise<PluginsOverview> {
  return pluginsApi().addMarketplace(input)
}

export async function refreshPluginMarketplace(id: string): Promise<PluginsOverview> {
  return pluginsApi().refreshMarketplace(id)
}

export async function removePluginMarketplace(id: string): Promise<PluginsOverview> {
  return pluginsApi().removeMarketplace(id)
}

export async function installPlugin(marketplaceId: string, name: string): Promise<PluginsOverview> {
  return pluginsApi().install(marketplaceId, name)
}

export async function uninstallPlugin(id: string): Promise<PluginsOverview> {
  return pluginsApi().uninstall(id)
}

/** round 23：读插件本地图标（data URL；没有可用图标 = null → 渲染端画字母头像） */
export async function fetchPluginIcon(marketplaceId: string, name: string): Promise<string | null> {
  const { dataUrl } = await pluginsApi().icon(marketplaceId, name)
  return dataUrl
}
