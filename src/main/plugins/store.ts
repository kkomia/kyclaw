import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, settingsPath, updateSettings } from '../settings'
import type { AppSettings, PluginMarketplace } from '../../shared/settings'

/**
 * 插件数据面（round 10）：目录布局 + settings 读写 + 总览装配。
 *
 * 布局（userData 下）：
 *   - `plugins/marketplaces/<slug>/`  git 市场的克隆目录；
 *   - `plugins/installed/<marketplaceId>-<pluginSlug>/`  远端 source 的插件克隆目录；
 *   - `skills/<pluginId>-<技能目录名>/`  从插件复制进来的技能（用户数据，不是插件目录的一部分）。
 *
 * 市场列表与安装记录落 settings.json（`pluginMarketplaces` / `installedPlugins`）——
 * 写入只走 `plugins:*` 通道（patch schema 里没有这两个字段，渲染端不能直接改）。
 */
export interface PluginsDirs {
  marketplaces: string
  installed: string
  skills: string
}

export function pluginsDirs(userDataDir: string): PluginsDirs {
  const root = join(userDataDir, 'plugins')
  return {
    marketplaces: join(root, 'marketplaces'),
    installed: join(root, 'installed'),
    skills: join(userDataDir, 'skills')
  }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** 删目录（尽力：不存在就跳过；失败抛给调用方——卸载失败要让用户看见） */
export function removeDir(dir: string): void {
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** skills 目录下的技能目录名列表（只看目录） */
export function listSkillDirs(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir).filter((name) => {
      try {
        return statSync(join(skillsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

export interface PluginSettingsStore {
  read: () => AppSettings
  save: (patch: {
    pluginMarketplaces?: PluginMarketplace[]
    installedPlugins?: AppSettings['installedPlugins']
    /** 安装/卸载会连带增删 mcpServers 条目（都走这一条内部口；校验由 updateSettings 把关） */
    mcpServers?: AppSettings['mcpServers']
  }) => AppSettings
}

/** settings.json 上的读写口（写走 updateSettings：合并 + 校验 + 落盘） */
export function pluginSettingsStore(userDataDir: string): PluginSettingsStore {
  const file = settingsPath(userDataDir)
  return {
    read: () => readSettings(file),
    save: (patch) => updateSettings(file, patch)
  }
}
