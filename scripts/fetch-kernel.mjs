/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 出包前置脚本，零依赖零类型 */
/**
 * B4 / PB-006：把冻结的 rc.2 内核快照解到 `resources/kernel/rc.2/`（随包输入，**不入 git**）。
 *
 * 为什么要有这个脚本：快照 130+ MiB / 12,249 文件，不可能进公开仓库；但出包必须能**可复跑**地
 * 拿到同一份东西。源头是冻结的完整取证件 `kernel-snapshot-rc2-complete-sharp.tar.gz`（35.3 MiB），
 * 它的 SHA256 就是验收⑤的取证值：`16EEF017…C2F47B`。脚本：
 *   1. 校验 tar.gz 的字节数与 SHA256（钉死在下面 PINNED；不匹配不接包）；
 *   2. 用系统 tar（Windows 10+ 自带 bsdtar）解到临时目录，校验通过后才替换 `rc.2/`；
 *   3. 按快照自带的 `SNAPSHOT.json` / `SHA256SUMS.txt` 全量核对（524 包 / 12,244 文件 / 12,249 文件）；
 *   4. 写 `resources/kernel/current.json`（版本 + SHA256 + 文件数；主进程按它找版本目录）。
 *
 * 勘误（PB-005 实测）：Ada 初版 `kernel-snapshot-rc2.tar.gz`（SHA256 `BD1CB907…E7B241`）只从
 * DSH 的 `app.asar` 提取，漏了 electron-builder 的 `app.asar.unpacked` 区 —— `koffi/src/koffi`
 * 等 306 个保留包文件只在 unpacked 区，导致真实轮次 `Cannot find module …/koffi/src/koffi/index.js`。
 * 完整快照 = 初版 + unpacked 区 overlay（仅补"包根仍在快照里"的文件；被裁掉的 LibreOffice/sherpa
 * 等 750+ 个文件仍不进包）。来源与差异清单见 `resources/kernel/README.md`。
 *
 * PB-040 勘误（read_image 实测）：上一版完整快照仍把 `@img/sharp-win32-x64` 裁掉，导致内核
 * `read_image` 报 `Could not load the "sharp" module`。本版把它（`sharp.node` + libvips dll +
 * package.json/index.cjs，8 文件 / ~19.85 MB）补进 overlay；它必须随快照走，不能按"平台相关可裁"处理。
 *
 * 用法：
 *   pnpm fetch:kernel                 # 首次解出，或已存在则只校验
 *   pnpm fetch:kernel -- --force      # 重新解（覆盖 rc.2/）
 *   pnpm fetch:kernel -- --verify     # 只校验现有 rc.2/ 与 current.json，不解压
 *   KYCLAW_KERNEL_TARBALL=D:\xxx\kernel-snapshot-rc2-complete.tar.gz pnpm fetch:kernel
 *
 * 退出码 0 = 可出包；非 0 = 缺件/校验失败（错误信息直接给出下一步）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KERNEL_DIR = join(ROOT, 'resources', 'kernel')
const TARGET_DIR = join(KERNEL_DIR, 'rc.2')
const CURRENT_JSON = join(KERNEL_DIR, 'current.json')
const EXTRACT_TMP = join(KERNEL_DIR, '.extract-tmp')
/**
 * 冻结的取证件（本地，不进 git）：调研员 Ada 从 DSH 桌面 asar 裁出的 rc.2 快照。
 * 换内核 = 换 tar.gz + 改这里三处（版本/字节数/SHA256/文件数）。
 */
const DEFAULT_TARBALL = join(
  ROOT,
  '.superpowers',
  'dev-verify',
  '20261019-0.2.0',
  'kai',
  'kernel-sharp-repack',
  'kernel-snapshot-rc2-complete-sharp.tar.gz'
)

const PINNED = {
  version: 'rc.2',
  tarballName: 'kernel-snapshot-rc2-complete-sharp.tar.gz',
  bytes: 36994698,
  /**
   * 完整快照取证值（大写；比较时大小写无关）。
   * 溯源：Ada 初版 `kernel-snapshot-rc2.tar.gz`（SHA256 BD1CB907…E7B241）只从 `app.asar` 提取，
   * 漏了 electron-builder 的 `app.asar.unpacked` 区 → koffi/src/koffi 等 306 个保留包文件缺失
   * （PB-005 真实轮次报 Cannot find module …/koffi/src/koffi/index.js）。本值 = 再补
   * `@img/sharp-win32-x64`（PB-040：read_image 必需，8 文件）后重新冻结的完整快照；
   * 差异清单见 resources/kernel/README.md 与 .superpowers/dev-verify/20261019-0.2.0/kai/。
   */
  sha256: '16eef01776f022a078326972d80ff35e9ae83fba47a27cae7613125107c2f47b',
  /** tar.gz 内的文件总数（含 SNAPSHOT.json / SHA256SUMS.txt / package.json 等根文件） */
  files: 12249,
  /** node_modules 内文件数（= SNAPSHOT.json.files = SHA256SUMS.txt 行数） */
  nodeModulesFiles: 12244,
  /** app.asar.unpacked 覆盖区补进来的文件数（见 SNAPSHOT.json.overlay；含 sharp 8 个） */
  overlayFiles: 314,
  packages: 524
}

function fail(message) {
  console.error(`[fetch-kernel] ${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[fetch-kernel] ${message}`)
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 递归列出目录下所有文件（相对 root 的 posix 路径） */
function listFiles(root, prefix = '') {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFiles(join(root, entry.name), relative))
    else files.push(relative)
  }
  return files
}

/**
 * 校验一棵内核树。返回 { problems, summary }：problems 非空即不可出包。
 * 全量 SHA256 只在"解压/显式 --verify"时跑（运行期不做，见研究 §2）。
 */
function verifyTree(dir) {
  const problems = []
  const snapshotFile = join(dir, 'SNAPSHOT.json')
  const sumsFile = join(dir, 'SHA256SUMS.txt')

  let snapshot = null
  if (!existsSync(snapshotFile)) {
    problems.push(`缺 SNAPSHOT.json：${snapshotFile}`)
  } else {
    try {
      snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'))
    } catch (error) {
      problems.push(
        `SNAPSHOT.json 解析失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (snapshot !== null) {
    if (snapshot.packagesKept !== PINNED.packages) {
      problems.push(
        `SNAPSHOT.json.packagesKept=${String(snapshot.packagesKept)}，应为 ${PINNED.packages}`
      )
    }
    if (snapshot.files !== PINNED.nodeModulesFiles) {
      problems.push(
        `SNAPSHOT.json.files=${String(snapshot.files)}，应为 ${PINNED.nodeModulesFiles}`
      )
    }
    if (snapshot.overlay?.files !== PINNED.overlayFiles) {
      problems.push(
        `SNAPSHOT.json.overlay.files=${String(snapshot.overlay?.files)}，应为 ${String(PINNED.overlayFiles)}（app.asar.unpacked 覆盖区缺失？）`
      )
    }
  }

  const nodeModulesDir = join(dir, 'node_modules')
  const entryFile = join(nodeModulesDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entryFile)) problems.push(`缺内核入口：${entryFile}`)

  const nodeModulesFiles = existsSync(nodeModulesDir) ? listFiles(nodeModulesDir).length : 0
  if (nodeModulesFiles !== PINNED.nodeModulesFiles) {
    problems.push(
      `node_modules 文件数=${String(nodeModulesFiles)}，应为 ${PINNED.nodeModulesFiles}（快照不完整或被改动）`
    )
  }
  const totalFiles = listFiles(dir).length
  if (totalFiles !== PINNED.files) {
    problems.push(`文件总数=${String(totalFiles)}，应为 ${PINNED.files}`)
  }

  // 逐文件 SHA256（SNAPSHOT.json / SHA256SUMS.txt 里的 11,930 条）
  let sumLines = 0
  let sumOk = 0
  const sumErrors = []
  if (!existsSync(sumsFile)) {
    problems.push(`缺 SHA256SUMS.txt：${sumsFile}`)
  } else {
    const lines = readFileSync(sumsFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    sumLines = lines.length
    if (sumLines !== PINNED.nodeModulesFiles) {
      problems.push(`SHA256SUMS.txt 行数=${String(sumLines)}，应为 ${PINNED.nodeModulesFiles}`)
    }
    for (const line of lines) {
      const match = /^([0-9a-fA-F]{64})\s+(.+)$/u.exec(line)
      if (match === null) {
        sumErrors.push(`认不出的行：${line.slice(0, 80)}`)
        continue
      }
      const [, expected = '', relative = ''] = match
      const file = join(dir, ...relative.split('/'))
      if (!existsSync(file)) {
        sumErrors.push(`文件缺失：${relative}`)
        continue
      }
      const actual = sha256File(file)
      if (actual.toLowerCase() === expected.toLowerCase()) sumOk += 1
      else sumErrors.push(`SHA256 不符：${relative}（期望 ${expected}，实际 ${actual}）`)
    }
    for (const error of sumErrors.slice(0, 5)) problems.push(error)
    if (sumErrors.length > 5) problems.push(`…另有 ${String(sumErrors.length - 5)} 条校验错误`)
  }

  return {
    problems,
    summary: {
      packages: snapshot === null ? null : snapshot.packagesKept,
      nodeModulesFiles,
      totalFiles,
      sumLines,
      sumOk,
      entryFile
    }
  }
}

/** 解压时用的临时目录：宁可失败也不动已存在的 rc.2（先解、后验、再换） */
function extractTarball(tarball) {
  rmSync(EXTRACT_TMP, { recursive: true, force: true })
  mkdirSync(EXTRACT_TMP, { recursive: true })
  const result = spawnSync('tar', ['-xzf', tarball, '-C', EXTRACT_TMP], {
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) {
    rmSync(EXTRACT_TMP, { recursive: true, force: true })
    fail(
      `解压失败：起不来系统 tar（${result.error.message}）。\n` +
        '  Windows 10+ 自带 bsdtar；也可先手工解压后把目录放到 resources/kernel/rc.2/，再用 --verify 校验'
    )
  }
  if (result.status !== 0) {
    rmSync(EXTRACT_TMP, { recursive: true, force: true })
    fail(`解压失败：tar 退出码 ${String(result.status)}（tar.gz 损坏？）`)
  }
  return EXTRACT_TMP
}

function parseArgs(argv) {
  const args = { verify: false, force: false, from: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--verify') args.verify = true
    else if (arg === '--force') args.force = true
    else if (arg === '--')
      continue // `pnpm fetch:kernel -- --force` 会把分隔符原样传进来
    else if (arg === '--from') {
      index += 1
      if (argv[index] === undefined) fail('--from 后面要跟 tar.gz 路径')
      args.from = argv[index]
    } else if (arg === '--help' || arg === '-h') {
      log('用法：pnpm fetch:kernel [--verify] [--force] [--from <kernel-snapshot-rc2.tar.gz>]')
      process.exit(0)
    } else fail(`认不出的参数：${arg}`)
  }
  return args
}

/** 现有 rc.2 是否可接受（--verify 与"已存在只校验"共用） */
function verifyExisting(requireCurrent = true) {
  if (!existsSync(TARGET_DIR)) {
    fail(
      `内核快照还没解出来：${TARGET_DIR}\n` + `  先跑 pnpm fetch:kernel（源头：${DEFAULT_TARBALL}）`
    )
  }
  const { problems, summary } = verifyTree(TARGET_DIR)
  if (problems.length > 0) {
    fail(`内核快照校验失败（${String(problems.length)} 项）：\n  - ${problems.join('\n  - ')}`)
  }
  if (requireCurrent) {
    if (!existsSync(CURRENT_JSON)) {
      fail(`缺版本指针：${CURRENT_JSON}（重新跑 pnpm fetch:kernel 会重写）`)
    }
    let current
    try {
      current = JSON.parse(readFileSync(CURRENT_JSON, 'utf8'))
    } catch (error) {
      fail(`current.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (current.version !== PINNED.version || current.path !== PINNED.version) {
      fail(
        `current.json 指向 ${String(current.version)}/${String(current.path)}，与钉死的 ${PINNED.version} 不一致`
      )
    }
    if (String(current.sha256).toLowerCase() !== PINNED.sha256) {
      fail(
        `current.json.sha256=${String(current.sha256)}，与取证值 ${PINNED.sha256.toUpperCase()} 不一致`
      )
    }
  }
  log(
    `校验通过：${PINNED.packages} 包 / node_modules ${String(summary.nodeModulesFiles)} 文件 / ` +
      `总计 ${String(summary.totalFiles)} 文件 / SHA256SUMS ${String(summary.sumOk)}-${String(summary.sumLines)} OK`
  )
}

function writeCurrentJson() {
  const record = {
    version: PINNED.version,
    path: PINNED.version,
    sha256: PINNED.sha256.toUpperCase(),
    tarball: {
      file: PINNED.tarballName,
      bytes: PINNED.bytes,
      sha256: PINNED.sha256.toUpperCase()
    },
    packages: PINNED.packages,
    files: PINNED.files,
    nodeModulesFiles: PINNED.nodeModulesFiles,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(CURRENT_JSON, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  log(`写版本指针：${CURRENT_JSON}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.verify) {
    verifyExisting(true)
    return
  }

  const tarball = args.from ?? process.env.KYCLAW_KERNEL_TARBALL ?? DEFAULT_TARBALL
  if (!existsSync(tarball)) {
    fail(
      `找不到内核快照 tar.gz：${tarball}\n` +
        `  用环境变量 KYCLAW_KERNEL_TARBALL=<绝对路径> 或 --from <路径> 指向冻结的 ${PINNED.tarballName}\n` +
        `  （27.0 MiB，SHA256 应为 ${PINNED.sha256.toUpperCase()}；取证件默认在 ${DEFAULT_TARBALL}）`
    )
  }
  const bytes = statSync(tarball).size
  if (bytes !== PINNED.bytes) {
    fail(
      `tar.gz 字节数=${String(bytes)}，与钉死的 ${String(PINNED.bytes)} 不一致（不是同一份取证件？）`
    )
  }
  const actualSha = sha256File(tarball)
  if (actualSha.toLowerCase() !== PINNED.sha256) {
    fail(
      `tar.gz SHA256 与取证值不一致！\n  期望：${PINNED.sha256.toUpperCase()}\n  实际：${actualSha.toUpperCase()}`
    )
  }
  log(`tar.gz SHA256 与取证值一致：${actualSha.toUpperCase()}`)

  if (existsSync(TARGET_DIR) && !args.force) {
    log(`已存在 ${TARGET_DIR}：只校验，不重复解压（要重解加 --force）`)
    verifyExisting(false)
    writeCurrentJson()
    return
  }

  log(`解压 ${tarball} → ${TARGET_DIR}`)
  const extracted = extractTarball(tarball)
  const { problems, summary } = verifyTree(extracted)
  if (problems.length > 0) {
    rmSync(extracted, { recursive: true, force: true })
    fail(`解出来的快照校验失败（${String(problems.length)} 项）：\n  - ${problems.join('\n  - ')}`)
  }
  log(
    `解压后校验通过：${String(summary.packages)} 包 / node_modules ${String(summary.nodeModulesFiles)} 文件 / ` +
      `总计 ${String(summary.totalFiles)} 文件 / SHA256SUMS ${String(summary.sumOk)}-${String(summary.sumLines)} OK`
  )

  rmSync(TARGET_DIR, { recursive: true, force: true })
  renameSync(extracted, TARGET_DIR)
  writeCurrentJson()
  verifyExisting(true)
  log(`完成：${TARGET_DIR}`)
}

// 直接执行才跑；被 import() 时只拿函数（暂无外部消费者，保留与 package.mjs 同口径）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
