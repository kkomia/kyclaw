// @vitest-environment node
/**
 * 安装/卸载器的静态合同（0.2.1，用户口径 2026-10-20）：
 *   **卸载向导里有一个勾选框：勾选则同时删除本机历史数据。**
 *
 * 为什么是静态测试而不是"跑一遍卸载器"：
 *   - 卸载器只能在真安装环境里跑，跑起来会真删 `%APPDATA%\kyclaw` 并在 HKCU 写卸载信息，
 *     不能在开发机/CI 上做（会动用户数据）；
 *   - 所以这里钉**配置与脚本合同**：electron-builder 确实挂载了 build/installer.nsh；脚本里
 *     有勾选框页面、删除范围只含应用数据（不含工作区）、自动更新/静默卸载默认保留。
 *   真机点按验收在发版安装包上做（发版流程验收项）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../')
const builderConfig = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
const installerNsh = readFileSync(join(repoRoot, 'build', 'installer.nsh'), 'utf8')

interface PackageScriptExports {
  uninstallerIncludeProblem(root?: string): string | null
}

async function packageScript(): Promise<PackageScriptExports> {
  const url = pathToFileURL(join(repoRoot, 'scripts', 'package.mjs')).href
  return (await import(url)) as PackageScriptExports
}

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-installer-contract-'))
  temps.push(dir)
  return dir
}

describe('安装包/卸载器：卸载时可选删除本地历史数据', () => {
  it('electron-builder 挂载了 build/installer.nsh，且不启用无提示的内置删除', () => {
    // nsis 段里必须有 include；内置 deleteAppDataOnUninstall 保持 false（那会静默删、无勾选框）
    expect(builderConfig).toMatch(/^nsis:[\s\S]*?^\s+include:\s*build\/installer\.nsh$/mu)
    expect(builderConfig).toMatch(/^\s+deleteAppDataOnUninstall:\s*false$/mu)
  })

  it('卸载欢迎页被替换成勾选框页面，且页面在卸载 section 之前收集选择', () => {
    expect(installerNsh).toMatch(/!macro customUnWelcomePage[\s\S]*?!macroend/u)
    expect(installerNsh).toMatch(/UninstPage custom un\.kyclawDeleteHistoryPageCreate/u)
    expect(installerNsh).toContain('${NSD_CreateCheckbox}')
    expect(installerNsh).toContain('同时删除本地历史数据')
    // 选择要在 customUnInstall（卸载 section 开头）里消费
    expect(installerNsh).toMatch(/!macro customUnInstall[\s\S]*?!macroend/u)
  })

  it('删除范围 = 应用数据 + 更新缓存；不碰工作区', () => {
    expect(installerNsh).toContain('RMDir /r "$APPDATA\\kyclaw"')
    expect(installerNsh).toContain('RMDir /r "$LOCALAPPDATA\\kyclaw-updater"')
    // 工作区（用户文件）不在删除范围内；页面文案要如实说明
    expect(installerNsh).not.toMatch(/RMDir\s+\/r\s+"\$PROFILE[^"]*kyclaw/iu)
    expect(installerNsh).not.toMatch(/RMDir\s+\/r\s+"\$APPDATA\\kyclaw\\工作区/iu)
    expect(installerNsh).toContain('不会删除你的工作区文件夹')
  })

  it('自动更新/静默卸载默认保留数据；显式 --delete-app-data 才删', () => {
    expect(installerNsh).toContain('${isUpdated}')
    expect(installerNsh).toMatch(/\$\{Silent\}/u)
    expect(installerNsh).toContain('--delete-app-data')
    // 默认值必须是"保留"（勾选页面才置 1；静默/更新分支会强制归零）
    expect(installerNsh).toMatch(/customUnInit[\s\S]*?StrCpy \$unKyclawDeleteHistory "0"/u)
  })
})

/**
 * 出包前自检（scripts/package.mjs 的 uninstallerIncludeProblem）：
 * 卸载器脚本/配置缺一个时，electron-builder 不报错、卸载器静默不删数据——必须在出包前拦住。
 */
describe('出包前自检：卸载器脚本与配置都必须在', () => {
  it('仓库现状：脚本在、nsis.include 挂上了 → 通过', async () => {
    const { uninstallerIncludeProblem } = await packageScript()
    expect(uninstallerIncludeProblem(repoRoot)).toBeNull()
  })

  it('缺 build/installer.nsh → 出包前就拦下', async () => {
    const { uninstallerIncludeProblem } = await packageScript()
    const root = tempRoot()
    writeFileSync(join(root, 'electron-builder.yml'), 'nsis:\n  include: build/installer.nsh\n')
    expect(uninstallerIncludeProblem(root)).toContain('缺卸载器自定义脚本')
  })

  it('脚本在但 nsis.include 没挂 → 拦下（否则勾选框静默不生效）', async () => {
    const { uninstallerIncludeProblem } = await packageScript()
    const root = tempRoot()
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(
      join(root, 'build', 'installer.nsh'),
      'customUnWelcomePage customUnInstall 同时删除本地历史数据'
    )
    writeFileSync(join(root, 'electron-builder.yml'), 'nsis:\n  oneClick: false\n')
    expect(uninstallerIncludeProblem(root)).toContain('nsis.include 没挂')
  })
})
