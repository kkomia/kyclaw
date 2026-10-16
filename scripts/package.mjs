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
 * 0.1.1 起还管**发行日志**：`build/release-notes/<版本>.md` 随包进渠道 yml 的 releaseNotes
 * （更新界面「关于」栏显示的那段更新内容）。两头自检：出包前文件必须在、且写着本版本的号
 * （换版本号就得另写一份）；出包后渠道 yml 的 releaseNotes 字段必须就是这份原文。
 *
 * 本轮再加一道**随包自检**：同一份 md 由 electron-builder.yml 的 extraResources 拷进安装目录的
 * `resources/release-notes/`（客户端「关于 → 更新日志」在断网 / 已是最新时读它），出包后要比对
 * 解包目录里那一份与 build/ 下的原文逐字一致（漏拷 / 拷了旧文件都当场停，见 bundledNotesProblem）。
 * 传法是 electron-builder 的标准配置 `-c.releaseInfo.releaseNotesFile=<build/ 下的相对路径>`
 * （它自己写进 yml 的 releaseNotes + releaseName + releaseDate，见 app-builder-lib 的
 * publish/updateInfoBuilder.js）。
 *
 * 环境照传：pnpm 会把 .npmrc 的镜像写成 npm_config_electron_mirror /
 * npm_config_electron_builder_binaries_mirror，Electron 与 NSIS 的下载靠它走 npmmirror。
 *
 * 纯函数（expectedInstallerName / staleOutputs / cleanStaleOutputs / projectManifest /
 * releaseNotesPath / releaseNotesRelativePath / releaseNotesProblem / channelReleaseProblem /
 * bundledNotesProblem）导出供最小验证：直接执行才跑打包流程，被 `import()` 时只拿函数
 * （见终审 fix wave 报告的验证记录；发行日志那几条同时被 src/main/__tests__/release-notes-scripts.spec.ts 钉住）。
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
/**
 * 发行日志的目录（相对 build/，即 electron-builder 的 buildResources）：**文件名就是版本号**
 * （`build/release-notes/0.1.1.md`）—— 版本与日志绑死，换了版本号就必须另写一份，不会把上一版的
 * 日志复用成这一版的发行说明。
 */
const RELEASE_NOTES_DIR = 'release-notes'

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

/**
 * 本版本发行日志的相对路径（**相对 build/**，也就是 electron-builder 的 buildResources 目录）。
 * 传给 electron-builder 的就是这个串：它按 buildResources → 项目根依次找，`release-notes/0.1.1.md`
 * 落在前者下面。
 */
export function releaseNotesRelativePath(version) {
  return `${RELEASE_NOTES_DIR}/${version}.md`
}

/** 本版本发行日志的绝对路径（不判存在：调用方要能拿它给出"该写哪个文件"） */
export function releaseNotesPath(version, root = ROOT) {
  return join(root, 'build', RELEASE_NOTES_DIR, `${version}.md`)
}

/**
 * 发行日志的内容自检：空文件、或者**没提到本版本号**的（十有八九是复制上一版忘了改）都拦下。
 * 版本与日志绑死是这个功能的全部意义——错了会直接显示给用户看。
 */
export function releaseNotesProblem(version, text) {
  const notes = String(text ?? '').trim()
  if (notes.length === 0) return `本版本的发行日志是空的：${releaseNotesRelativePath(version)}`
  if (!notes.includes(version)) {
    return (
      `本版本的发行日志里没提到版本号 ${version}（版本与日志要绑死，别复用上一版的文件）：` +
      `${releaseNotesRelativePath(version)}`
    )
  }
  return null
}

/** 换行归一（CRLF→LF）并去掉尾随换行：块标量的 clip/keep 只管这几个换行，不算内容差异 */
function sameNotesText(a, b) {
  const normalize = (value) =>
    String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '')
  return normalize(a) === normalize(b)
}

/** 一段原文（错误文案里带出来，好认实际写进去的是什么） */
function excerpt(value, limit = 60) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** 单行标量：双引号（YAML 转义与 JSON 兼容）、单引号（'' 转义）、裸值 */
function scalarField(head) {
  const text = head.trim()
  if (text.length === 0 || text === '~' || text === 'null' || text.startsWith('#')) {
    return { kind: 'value', value: null }
  }
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return { kind: 'unsupported', detail: '跨行双引号' }
    try {
      return { kind: 'value', value: JSON.parse(text) }
    } catch {
      return { kind: 'unsupported', detail: '双引号里的转义认不出来' }
    }
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) return { kind: 'unsupported', detail: '跨行单引号' }
    return { kind: 'value', value: text.slice(1, -1).replace(/''/g, "'") }
  }
  return { kind: 'value', value: text }
}

/**
 * 块标量（`|`）的正文：缩进按第一行非空内容定（显式缩进指示优先），空行不参与判缩进；
 * chomping 决定尾随换行——`-` 不留、默认（clip）留一个、`+` 全留。
 */
function blockField(lines, at, chomp, explicitIndent) {
  let indent = explicitIndent === '' ? -1 : Number(explicitIndent)
  const body = []
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) {
      body.push('')
      continue
    }
    const leading = line.length - line.trimStart().length
    if (indent === -1) {
      if (leading === 0) break
      indent = leading
    }
    if (leading < indent) break
    body.push(line.slice(indent))
  }
  let trailing = 0
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop()
    trailing += 1
  }
  if (body.length === 0) return { kind: 'value', value: '' }
  const kept = chomp === '+' ? body.concat(Array(trailing).fill('')) : body
  const text = kept.join('\n')
  return { kind: 'value', value: chomp === '-' ? text : `${text}\n` }
}

/**
 * 渠道 yml 里 releaseNotes 的**实际字段值**（顶层键、列 0；同名键按 YAML 的"后者为准"）。
 * 只认 electron-builder 走的那套写法（js-yaml 的块标量 `|` 与单行标量），其余样式明确报"认不出来"
 * —— 比"在整份文件里搜这几行"可靠：能看出顺序，也不会被别的字段碰巧包含同一段文字骗过。
 */
function releaseNotesField(channelYml) {
  const lines = String(channelYml ?? '').split('\n')
  let at = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^releaseNotes:/.test(lines[index])) at = index
  }
  if (at === -1) return { kind: 'missing' }
  const head = lines[at].slice('releaseNotes:'.length)
  const indicator = /^\s*([|>])([0-9+-]*)\s*$/.exec(head)
  if (indicator === null) return scalarField(head)
  if (indicator[1] === '>') return { kind: 'unsupported', detail: '折叠块（>）' }
  const marks = indicator[2]
  const chomp = marks.includes('+') ? '+' : marks.includes('-') ? '-' : ''
  const digits = /\d/.exec(marks)
  return blockField(lines, at, chomp, digits === null ? '' : digits[0])
}

/**
 * 打包自检：渠道 yml（dist/latest.yml 或 beta.yml）里 releaseNotes 字段真的就是本版本日志的原文，
 * releaseDate 也由 electron-builder 自己补上了。返回一句人话或 null（没问题）。
 */
export function channelReleaseProblem(channelYml, notes) {
  const text = String(channelYml ?? '')
  const field = releaseNotesField(text)
  if (field.kind === 'missing') {
    return '渠道 yml 里没有 releaseNotes 字段（出包时 -c.releaseInfo.releaseNotesFile 没传进去？）'
  }
  if (field.kind === 'unsupported') {
    return `渠道 yml 里 releaseNotes 的写法认不出来（${field.detail}）——这段要按原文进 releaseNotes`
  }
  if (!/^releaseDate:\s*\S/m.test(text)) {
    return '渠道 yml 里没有 releaseDate（electron-builder 本该自己补上，配置被改坏了？）'
  }
  if (!sameNotesText(field.value, notes)) {
    return `渠道 yml 里的发行日志与本版本的文件不一致（yml 里实际写进去的是「${excerpt(field.value)}」）`
  }
  return null
}

/**
 * 打包自检（本轮）：本版本发行说明**真的随包**了 —— 解包目录里
 * `resources/release-notes/<版本>.md` 在，且与 `build/release-notes/<版本>.md` 逐字一致。
 *
 * 为什么单独一道：渠道 yml 的 releaseNotes 只管"源上给别人的日志"，客户端的常驻「更新日志」
 * 入口（断网 / 已是最新时唯一能看的东西）读的是**随包这一份**。extraResources 漏拷时渠道自检
 * 照样全绿，界面却只能说"本版暂无发行说明"——那正是这条闸门要挡的。
 * 与渠道自检同一口径：比的就是本版本那一个文件名（别的版本的文件不算数），换行归一后逐字比。
 */
export function bundledNotesProblem(unpackedResourcesDir, version, notes) {
  const file = join(unpackedResourcesDir, RELEASE_NOTES_DIR, `${version}.md`)
  if (!existsSync(file)) {
    return (
      `解包目录里没有本版本发行说明：${file}\n` +
      '  （electron-builder.yml 的 extraResources 是不是漏了 build/release-notes → release-notes？）'
    )
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return `读不到解包后的本版本发行说明：${error instanceof Error ? error.message : String(error)}`
  }
  if (!sameNotesText(text, notes)) {
    return `解包后的发行说明与 build/${RELEASE_NOTES_DIR}/${version}.md 不一致：${file}`
  }
  return null
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

    // 发行日志（0.1.1）：先确认**本版本**的那份在、且写的就是本版本 —— 缺件在这里就停，
    // 而且排在"预清上一次的打包输出"之前：缺日志不该先把上一版的产物删掉。
    const manifest = projectManifest()
    const notesFile = releaseNotesPath(manifest.version)
    if (!existsSync(notesFile)) {
      fail(
        `缺本版本的发行日志：${notesFile}\n` +
          `  先写 build/${releaseNotesRelativePath(manifest.version)}（它的内容会进渠道 yml 的 ` +
          'releaseNotes，就是更新界面「关于」栏显示的那段更新内容）再出包'
      )
    }
    const releaseNotes = readFileSync(notesFile, 'utf8')
    const notesProblem = releaseNotesProblem(manifest.version, releaseNotes)
    if (notesProblem !== null) fail(notesProblem)

    const cleared = cleanStaleOutputs()
    if (cleared.length > 0) {
      console.log(`[package] 预清上一次的打包输出：${cleared.join('、')}`)
    }

    run('electron-vite', ['build'])
    run('electron-builder', [
      '--win',
      '--publish',
      'never',
      // electron-builder 的标准支持：把这份 md 读进 latest.yml/beta.yml 的 releaseNotes
      // （releaseDate 它自己补、releaseName 有就给；见 app-builder-lib/publish/updateInfoBuilder.js）。
      // 路径相对 buildResources（build/）——换版本号就换文件名，不会复用上一版的日志。
      `-c.releaseInfo.releaseNotesFile=${releaseNotesRelativePath(manifest.version)}`
    ])

    const expected = expectedInstallerName(manifest)
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
    // 随包的第三方许可声明（`resources/skills/THIRD_PARTY_NOTICES.md`）：技能目录走 extraResources，
    // 那份声明是**内联进产物那些包的许可文本唯一承载**（见该文件第 5 节）——漏拷就是合规缺口。
    if (
      !existsSync(join(DIST_DIR, 'win-unpacked', 'resources', 'skills', 'THIRD_PARTY_NOTICES.md'))
    ) {
      fail(
        'resources/skills/THIRD_PARTY_NOTICES.md 没有进包（extraResources 的 skills 那条被改坏了？）'
      )
    }
    // round 62：更新通道的随包产物——generic 源（局域网 MinIO）靠它工作，缺了测试机就不会检查更新。
    // 通道文件名跟着版本走：预发布（0.1.0-beta.N）是 beta.yml，正式版才是 latest.yml
    // （electron-builder 的 channel 语义，与包内 app-update.yml 的 `channel: beta` 配对）。
    const channelFile = String(manifest.version).includes('-') ? 'beta.yml' : 'latest.yml'
    if (!existsSync(join(DIST_DIR, channelFile))) {
      fail(`dist/ 下没有 ${channelFile}（electron-builder.yml 的 publish 配置被改坏了？）`)
    }
    // 发行日志的落点自检（0.1.1）：渠道 yml 是客户端唯一读的东西——日志没进去，界面就不会有
    // 更新内容。这里是"出包成功但用户看不到日志"的那道闸。
    const channelProblem = channelReleaseProblem(
      readFileSync(join(DIST_DIR, channelFile), 'utf8'),
      releaseNotes
    )
    if (channelProblem !== null) fail(`${channelFile}：${channelProblem}`)
    if (!existsSync(join(DIST_DIR, 'win-unpacked', 'resources', 'app-update.yml'))) {
      fail('resources/app-update.yml 没有进包（publish 配置被改坏了？测试机不会检查更新）')
    }
    // 本版本发行说明随包（本轮）：渠道 yml 那份是给"源上的别人"看的，客户端「关于 → 更新日志」
    // 读的是解包目录里这一份（断网 / 已是最新时唯一能看的东西）——漏拷了界面只能装没有
    const bundledProblem = bundledNotesProblem(
      join(DIST_DIR, 'win-unpacked', 'resources'),
      manifest.version,
      releaseNotes
    )
    if (bundledProblem !== null) fail(bundledProblem)

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
    console.log(
      `[package] 本版本发行日志：build/${releaseNotesRelativePath(manifest.version)}（` +
        `${releaseNotes.trim().split('\n').length} 行 → ${channelFile} 的 releaseNotes，已核对）`
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// 直接执行（node scripts/package.mjs）才跑打包；被 import() 时只取纯函数（最小验证用）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
