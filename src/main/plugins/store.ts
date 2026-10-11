import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join, resolve } from 'node:path'
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

/** 移除的兜底强度（round 23：先清只读、再多重试、最后改名；注入口只为单测） */
export interface RemoveDirDeps {
  /** 删除实现（缺省 = rmSync recursive/force + 5 次重试/200ms） */
  rm?: (dir: string) => void
  /** 改名实现（缺省 = renameSync） */
  rename?: (from: string, to: string) => void
  /** 改名重试之间的等待（缺省 = 同步睡 300ms；单测注入空实现） */
  sleep?: (ms: number) => void
  now?: () => number
}

/** 改名兜底的重试次数与间隔（round 25：瞬时的杀软/索引器占用靠退避熬过去） */
export const RENAME_ATTEMPTS = 5
export const RENAME_RETRY_DELAY_MS = 300

/** 同步睡：Atomics.wait（Node 主线程可用）；环境不允许时忙等兜底 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* 忙等兜底（浏览器环境不该走到这） */
    }
  }
}

/** best-effort 清只读：文件 0o666、目录 0o777（Windows 上等价去只读属性）；单个失败跳过 */
function clearReadonly(dir: string): void {
  const walk = (target: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(target)
    } catch {
      return
    }
    for (const name of entries) {
      const entry = join(target, name)
      try {
        if (statSync(entry).isDirectory()) {
          walk(entry)
          try {
            chmodSync(entry, 0o777)
          } catch {
            /* 单个失败跳过 */
          }
        } else {
          try {
            chmodSync(entry, 0o666)
          } catch {
            /* 单个失败跳过 */
          }
        }
      } catch {
        /* 单个失败跳过 */
      }
    }
  }
  walk(dir)
  try {
    chmodSync(dir, 0o777)
  } catch {
    /* 顶层失败也继续试删 */
  }
}

/**
 * 健壮删除（round 23 起；round 25 加改名退避）：
 *   ① best-effort 递归清只读（chmod 0o666 / 0o777）；
 *   ② `rmSync(recursive/force, maxRetries: 5, retryDelay: 200)`；
 *   ③ 仍失败 → **顶层改名**到 `${dir}.trash-<ts>`——5 次 × 300ms 退避重试（瞬时占用多是
 *      杀软/索引器短暂持有；round 25 用户实测 renameSync 单独跑能成）；改名成功即视为"移除成功"
 *      （原子结果），trash 目录后台尽力删，删不掉留给启动清扫；
 *   ④ 连改名都失败 → **原始错误进 console**（detail 不上横幅），抛人话
 *      「删除被占用：<路径>（关掉占用它的程序后重试）」。
 * 目录不存在 = 空操作（幂等）。
 */
export function removeDirRobust(dir: string, deps: RemoveDirDeps = {}): void {
  if (!existsSync(dir)) return
  clearReadonly(dir)

  let rmError: unknown
  try {
    if (deps.rm !== undefined) deps.rm(dir)
    else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    return
  } catch (error) {
    rmError = error
    // 落到改名兜底
  }

  const trash = `${dir}.trash-${(deps.now ?? Date.now)()}`
  const rename = deps.rename ?? renameSync
  const sleep = deps.sleep ?? sleepSync
  let renameError: unknown
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      rename(dir, trash)
      renameError = undefined
      break
    } catch (error) {
      renameError = error
      if (attempt < RENAME_ATTEMPTS) sleep(RENAME_RETRY_DELAY_MS)
    }
  }
  if (renameError !== undefined) {
    // 原始 detail 只进日志（渲染端看到的是下一行那句人话）
    console.warn(`[kyclaw] 删除失败（原始错误，涉事路径）${dir}`, rmError, renameError)
    throw new Error(`删除被占用：${dir}（关掉占用它的程序后重试）`)
  }

  // 改名成功即移除成功；trash 尽力清（失败无妨——启动清扫会收）
  try {
    rmSync(trash, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
  } catch {
    console.warn(`[kyclaw] 删除残骸未能立刻清掉（下次启动清扫）：${trash}`)
  }
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

/** 目录下的一级子目录名（读不了 = 空表） */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** 同一路径判定（Windows 大小写不敏感；不做 realpath——孤儿清扫只判"这目录有没有主人"） */
function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export interface SweepResult {
  removedTrash: string[]
  removedOrphans: string[]
}

/**
 * 启动清扫（round 23）：把"移除没做干净"的历史残骸收掉。
 *   ① 三个托管目录（marketplaces / installed / skills）下的 `*.trash-*` → 尽力删；
 *   ② `plugins/marketplaces/` 下**不在 settings.pluginMarketplaces 里**的目录（git 孤儿，
 *      例如半删除残骸）→ 删。
 * 边界：孤儿清扫**只动 marketplaces/ 一级目录**——local 市场指向用户自己的目录（不在这个树下），
 * 天然不碰；installed/ 的孤儿不猜（可能是用户在装、记录还没落盘的瞬间），只清 trash。
 * 全程 try/catch：清扫失败只日志，不挡启动。
 */
export function sweepPluginResidue(options: {
  dirs: PluginsDirs
  marketplaces: readonly PluginMarketplace[]
  log?: (message: string) => void
}): SweepResult {
  const log = options.log ?? ((message: string) => console.log(message))
  const result: SweepResult = { removedTrash: [], removedOrphans: [] }

  for (const root of [options.dirs.marketplaces, options.dirs.installed, options.dirs.skills]) {
    for (const name of listDirs(root)) {
      if (!name.includes('.trash-')) continue
      const target = join(root, name)
      try {
        removeDirRobust(target)
        result.removedTrash.push(target)
        log(`[kyclaw] 插件清扫：删除残骸目录 ${target}`)
      } catch (error) {
        log(`[kyclaw] 插件清扫：残骸目录没能删除（先放着）${target}：${String(error)}`)
      }
    }
  }

  for (const name of listDirs(options.dirs.marketplaces)) {
    if (name.includes('.trash-')) continue // 上面已处理
    const target = join(options.dirs.marketplaces, name)
    const owned = options.marketplaces.some((marketplace) => samePath(marketplace.path, target))
    if (owned) continue
    try {
      removeDirRobust(target)
      result.removedOrphans.push(target)
      log(`[kyclaw] 插件清扫：删除没有主人的市场目录 ${target}`)
    } catch (error) {
      log(`[kyclaw] 插件清扫：孤儿市场目录没能删除（先放着）${target}：${String(error)}`)
    }
  }

  return result
}
