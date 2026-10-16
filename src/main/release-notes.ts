import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BundledReleaseNotes } from '../shared/ipc'

/**
 * 「本版本发行说明」的读盘（本轮）：设置页「关于」那块常驻的「更新日志」入口读它。
 *
 * 为什么必须随包一份：源上渠道 yml 的 `releaseNotes` 只有"检出**更新**"才会进界面（相位是
 * available / downloading / downloaded 才有），已是最新、断网、没配更新源这三条路上都拿不到 ——
 * 而用户要看的是"我现在装的这一版改了什么"。所以出包时把 `build/release-notes/<版本>.md`
 * 拷进安装目录的 `resources/release-notes/`（electron-builder.yml 的 extraResources），
 * 主进程在本地读它，与更新通道、网络都没有关系。
 *
 * 三条硬口径：
 *   1. **只读 `app.getVersion()` 对应的那一个文件名**（`<版本>.md`）。找不到就是 missing，
 *      **绝不回退到别的版本的文件**——那会变成"把上一版/新一版的说明挂在眼前这一版上"；
 *   2. 有大小上限：超限整份不显示（unreadable），不截半截冒充全文；
 *   3. 缺失（missing）与读不出来（unreadable）分开：界面给不同的话。
 *
 * 同步读：本地小文件、IPC handler 里一次读完，没有并发读写的问题（与 `readBundledUpdateUrl`
 * 读 app-update.yml 同一手法）。开发态的落点走仓库（`build/release-notes/`，改完日志不用重打包），
 * 打包态走安装目录（`process.resourcesPath`）——与 llama / skills 的资源定位同一套。
 */

/** 单份发行说明的上限（字节）：0.1.1 那份约 4.4 KB；给足余量，但绝不无界读 */
export const RELEASE_NOTES_MAX_BYTES = 64 * 1024

/** 本版本说明的落点：打包态在安装目录 resources/ 下，开发态在仓库 build/ 下 */
export function bundledReleaseNotesPath(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  version: string
}): string {
  const dir = options.isPackaged
    ? join(options.resourcesPath, 'release-notes')
    : join(options.appPath, 'build', 'release-notes')
  return join(dir, `${options.version}.md`)
}

/**
 * 读本版本的发行说明。**不抛**：三种结果都在回包里说清（回包形状见 shared/ipc 的
 * `bundledReleaseNotesSchema`）。
 */
export function readBundledReleaseNotes(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  version: string
}): BundledReleaseNotes {
  const file = bundledReleaseNotesPath(options)

  let size: number
  try {
    const stat = statSync(file)
    // 这个位置上不是文件（目录等）：不是"这一份"
    if (!stat.isFile()) return { state: 'missing' }
    size = stat.size
  } catch (error) {
    // 没有这个文件 = 本版没随发行说明（老包里没有、开发态没写日志），是正常情况；
    // 其余（权限等）算读不出来 —— 两者在界面上说的话不一样
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', message: '本版发行说明读取失败' }
  }

  if (size > RELEASE_NOTES_MAX_BYTES) {
    return {
      state: 'unreadable',
      message: `本版发行说明超过 ${Math.round(RELEASE_NOTES_MAX_BYTES / 1024)} KiB，未显示`
    }
  }

  try {
    // BOM 与首尾空白归一（打包进包的是仓库那份 md；BOM 不该出现在界面上）
    const notes = readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
    // 空文件当"没有这一份"：没有可看的内容就不装作有（出包时 package.mjs 已经拦过空日志）
    if (notes.length === 0) return { state: 'missing' }
    return { state: 'ok', version: options.version, notes }
  } catch {
    return { state: 'unreadable', message: '本版发行说明读取失败' }
  }
}
