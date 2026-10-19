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

/**
 * 读 asar 头里**所有文件路径**（递归展开 `files`；目录条目不带 `files` 的按文件）。
 * M4-X 打包自检用：`out/renderer/office.html` / wasm 清单 / 不得有 `node_modules/@betteroffice`。
 * 头解析失败回 null（调用方如实报"没验成"，不冒充验过）。
 */
export function asarFilePaths(asarPath: string): string[] | null {
  let fd: number | undefined
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) return null
    const jsonSize = head.readUInt32LE(12)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) return null
    const raw = Buffer.alloc(jsonSize)
    if (readSync(fd, raw, 0, jsonSize, 16) !== jsonSize) return null
    const parsed = JSON.parse(raw.toString('utf8')) as {
      files?: Record<string, { files?: Record<string, unknown> }>
    }
    if (typeof parsed.files !== 'object' || parsed.files === null) return null
    const paths: string[] = []
    const walk = (
      files: Record<string, { files?: Record<string, unknown> }>,
      prefix: string
    ): void => {
      for (const [name, entry] of Object.entries(files)) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (entry !== null && typeof entry === 'object' && entry.files !== undefined) {
          walk(entry.files as Record<string, { files?: Record<string, unknown> }>, path)
        } else {
          paths.push(path)
        }
      }
    }
    walk(parsed.files, '')
    return paths
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
 * 依赖自带、**必须随包**的 wasm 的一条基线：文件名 + 必须落在哪个 npm 包目录下。
 *
 * 为什么带包名（R2-06①）：只按 basename 判的话，**任何**依赖里同名的 wasm 都能满足闸门
 * （`endsWith('/openjpeg.wasm')` 对 `node_modules/some-other-dep/openjpeg.wasm` 也成立），
 * 等于把"pdfjs 的运行时还在不在"这条语义悄悄换成了"asar 里某个角落有个同名文件"。
 * 所以每条都钉「`node_modules/<包>/**`（含 pnpm 的 `.pnpm/<包>@<版本>/node_modules/<包>/**`）」。
 */
export interface DependencyWasmBaseline {
  /** asar 里的文件名（不带内容 hash，稳定） */
  readonly name: string
  /** 必须出现在哪个 npm 包目录下 */
  readonly packageName: string
  /** 它为什么必须随包（失败信息里带一句，省得下一个人把它当噪音删掉） */
  readonly why: string
}

/** pdfjs 的 4 个 + xxhash 的 1 个：缺席时 PDF 预览 / 哈希只会在运行时炸，包能装、点开就崩（CR-24） */
export const DEPENDENCY_WASM_BASELINE: readonly DependencyWasmBaseline[] = [
  { name: 'quickjs-eval.wasm', packageName: 'pdfjs-dist', why: 'PDF 内脚本沙箱' },
  { name: 'openjpeg.wasm', packageName: 'pdfjs-dist', why: 'JPEG2000 图像解码' },
  { name: 'jbig2.wasm', packageName: 'pdfjs-dist', why: 'JBIG2 扫描件解码' },
  { name: 'qcms_bg.wasm', packageName: 'pdfjs-dist', why: '色彩管理' },
  { name: 'xxhash.wasm', packageName: 'xxhash-wasm', why: '哈希' }
]

/** Office 隔离面（`out/renderer/**`）应有的 wasm 数：4 DOCX + 1 XLSX + 1 PPTX */
export const OFFICE_WASM_COUNT = 6

/** 路径最后一段（asar 里一律 `/` 分隔） */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * 这条路径是不是落在 `node_modules/<包>/**` 下（含 pnpm 深路径）：
 *   `node_modules/pdfjs-dist/wasm/openjpeg.wasm`
 *   `node_modules/.pnpm/pdfjs-dist@5.0.0/node_modules/pdfjs-dist/wasm/openjpeg.wasm`
 * 只认这两类，`node_modules/别的包/openjpeg.wasm` 不算（R2-06①）。
 */
function insidePackageDir(path: string, packageName: string): boolean {
  if (path.startsWith(`node_modules/${packageName}/`)) return true
  return path.startsWith('node_modules/.pnpm/') && path.includes(`/node_modules/${packageName}/`)
}

/**
 * 打包 asar 的 wasm 闸门（**纯函数**：只吃 asar 文件路径清单，返回问题清单；空 = 过）。
 * 单测：`src/main/__tests__/packaged-wasm-gate.spec.ts`（离线、不碰打包件）。
 *
 * 两条互补、互不替代：
 *   1. **Office 面只许 6 个**（`out/renderer/**` 里、**且不属于依赖基线那 5 个名字**的 wasm）：
 *      4 DOCX + 1 XLSX + 1 PPTX，不许漏打、不许多打。这 6 个名字带内容 hash（Vite 产物），
 *      所以按**数量**钉，不钉名字。
 *      排除依赖名（R2-06②）：万一哪天 Vite 把 pdfjs/xxhash 的 wasm 也收进了 `out/renderer`，
 *      它们不会把 6 顶成 7 造成误报；这种"依赖 wasm 被收进渲染端"只在依赖侧缺席时才作为线索报出。
 *   2. **依赖自带 5 个按「包目录 + 名字」逐个必须在**（pdfjs 4 + xxhash 1，见
 *      {@link DEPENDENCY_WASM_BASELINE}）：将来 `files` 再收窄、或依赖升级把文件挪走/删掉，
 *      这里点名缺哪个、期望路径是什么、实际找到的同名文件在哪，而不是留给运行时去发现。
 *
 * 刻意**不数"全 asar 的 wasm 总数"**：那是把两类混在一起（PB-016 实测 11 个），既会因 Office 面
 * 变化误报、也会掩盖依赖侧漏打；上面两条各自更精确。
 */
export function wasmGateProblems(asarEntries: readonly string[]): string[] {
  const problems: string[] = []

  const dependencyNames = new Set(DEPENDENCY_WASM_BASELINE.map((item) => item.name))
  const officeWasm = asarEntries.filter(
    (path) =>
      path.startsWith('out/renderer/') &&
      path.endsWith('.wasm') &&
      !dependencyNames.has(basenameOf(path))
  )
  if (officeWasm.length !== OFFICE_WASM_COUNT) {
    problems.push(
      `app.asar 的 out/renderer 里 Office wasm 数量是 ${String(officeWasm.length)}，期望 ${String(OFFICE_WASM_COUNT)}（Office 面资源被漏打/多打？）`
    )
  }

  const missing: string[] = []
  for (const expected of DEPENDENCY_WASM_BASELINE) {
    const expectedPattern = `node_modules/${expected.packageName}/**/${expected.name}`
    const matched = asarEntries.some(
      (path) => basenameOf(path) === expected.name && insidePackageDir(path, expected.packageName)
    )
    if (matched) continue
    // 同名文件在别处（别的包 / out/renderer）：给出来，好判断是"挪了位置"还是"真删了"
    const sameName = asarEntries.filter((path) => basenameOf(path) === expected.name)
    const nearMiss =
      sameName.length === 0
        ? ''
        : `；实际找到同名文件：${sameName.slice(0, 3).join('、')}${sameName.length > 3 ? ` 等 ${String(sameName.length)} 处` : ''}（都不在期望包目录下）`
    missing.push(`${expectedPattern}（${expected.why}）${nearMiss}`)
  }
  if (missing.length > 0) {
    problems.push(
      `app.asar 里缺依赖自带的 wasm（${String(missing.length)} 个；期望路径模式含 pnpm 的 ` +
        `\`.pnpm/<包>@<版本>/node_modules/<包>/**\` 深路径）：\n- ${missing.join('\n- ')}\n` +
        '（pdfjs 预览 / xxhash 的运行时；打包排除项收窄、或依赖升级把它们挤掉了？）'
    )
  }
  return problems
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
    // M4-X（recon §4）：Office 面产物必须进 asar；@betteroffice 的包目录不能进（只允许 Vite 内联代码）
    const asarEntries = asarFilePaths(layout.asar)
    if (asarEntries === null) {
      problems.push('app.asar 头部解析失败：无法核验 Office 面资源（office.html / wasm / 字体）')
    } else {
      const officeHtml = asarEntries.find((path) => path === 'out/renderer/office.html')
      if (officeHtml === undefined) {
        problems.push('app.asar 里没有 out/renderer/office.html（Office 隔离面没进包）')
      }
      // M4-P + CR-24：Office 面 6 个 wasm 计数闸门 + 依赖自带 5 个 wasm 的名字基线（详见 wasmGateProblems）
      problems.push(...wasmGateProblems(asarEntries))
      const bundledBetterOffice = asarEntries.filter((path) =>
        path.startsWith('node_modules/@betteroffice/')
      )
      if (bundledBetterOffice.length > 0) {
        problems.push(
          `app.asar 里出现了 node_modules/@betteroffice（应只留 Vite 内联代码，不随 node_modules 打包）：${bundledBetterOffice.slice(0, 3).join('、')}`
        )
      }
      const fontCount = asarEntries.filter(
        (path) => path.endsWith('.ttf') || path.endsWith('.otf')
      ).length
      // BetterOffice 自带 65 TTF + 5 OTF，但 asar 里还混有 PDF/文档预览等其它字体资产：
      // 数量按"至少 70"兜底，另点名验证 BetterOffice 的几支代表字体（西文/CJK/衬线）确实在。
      if (fontCount < 70) {
        problems.push(
          `app.asar 里字体文件只有 ${String(fontCount)} 个，少于 BetterOffice 的 65 ttf + 5 otf`
        )
      }
      const requiredFonts = [
        'Carlito-Regular-',
        'SourceSans3-Regular-',
        'NotoSansSC-Regular-',
        'NotoSerifSC-Regular-'
      ]
      for (const font of requiredFonts) {
        if (!asarEntries.some((path) => path.includes(font))) {
          problems.push(`app.asar 里缺 BetterOffice 字体「${font}」（字体资产漏打？）`)
        }
      }
    }
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
