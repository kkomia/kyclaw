/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 获取脚本，零依赖零类型 */
/**
 * 随包的 LibreOffice 渲染能力（round 68）：`pnpm fetch:libreoffice-kit`。
 *
 * 为什么要有它：`render_ppt` 原来只有 PowerPoint COM 一条路 —— 没装 Office（或非 Windows）
 * 就只剩"逐页文字结构"，模型**看不到自己产出的页图**，视觉自检这一档直接做不了。这份随包的
 * LibreOffice 渲染引擎（DeepSeek Harness 开源的 `@deepseek-ai/libreoffice-kit`）把这条路补上，
 * 且**不依赖用户装没装 Office**。
 *
 * 它的体积（本机实测，win32-x64）：`bin/libreoffice-kit.exe` 178.5MB + `program/` 12MB
 * + `sources/` 803KB + `licenses/` 368KB，引擎包解包 **190.9MB**；连包装层、koffi、字体库算进去，
 * 整个 `resources/libreoffice-kit/` 是 **194.4MiB（198MB）**。**不进 git**
 * （同 `fetch:llama` 的口径），由本脚本从 npm 取 pin 死的版本落到 `resources/libreoffice-kit/`，
 * 再被 electron-builder 的 extraResources 原样放进安装包（**不进 asar**：里面的 exe 要从磁盘上执行）。
 *
 * 为什么用 `npm install --prefix` 而不是 `pnpm add`：
 *   1. **这份必须是"真目录、平铺、完整闭包"** —— 它的入口会用 Node 的常规解析去找同平台引擎包
 *      （`@deepseek-ai/libreoffice-kit-<platform>`）和 `koffi`；pnpm 的隔离式布局里，引擎包只是
 *      深层虚拟目录里的一个链接，顶层的 `node_modules/@deepseek-ai/` **根本看不到它**，
 *      electron-builder 收依赖时也就收不到 —— 会打出一个"渲染器在里面但起不来"的包（实测）。
 *   2. 它**不进我们的 `dependencies`**：那是运行时依赖，会连同 `koffi`（原生 FFI 扩展）一起被
 *      electron-builder 收进 app.asar，而真正要用的那份在 `resources/` 里 —— 一份坏的一份好的。
 *      `resources/llama` 也是这个口径（二进制走 extraResources，不进 node_modules）。
 *
 * 版本与完整性：版本 pin 在下面的 `PINNED`；`package-lock.json` 记下每个包（含没装到本机的
 * 其他平台包）的 `resolved` 与 `integrity`，npm 安装时按它校验 —— 换版本时改 `PINNED` 再跑一次。
 *
 * 平台：装哪个引擎由 npm 按当前平台挑 optionalDependencies（win32-x64 / win32-arm64 /
 * darwin-x64 / darwin-arm64 有原生包，其余平台落 wasm 包）。**只有 win32-x64 在本机实测过**
 * （见 `_r68-*` 探针），其他平台是"包存在、没跑过"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'resources', 'libreoffice-kit')

/** pin 死的版本（换版本时：改这里 + 跑一次 `pnpm fetch:libreoffice-kit` + 更新许可与报告里的数字） */
const PINNED = {
  entry: '@deepseek-ai/libreoffice-kit',
  version: '0.1.5'
}

/** 入口包里的 CLI（我们要 spawn 的就是它） */
const CLI_RELATIVE = join('node_modules', PINNED.entry, 'lib', 'cli.js')

/**
 * 引擎包按平台挑名字：和 npm 装的是同一个（`optionalDependencies` 里的那几条）。
 * 这里只用于**安装后核对**：没有对应平台的引擎包 = 这份渲染器起不来。
 */
const ENGINE_PACKAGES = {
  'win32-x64': `${PINNED.entry}-win32-x64`,
  'win32-arm64': `${PINNED.entry}-win32-arm64`,
  'darwin-x64': `${PINNED.entry}-darwin-x64`,
  'darwin-arm64': `${PINNED.entry}-darwin-arm64`
}

/** 引擎包里必须齐全的东西（少一样都说明这份安装是坏的） */
const ENGINE_FILES = ['bin/libreoffice-kit.exe', 'program', 'sources', 'licenses', 'prebuilds.json']

function fail(message) {
  console.error(`[fetch-libreoffice-kit] ${message}`)
  process.exit(1)
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 目录大小（递归；只用于打印与核对） */
function directorySize(path) {
  let total = 0
  const walk = (current) => {
    let stats
    try {
      stats = statSync(current)
    } catch {
      return
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) walk(join(current, entry))
      return
    }
    total += stats.size
  }
  walk(path)
  return total
}

/**
 * 仓库 `.npmrc` 里 pin 的 registry（本机是 npmmirror）。
 * 显式转给 npm：npm 读的是**它自己的 prefix** 下的配置，不会往上看仓库根的那份。
 */
function registryOf() {
  try {
    const text = readFileSync(join(ROOT, '.npmrc'), 'utf8')
    const matched = /^registry=(.+)$/m.exec(text)
    return matched === null ? null : matched[1].trim()
  } catch {
    return null
  }
}

/** 写"要装什么"（npm 的 prefix 就落在这个目录，node_modules 是它的直接子目录） */
async function writeStagingManifest() {
  const manifest = {
    name: 'kyclaw-libreoffice-kit',
    version: '0.0.0',
    private: true,
    description:
      'render_ppt 随包的 LibreOffice 渲染引擎（由 scripts/fetch-libreoffice-kit.mjs 获取，不入库）',
    dependencies: { [PINNED.entry]: PINNED.version }
  }
  await writeFile(join(OUT_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function install() {
  await mkdir(OUT_DIR, { recursive: true })
  await writeStagingManifest()

  const args = [
    'install',
    '--prefix',
    `"${OUT_DIR}"`,
    // koffi 的 install 脚本是"用 cnoke 现场编译原生扩展"；它自带预编译件（@koromix/koffi-*），
    // 实测不跑脚本也能用。跑它反而要求本机有 C 工具链 —— 打包机不该有这负担。
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ]
  const registry = registryOf()
  if (registry !== null) args.push(`--registry=${registry}`)

  console.log(`[fetch-libreoffice-kit] npm ${args.join(' ')}`)
  // Windows 上 npm 是 npm.cmd（Node 18+ 起必须走 shell 才起得来）。整条命令拼成一个字符串再交给
  // shell：既避开 `shell:true` + args 数组的 DEP0190（args 不转义，只拼空格），也让上面的引号生效。
  const result = spawnSync(['npm', ...args].join(' '), {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true
  })
  if (result.status !== 0) fail(`npm 安装失败（退出码 ${result.status ?? 'null'}）`)
}

/** 核对这份安装是不是"真能用"的那份：CLI 在位、引擎包在位、版本对得上、许可与源码配方都在 */
async function verify() {
  const cli = join(OUT_DIR, CLI_RELATIVE)
  if (!existsSync(cli)) fail(`没有找到 CLI（先跑一次 \`pnpm fetch:libreoffice-kit\`）：${cli}`)

  const entry = JSON.parse(
    await readFile(join(OUT_DIR, 'node_modules', PINNED.entry, 'package.json'), 'utf8')
  )
  if (entry.version !== PINNED.version) {
    fail(`入口包版本对不上：装的是 ${entry.version}，pin 的是 ${PINNED.version}`)
  }

  const engineName = ENGINE_PACKAGES[`${process.platform}-${process.arch}`]
  if (engineName === undefined) {
    console.warn(
      `[fetch-libreoffice-kit] ${process.platform}-${process.arch} 没有原生引擎包，npm 落的是 wasm 版；` +
        '本机没有实测过这条（见脚本头注）'
    )
  } else {
    const engineDir = join(OUT_DIR, 'node_modules', ...engineName.split('/'))
    const missing = ENGINE_FILES.filter(
      (relative) => !existsSync(join(engineDir, ...relative.split('/')))
    )
    if (missing.length > 0) fail(`引擎包 ${engineName} 不完整，缺：${missing.join('、')}`)
    const engine = JSON.parse(await readFile(join(engineDir, 'package.json'), 'utf8'))
    if (engine.version !== PINNED.version) {
      fail(`引擎包版本对不上：装的是 ${engine.version}，pin 的是 ${PINNED.version}`)
    }
    console.log(
      `[fetch-libreoffice-kit] 引擎：${engineName}@${engine.version}，${human(directorySize(engineDir))}`
    )
  }

  console.log(
    `[fetch-libreoffice-kit] 入口：${PINNED.entry}@${entry.version}，` +
      `${human(directorySize(join(OUT_DIR, 'node_modules', PINNED.entry)))}`
  )
  console.log(
    `[fetch-libreoffice-kit] 落地目录：${OUT_DIR}（合计 ${human(directorySize(OUT_DIR))}）`
  )
}

if (process.argv.includes('--verify')) {
  await verify()
  console.log('[fetch-libreoffice-kit] 校验通过')
} else {
  await install()
  await verify()
  console.log('[fetch-libreoffice-kit] 校验通过')
}
