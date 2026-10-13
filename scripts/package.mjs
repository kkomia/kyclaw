/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 出包脚本，零依赖零类型 */
/**
 * 出包入口（T15）：`pnpm package` = electron-vite build + electron-builder（Windows NSIS 用户级安装）。
 *
 * 为什么单起一个脚本而不是一行 npm script：
 *   1. `--publish never` 要写死——上传是单独一步（round 62 起内测更新走局域网 MinIO，
 *      但 electron-builder 本身不发布；它在 CI 环境里默认会试着发布，这里永远关死）；
 *   2. 打包前**预清上一次的打包输出**（只清 electron-builder 自己写的那些条目，dist/ 里别的
 *      内容一律不碰），打包后自检两个"构建成功但装完会发现"的坑：**本版本**（绑 package.json
 *      的 name/version）的安装包在不在、asarUnpack 有没有真的把 libsql 的原生绑定
 *      （@libsql/win32-x64-msvc/index.node）与 ?asset 资源解到 app.asar.unpacked（T15①）。
 *
 * 环境照传：pnpm 会把 .npmrc 的镜像写成 npm_config_electron_mirror /
 * npm_config_electron_builder_binaries_mirror，Electron 与 NSIS 的下载靠它走 npmmirror。
 *
 * 纯函数（expectedInstallerName / staleOutputs / cleanStaleOutputs / projectManifest）导出供最小验证：
 * 直接执行才跑打包流程，被 `import()` 时只拿函数（见终审 fix wave 报告的验证记录）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT, 'dist')
const UNPACKED_DIR = join(DIST_DIR, 'win-unpacked', 'resources', 'app.asar.unpacked')
/** 本机嵌入引擎的运行时（模块 3B）：`pnpm fetch:llama` 落的裁剪后 llama.cpp 目录 */
const LLAMA_DIR = join(ROOT, 'resources', 'llama')
const LLAMA_EXE = 'llama-server.exe'
/** 随包的 LibreOffice 渲染引擎（round 68）：`pnpm fetch:libreoffice-kit` 落的 npm 平铺目录 */
const KIT_DIR = join(ROOT, 'resources', 'libreoffice-kit')
const KIT_CLI_RELATIVE = 'node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'
/**
 * 随包引擎包里的关键件（**相对引擎包目录**）。`bin/libreoffice-kit.exe` 是自包含的引擎本体，
 * `licenses/` 与 `sources/` 是 MPL-2.0 的分发义务（许可文本 + 源码配方，见 THIRD_PARTY_NOTICES 第 3 节），
 * 三者缺一都说明这份 kit 是坏的或打包配置被改坏了。`program/` 不是硬需求（引擎起不来时才有用），
 * 但它 12MB 且随包能省事，所以缺了也当异常。
 */
const KIT_ENGINE_RELATIVE = 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64'
const KIT_ENGINE_FILES = ['bin/libreoffice-kit.exe', 'program', 'sources', 'licenses']

function fail(message) {
  console.error(`[package] ${message}`)
  process.exit(1)
}

function run(command, args) {
  // Windows 上 node_modules/.bin 里是 .cmd 外壳，得经 shell 起；PATH 里显式补上 .bin，
  // 这样直接 `node scripts/package.mjs` 也能跑（不只在 pnpm 脚本里）。
  // 命令拼成一整串再交给 shell：这里的参数都是脚本里写死的，没有注入面，
  // 也避开 Node 24 对 "shell + args 数组"（DEP0190）的告警。
  const line = [command, ...args].join(' ')
  const result = spawnSync(line, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      PATH: `${join(ROOT, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`
    }
  })
  if (result.error) fail(`${command} 起不来：${result.error.message}`)
  if (result.status !== 0) fail(`${line} 退出码 ${result.status}`)
}

/** 递归列出目录下所有文件（相对 unpacked 根的路径） */
function listFiles(dir, prefix = '') {
  const entries = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) entries.push(...listFiles(full, relative))
    else entries.push(relative)
  }
  return entries
}

/** package.json 的 name/version（自检的锚；缺一个就抛，别用错的锚过检） */
export function projectManifest(root = ROOT) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`读不到 package.json：${error instanceof Error ? error.message : error}`)
  }
  if (
    typeof manifest.name !== 'string' ||
    manifest.name === '' ||
    typeof manifest.version !== 'string' ||
    manifest.version === ''
  ) {
    throw new Error('package.json 缺 name/version，出包自检没有版本锚')
  }
  return { name: manifest.name, version: manifest.version }
}

/** 本版本的安装包名——与 electron-builder.yml 的 nsis.artifactName（${name}-${version}-setup.${ext}）同口径 */
export function expectedInstallerName({ name, version }) {
  return `${name}-${version}-setup.exe`
}

/**
 * 上一次打包的输出清单（T15① 预清的对象）：只认 electron-builder 自己写的条目——
 * 安装包 / blockmap / win-unpacked 解包目录 / builder-*.yml 构建档。dist/ 里别的内容不碰。
 */
export function staleOutputs(distDir = DIST_DIR) {
  if (!existsSync(distDir)) return []
  return readdirSync(distDir).filter(
    (name) =>
      /^kyclaw-.*-setup\.exe(\.blockmap)?$/.test(name) ||
      name === 'win-unpacked' ||
      /^builder-.*\.ya?ml$/.test(name)
  )
}

/** 预清上一次的打包输出；返回清掉的条目（陈旧包不能顶替本版本过检） */
export function cleanStaleOutputs(distDir = DIST_DIR) {
  const removed = []
  for (const name of staleOutputs(distDir)) {
    rmSync(join(distDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

function main() {
  try {
    // 本机嵌入引擎的运行时必须是现成的：缺了它打出来的包"本地模型"一路直接不可用
    // （应用不会崩，是失败只做加法的降级——但出包时这是明确缺件，不该悄悄放过）
    if (!existsSync(join(LLAMA_DIR, LLAMA_EXE))) {
      fail(
        `缺本机嵌入引擎运行时：${join(LLAMA_DIR, LLAMA_EXE)}\n` +
          '  先跑一次 `pnpm fetch:llama`（下载 + SHA256 校验 + 裁剪，约 42MB）再出包'
      )
    }

    // round 68：`render_ppt` 的随包 LibreOffice 渲染引擎。缺了它应用不会崩（渲染会退到
    // PowerPoint COM / 逐页文字结构），但"随包渲染能力"这件事就落空了 —— 出包时是明确缺件。
    if (!existsSync(join(KIT_DIR, ...KIT_CLI_RELATIVE.split('/')))) {
      fail(
        `缺随包的 LibreOffice 渲染引擎：${join(KIT_DIR, ...KIT_CLI_RELATIVE.split('/'))}\n` +
          '  先跑一次 `pnpm fetch:libreoffice-kit`（从 npm 拉取 + integrity 校验，约 194MB）再出包'
      )
    }

    const cleared = cleanStaleOutputs()
    if (cleared.length > 0) {
      console.log(`[package] 预清上一次的打包输出：${cleared.join('、')}`)
    }

    run('electron-vite', ['build'])
    run('electron-builder', ['--win', '--publish', 'never'])

    const expected = expectedInstallerName(projectManifest())
    if (!existsSync(join(DIST_DIR, expected))) {
      const found = existsSync(DIST_DIR)
        ? readdirSync(DIST_DIR).filter((name) => name.endsWith('-setup.exe'))
        : []
      fail(
        `dist/ 下没有本版本的安装包 ${expected}（版本不符或构建失败？` +
          `${found.length === 0 ? '' : `只看到：${found.join('、')}`}）`
      )
    }
    const installers = readdirSync(DIST_DIR).filter((name) => /^kyclaw-.*-setup\.exe$/.test(name))
    if (installers.length !== 1) {
      fail(`dist/ 下有多份安装包（${installers.join('、')}）——预清没生效？`)
    }

    if (!existsSync(UNPACKED_DIR)) fail(`没有解包目录：${UNPACKED_DIR}（asarUnpack 没生效）`)
    const unpacked = listFiles(UNPACKED_DIR)
    const libsqlBindings = unpacked.filter(
      (path) => path.endsWith('.node') && path.includes('@libsql')
    )
    if (libsqlBindings.length === 0) {
      fail(
        'app.asar.unpacked 里没有 @libsql 的 .node——装了也起不了库。\n' +
          '  常见原因：**没有经 pnpm 跑**（直接 `node scripts/package.mjs` 时 electron-builder 认不出 pnpm，\n' +
          '  会把平台相关的可选依赖 @libsql/win32-x64-msvc 漏掉）。请用 `pnpm package`。'
      )
    }
    // 引擎运行时走 extraResources：应当在 resources/llama/ 下（**不在** app.asar.unpacked 里，
    // 也不该出现在 app.asar 内部——它也进不了 asar：exe/dll 得从磁盘直接执行）
    const engineDir = join(DIST_DIR, 'win-unpacked', 'resources', 'llama')
    if (!existsSync(join(engineDir, LLAMA_EXE))) {
      fail(
        `resources/llama/${LLAMA_EXE} 没有进包（electron-builder.yml 的 extraResources 被改坏了？）`
      )
    }
    const engineBytes = listFiles(engineDir).reduce(
      (sum, name) => sum + statSync(join(engineDir, name)).size,
      0
    )
    if (engineBytes < 30 * 1024 * 1024) {
      fail(`resources/llama 只有 ${(engineBytes / 1024 / 1024).toFixed(1)} MB——裁剪结果不完整？`)
    }
    // round 68：随包的 LibreOffice 渲染引擎同样走 extraResources（`resources/libreoffice-kit/`）。
    // 它必须**在 asar 之外**：里面的 exe 要从磁盘直接执行，kit 也靠常规 Node 解析去同目录找引擎包。
    const kitOutDir = join(DIST_DIR, 'win-unpacked', 'resources', 'libreoffice-kit')
    if (!existsSync(join(kitOutDir, ...KIT_CLI_RELATIVE.split('/')))) {
      fail(
        `resources/libreoffice-kit 没有进包（electron-builder.yml 的 extraResources 被改坏了？）\n` +
          `  应有：${join(kitOutDir, ...KIT_CLI_RELATIVE.split('/'))}`
      )
    }
    const kitEngineDir = join(kitOutDir, ...KIT_ENGINE_RELATIVE.split('/'))
    const kitMissing = KIT_ENGINE_FILES.filter(
      (relative) => !existsSync(join(kitEngineDir, ...relative.split('/')))
    )
    if (kitMissing.length > 0) {
      fail(
        `随包渲染引擎不完整，缺：${kitMissing.join('、')}（许可与源码配方也必须随包，见 THIRD_PARTY_NOTICES 第 3 节）`
      )
    }
    const kitBytes = listFiles(kitOutDir).reduce(
      (sum, name) => sum + statSync(join(kitOutDir, name)).size,
      0
    )
    if (kitBytes < 150 * 1024 * 1024) {
      fail(`resources/libreoffice-kit 只有 ${(kitBytes / 1024 / 1024).toFixed(1)} MB——引擎没进包？`)
    }
    // round 62：更新通道的随包产物——generic 源（局域网 MinIO）靠它工作，缺了测试机就不会检查更新。
    // 通道文件名跟着版本走：预发布（0.1.0-beta.N）是 beta.yml，正式版才是 latest.yml
    // （electron-builder 的 channel 语义，与包内 app-update.yml 的 `channel: beta` 配对）。
    const channelFile = String(projectManifest().version).includes('-') ? 'beta.yml' : 'latest.yml'
    if (!existsSync(join(DIST_DIR, channelFile))) {
      fail(`dist/ 下没有 ${channelFile}（electron-builder.yml 的 publish 配置被改坏了？）`)
    }
    if (!existsSync(join(DIST_DIR, 'win-unpacked', 'resources', 'app-update.yml'))) {
      fail('resources/app-update.yml 没有进包（publish 配置被改坏了？测试机不会检查更新）')
    }

    console.log('[package] 产物：')
    for (const name of installers) {
      console.log(
        `  dist/${name}  ${(statSync(join(DIST_DIR, name)).size / 1024 / 1024).toFixed(1)} MB`
      )
    }
    console.log(`[package] 解包的原生绑定：${libsqlBindings.join('、')}`)
    console.log(
      `[package] 本机嵌入引擎：resources/llama 共 ${(engineBytes / 1024 / 1024).toFixed(1)} MB（未压缩）`
    )
    console.log(
      `[package] 随包渲染引擎：resources/libreoffice-kit 共 ${(kitBytes / 1024 / 1024).toFixed(1)} MB（未压缩，含许可与源码配方）`
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// 直接执行（node scripts/package.mjs）才跑打包；被 import() 时只取纯函数（最小验证用）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
