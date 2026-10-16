/**
 * R91 打包态预览探针的夹具层：**只认 exe 所在那个安装目录**做文件/asar 断言，并把 profile 与工作区
 * 预置在 `mkdtemp` 里（不碰真实 profile、不读 secrets）。
 *
 * 与 R90 的分工：R90 验"构建态（`out/`）的应用级预览"，这里验**装出来的那一份 exe**。
 * 启动方式借 `e2e/update-notes.spec.ts` 的 exe override（`electron.launch({ executablePath })`）——
 * **不改** `fixtures/interactive.ts` / `fixtures/r90`（那是 R90 用的，别人在途）。
 *
 * 这里只做两件产品无关的事：
 *   1. 对安装目录做**路径断言**（app.asar / app.asar.unpacked / 随包 kit / 随包发行日志 / 许可声明 /
 *      asar 里没有根 `patches/**`）；
 *   2. 预置一个**受控 profile**（显式 workspace + `defaultWorkspaceInitialized: true` + 指向本地
 *      scripted provider 的 provider 条目），保证应用不会去碰 `<home>/kyclaw/工作区`。
 */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { defaultSettings } from '../../src/shared/settings'

/** 打包件路径：可用环境变量指向别处（例如某次发布解出来的目录） */
export const PACKAGED_EXE_ENV = 'KYCLAW_PACKAGED_PREVIEW_EXE'

/** 缺省指向 `pnpm package` / `pnpm build:unpack` 的产物 */
export function packagedExePath(): string {
  return process.env[PACKAGED_EXE_ENV] ?? resolve('dist', 'win-unpacked', 'kyclaw.exe')
}

export interface PackagedLayout {
  readonly exe: string
  readonly installDir: string
  readonly resources: string
  readonly asar: string
  readonly unpacked: string
}

/** 安装目录的几个固定落点（exe 同级的 `resources/`） */
export function packagedLayout(exePath: string): PackagedLayout {
  const installDir = dirname(exePath)
  const resources = join(installDir, 'resources')
  return {
    exe: exePath,
    installDir,
    resources,
    asar: join(resources, 'app.asar'),
    unpacked: join(resources, 'app.asar.unpacked')
  }
}

/** 仓库自己的版本（"本版"的唯一来源；打包件必须与它一致） */
export function repoVersion(): string {
  const parsed = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error('package.json 里读不到 version')
  }
  return parsed.version
}

/** 在目录树里按后缀正则找一个文件（深度封顶，找不到回 null） */
function findBySuffix(root: string, pattern: RegExp, maxDepth = 8): string | null {
  if (!statSync(root).isDirectory()) return null
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop() as { dir: string; depth: number }
    for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
      const path = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) stack.push({ dir: path, depth: current.depth + 1 })
        continue
      }
      if (pattern.test(path)) return path
    }
  }
  return null
}

/**
 * 读 asar 头里的顶层文件名。真实布局（Chromium pickle；bytes: `04 00 00 00` + 两个长度 + JSON 长
 * + `{"files":…}`，实测 `dist/win-unpacked/resources/app.asar`）：
 *   `[u32: 4][u32: 头块大小][u32: 头块大小 - 4][u32: JSON 字节数][JSON …]`
 * ——JSON **大小在 offset 12、正文从 offset 16 起**。布局认不出来就回 null（调用方走整文件扫描的
 * 兜底，并把"没验成"说出来，不冒充验过）。
 */
export function asarTopLevelNames(asarPath: string): string[] | null {
  let fd: number | undefined
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) return null
    const jsonSize = head.readUInt32LE(12)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) return null
    const raw = Buffer.alloc(jsonSize)
    if (readSync(fd, raw, 0, jsonSize, 16) !== jsonSize) return null
    const parsed = JSON.parse(raw.toString('utf8')) as { files?: Record<string, unknown> }
    if (typeof parsed.files !== 'object' || parsed.files === null) return null
    return Object.keys(parsed.files)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 根 `patches/**` 里的补丁文件名（进了 asar 就是打包配置漏了排除） */
const PATCH_FILE_NAMES = [
  '@fortune-sheet__core@1.0.4.patch',
  '@fortune-sheet__react@1.0.4.patch',
  'exceljs@4.4.0.patch'
]

/** 整文件扫这几个补丁名（分块读、块间留重叠——名字可能正好跨在块边界上） */
function scanFileForNames(asarPath: string, names: readonly string[]): string[] {
  const fd = openSync(asarPath, 'r')
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024)
    const overlap = Math.max(0, ...names.map((name) => name.length - 1))
    const hits: string[] = []
    let carry = ''
    let offset = 0
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, offset)
      if (read <= 0) break
      const text = carry + chunk.subarray(0, read).toString('latin1')
      for (const name of names) {
        if (!hits.includes(name) && text.includes(name)) hits.push(name)
      }
      carry = text.slice(-overlap)
      offset += read
    }
    return hits
  } finally {
    closeSync(fd)
  }
}

/**
 * asar 里有没有根 `patches/**`：先看头里的顶层名字（定论）；头部解析失败就**整文件**扫那几个
 * 补丁文件名（ASCII，latin1 读不担心多字节断开）。两条路都要给出结论——解析失败又扫不到，
 * 也要说出来（"没验成"不等于"验过"）。
 */
export function asarPatchProblems(asarPath: string): string[] {
  const top = asarTopLevelNames(asarPath)
  if (top !== null) {
    return top.includes('patches')
      ? [`app.asar 里有根 patches/（打包配置的 !patches/** 排除失效了）`]
      : []
  }
  const hit = scanFileForNames(asarPath, PATCH_FILE_NAMES)
  if (hit.length > 0) {
    return [`app.asar 里出现了补丁文件（${hit.join('、')}）——打包配置的 !patches/** 排除失效了`]
  }
  return [
    `app.asar 的头部解析失败（asar 布局又变了？）：整文件也没扫到补丁文件名，但这条不算"验过"，请人工看一眼 ${asarPath}`
  ]
}

/**
 * 安装目录的"缺什么"清单（空数组 = 全齐）。门开着时这些**每一条都是硬闸门**。
 * @param layout 安装目录落点
 * @param version 本版版本号（`repoVersion()`）
 */
export function packagedResourceProblems(layout: PackagedLayout, version: string): string[] {
  const problems: string[] = []
  if (!statSync(layout.exe, { throwIfNoEntry: false })?.isFile()) {
    problems.push(
      `没有打包件：${layout.exe}（先 \`pnpm package\`，或用 ${PACKAGED_EXE_ENV} 指到别的解包目录）`
    )
    return problems
  }
  if (!statSync(layout.asar, { throwIfNoEntry: false })?.isFile()) {
    problems.push(`没有 ${layout.asar}（打包件结构不对？）`)
  } else {
    problems.push(...asarPatchProblems(layout.asar))
  }
  if (!statSync(layout.unpacked, { throwIfNoEntry: false })?.isDirectory()) {
    problems.push(`没有 ${layout.unpacked}（asarUnpack 没生效？）`)
  } else {
    if (findBySuffix(layout.unpacked, /@libsql[\\/]win32-x64-msvc[\\/]index\.node$/) === null) {
      problems.push(
        `app.asar.unpacked 里没有 @libsql 的 .node（装了也起不了库）：${layout.unpacked}`
      )
    }
    if (
      findBySuffix(layout.unpacked, /node-pty[\\/]prebuilds[\\/]win32-x64[\\/]pty\.node$/) === null
    ) {
      problems.push(`app.asar.unpacked 里没有 node-pty 的预构建件：${layout.unpacked}`)
    }
  }
  const notes = join(layout.resources, 'release-notes', `${version}.md`)
  const notesStat = statSync(notes, { throwIfNoEntry: false })
  if (notesStat === undefined || !notesStat.isFile()) {
    problems.push(
      `随包发行日志不在：${notes}（extraResources 的 build/release-notes 那条被改坏了？）`
    )
  } else {
    const text = readFileSync(notes, 'utf8')
    if (!text.includes(version)) problems.push(`随包发行日志里没提到本版版本号：${notes}`)
  }
  const notices = join(layout.resources, 'skills', 'THIRD_PARTY_NOTICES.md')
  if (statSync(notices, { throwIfNoEntry: false })?.isFile() !== true) {
    problems.push(`随包的第三方许可声明不在：${notices}`)
  }
  const kit = join(
    layout.resources,
    'libreoffice-kit',
    'node_modules',
    '@deepseek-ai',
    'libreoffice-kit',
    'lib',
    'cli.js'
  )
  if (statSync(kit, { throwIfNoEntry: false })?.isFile() !== true) {
    problems.push(`随包 kit 不在：${kit}（Office 页式预览跑不起来）`)
  }
  return problems
}

export interface PackagedProfile {
  /** 本次探针独有的临时根（profile / workspace 都在它下面） */
  readonly root: string
  readonly profileDir: string
  readonly workspace: string
  readonly settingsFile: string
}

/**
 * 预置一个受控 profile：显式 workspace + `defaultWorkspaceInitialized: true`（应用不会去建/碰
 * `<home>/kyclaw/工作区`）、关掉语义召回与追踪、只留一个指向本地 scripted stub 的 provider。
 * **不写 secrets、不读真实 profile。**
 * @param providerUrl 本地 scripted provider 的 base URL
 */
export function writePackagedProfile(providerUrl: string): PackagedProfile {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-r91-'))
  const profileDir = join(root, 'profile')
  const workspace = join(root, 'workspace')
  for (const directory of [profileDir, workspace]) mkdirSync(directory, { recursive: true })
  const settings = defaultSettings()
  settings.workspaces = [{ path: workspace, mode: 'ask' }]
  settings.defaultWorkspace = workspace
  settings.defaultWorkspaceInitialized = true
  settings.semanticRecall.enabled = false
  settings.langfuse.endpoint = ''
  settings.providers = [
    {
      id: 'r91-stub',
      type: 'openai-compatible',
      baseUrl: providerUrl,
      model: 'r91-stub',
      isDefault: true
    }
  ]
  const settingsFile = join(profileDir, 'settings.json')
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { root, profileDir, workspace, settingsFile }
}

/** 清掉自建临时根（失败也不影响判定） */
export function removePackagedProfile(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
