import type { PluginSkillImport, PluginsOverview } from '@shared/plugins'
import { useSettingsStore } from './settings-store'

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

/**
 * round 94：单个技能的导入（URL / 本地文件 / 本地文件夹）。三条都回 `{ overview, added }`：
 * 界面拿新总览刷新列表，`added` 用来写"已导入 xx"（取消原生选择器 = null）。
 * 失败是抛错（主进程的人话原样上抛，界面行内显示）。
 */
export async function addSkillFromUrl(url: string): Promise<PluginSkillImport> {
  return pluginsApi().addSkillFromUrl(url)
}

export async function importSkillFromFile(): Promise<PluginSkillImport> {
  return pluginsApi().importSkillFromFile()
}

export async function importSkillFromFolder(): Promise<PluginSkillImport> {
  return pluginsApi().importSkillFromFolder()
}

/**
 * round 94：把一台主机加进出站白名单 —— **只有用户在导入框里点了"允许访问 <主机>"才会走到这里**。
 *
 * 作用域如实传递给用户（写在按钮旁边）：这是 `network.allowLocalHosts`，**与 fetch 等本机出站工具
 * 共用同一份白名单**，不是"只对这次导入生效"。因此这里三条自查：
 *   ① 只写用户确认过的那**一个** `主机:端口`（没有通配、没有默认放行）；
 *   ② 保留列表里已有条目与 `network` 的其它字段（补丁按整对象更新，丢字段就是静默改别人的设置）；
 *   ③ 落盘失败**抛给调用方**（走 `window.kyclaw.settings.update` 而不是乐观的 store.update ——
 *      "以为允许了、其实没写进去"会让用户反复撞同一堵墙）。
 */
export async function allowSkillHost(host: string): Promise<void> {
  const api = window.kyclaw?.settings
  if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），白名单没有保存')
  const network = useSettingsStore.getState().settings.network ?? { allowLocalHosts: [] }
  if (!network.allowLocalHosts.includes(host)) {
    await api.update({
      network: { ...network, allowLocalHosts: [...network.allowLocalHosts, host] }
    })
  }
  // 副本以落盘结果为准（下一次"允许"看到的是最新的列表）
  await useSettingsStore.getState().load()
}
