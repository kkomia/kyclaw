/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS postinstall 脚本，类型走 JSDoc */
/**
 * postinstall 的原生依赖重建（替代 `electron-builder install-app-deps`）。
 * 后者无条件对 node-pty 跑 node-gyp（那条路不读 electron-builder.yml 的 npmRebuild），而 node-pty 1.1.0
 * 是 N-API 且官方随包发预构建；本机缺 VS Spectre 库时，那次无谓编译会让整个 install 以 MSB8040 失败。
 *
 * 三条**都**成立才 `ignoreModules: ['node-pty']`，其余模块照旧重建：
 *   ① 当前平台/架构的官方预构建齐（清单 = 运行期真正加载的原生件；没有清单的平台一律不忽略）；
 *   ② 结构上确认 N-API（node-addon-api 依赖 + binding.gyp 引用）；
 *   ③ 用真 Electron 的 ABI 验证：**按确切路径加载预构建原生件**且走 node-pty 公共 API 真起一个 PTY，
 *      并读到**命令执行产生**的标记（命令里发的是 `%RANDOM%` / `$$` 这类占位符，回声里不含数字，
 *      所以"只回显没执行"混不过去）；同时记录 node-pty 解析顺序实际命中哪个目录
 *      —— 判定不靠 build/Release 的成功，命中非预构建目录时另起一行明说。
 * 任一条不成立 → 不忽略（正常重建；编不过就如实失败，不吞错）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 真 PTY 的执行标记前缀（命令里发的是 `KYCLAW_PTY_OK_%RANDOM%` / `_$$`，占位符本身不含数字） */
export const PTY_SMOKE_MARKER = 'KYCLAW_PTY_OK'

/** 只有**执行过**才会出现这个形态（回声里是 `%RANDOM%`/`$$`，匹配不上） */
export const PTY_SMOKE_PATTERN = 'KYCLAW_PTY_OK_\\d+'

/** 运行期真正加载的原生模块（用于"预构建件齐不齐"与"实际加载路径"两处判据） */
export const NATIVE_MODULES = {
  win32: ['pty', 'conpty', 'conpty_console_list'],
  darwin: ['pty']
}

/** 除原生件之外，运行期还要用到的随包附件 */
const RUNTIME_ASSETS = {
  win32: ['winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'],
  darwin: ['spawn-helper']
}

/** 每个平台的官方预构建清单（只有这里列出的平台才谈得上"忽略"） */
export const REQUIRED_PREBUILDS = {
  win32: [...NATIVE_MODULES.win32.map((name) => `${name}.node`), ...RUNTIME_ASSETS.win32],
  darwin: [...NATIVE_MODULES.darwin.map((name) => `${name}.node`), ...RUNTIME_ASSETS.darwin]
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 常规文件且非空（目录、空文件、坏链接都算"缺"） */
function isNonEmptyFile(path) {
  if (!existsSync(path)) return false
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * 条件①：当前平台/架构的官方预构建齐不齐。
 * @param {{ platform: string, arch: string, ptyDir: string }} input
 */
export function prebuildState({ platform, arch, ptyDir }) {
  const required = REQUIRED_PREBUILDS[platform]
  if (required === undefined) {
    return { platform, known: false, dir: null, required: [], missing: [], complete: false }
  }
  const dir = join(ptyDir, 'prebuilds', `${platform}-${arch}`)
  const missing = required.filter((name) => !isNonEmptyFile(join(dir, name)))
  return { platform, known: true, dir, required, missing, complete: missing.length === 0 }
}

/**
 * 条件②：结构上确认这个 node-pty 是 N-API。
 * @param {string} ptyDir node-pty 包目录
 */
export function napiEvidence(ptyDir) {
  const reasons = []
  try {
    const metadata = JSON.parse(readFileSync(join(ptyDir, 'package.json'), 'utf8'))
    const deps = { ...metadata.dependencies, ...metadata.optionalDependencies }
    if (typeof deps['node-addon-api'] !== 'string') {
      reasons.push('node-pty/package.json 里没有 node-addon-api 依赖')
    }
  } catch (error) {
    reasons.push(`读不到 node-pty/package.json：${messageOf(error)}`)
  }
  try {
    const binding = readFileSync(join(ptyDir, 'binding.gyp'), 'utf8')
    if (!/node-addon-api|node_addon_api/.test(binding)) {
      reasons.push('node-pty/binding.gyp 里没有 node-addon-api 的引用')
    }
  } catch (error) {
    reasons.push(`读不到 node-pty/binding.gyp：${messageOf(error)}`)
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * 条件③：真 Electron 的 ABI 下，① 按确切路径加载预构建原生件、② 走 node-pty 公共 API 起真 PTY、
 * ③ 记录解析顺序实际命中的目录。
 * @param {{ electronBinary: string, ptyDir: string, platform?: string, timeoutMs?: number }} input
 */
export function electronPtySmoke({
  electronBinary,
  ptyDir,
  platform = process.platform,
  timeoutMs = 20_000
}) {
  const isWindows = platform === 'win32'
  const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  // 命令里发的是占位符：cmd 的 %RANDOM% / sh 的 $$ 在**执行时**才变成数字，PTY 回声里只有占位符本身
  const shellArgs = isWindows
    ? ['/d', '/c', `echo ${PTY_SMOKE_MARKER}_%RANDOM%`]
    : ['-c', `echo ${PTY_SMOKE_MARKER}_$$`]
  const child = `
const path = require('node:path');
const ptyDir = ${JSON.stringify(ptyDir)};
const prebuildDir = ${JSON.stringify(join(ptyDir, 'prebuilds', `${platform}-${process.arch}`))};
const nativeModules = ${JSON.stringify(NATIVE_MODULES[platform] ?? [])};
const pattern = ${JSON.stringify(PTY_SMOKE_PATTERN)};
console.log('VER=' + process.versions.electron + ' ABI=' + process.versions.modules + ' NAPI=' + process.versions.napi);
let prebuildLoaded = nativeModules.length > 0;
if (!prebuildLoaded) console.log('PREBUILD_FAIL 没有可验证的原生模块清单');
for (const name of nativeModules) {
  try { require(path.join(prebuildDir, name + '.node')); }
  catch (error) { prebuildLoaded = false; console.log('PREBUILD_FAIL ' + name + ': ' + String((error && error.message) || error)); }
}
console.log('PREBUILD ' + (prebuildLoaded ? 'OK' : 'FAIL'));
try {
  const utils = require(path.join(ptyDir, 'lib', 'utils.js'));
  console.log('LOADER_DIRS ' + JSON.stringify(nativeModules.map(function (name) { return name + '=' + utils.loadNativeModule(name).dir; })));
} catch (error) { console.log('LOADER_DIRS_FAIL ' + String((error && error.message) || error)); }
let pty;
try { pty = require(ptyDir); } catch (error) { console.log('LOAD_FAIL ' + String((error && error.message) || error)); process.exit(2); }
if (typeof pty.spawn !== 'function') { console.log('NO_SPAWN'); process.exit(3); }
const term = pty.spawn(${JSON.stringify(shell)}, ${JSON.stringify(shellArgs)}, { cols: 80, rows: 24, env: process.env, name: 'xterm-color' });
let data = '';
let done = false;
function matched() { const found = data.match(new RegExp(pattern)); return found === null ? null : found[0]; }
function finish(why) {
  if (done) return;
  done = true;
  try { term.kill(); } catch (error) { /* 收尾失败不影响判定 */ }
  const token = matched();
  if (token !== null) console.log('MARKER ' + token);
  console.log('SMOKE ' + why + ' ' + (token !== null ? 'seen' : 'no-output'));
  console.log('DATA=' + JSON.stringify(data.slice(0, 300)));
  process.exit(token !== null && prebuildLoaded ? 0 : 4);
}
term.onData(function (chunk) { data += chunk; if (matched() !== null) finish('seen'); });
term.onExit(function () { finish('exit'); });
setTimeout(function () { finish('timeout'); }, ${Math.max(2_000, timeoutMs - 4_000)});
`
  const result = spawnSync(electronBinary, ['-e', child], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const versions = /VER=(\S+) ABI=(\S+) NAPI=(\S+)/.exec(output)
  const loaderLine = output
    .split('\n')
    .find((line) => line.startsWith('LOADER_DIRS '))
    ?.slice('LOADER_DIRS '.length)
    .trim()
  let loaderDirs = null
  if (loaderLine !== undefined) {
    try {
      const parsed = JSON.parse(loaderLine)
      loaderDirs = Array.isArray(parsed) ? parsed : null
    } catch {
      loaderDirs = null
    }
  }
  const prebuildLoaded = /PREBUILD OK/.test(output)
  // 父进程只认子进程**从 PTY 流里匹配到的 token**（`MARKER KYCLAW_PTY_OK_<数字>`）——
  // 回声里是 `%RANDOM%`/`$$`，匹配不出这个形态，所以"只回显没执行"过不了这道门
  const markerLine = output.split('\n').find((line) => line.startsWith('MARKER '))
  const marker = markerLine === undefined ? null : markerLine.slice('MARKER '.length).trim()
  const seenMarker = marker !== null && new RegExp(PTY_SMOKE_PATTERN).test(marker)
  return {
    ok: result.status === 0 && seenMarker && prebuildLoaded,
    status: result.status,
    output: output.slice(0, 800),
    electron: versions?.[1] ?? null,
    abi: versions?.[2] ?? null,
    napi: versions?.[3] ?? null,
    marker,
    prebuildLoaded,
    loaderDirs,
    usedPrebuild:
      loaderDirs === null
        ? null
        : loaderDirs.every((entry) => entry.split('=')[1]?.includes('prebuilds'))
  }
}

/**
 * 三条条件的纯判定（不碰文件系统）。
 * @param {{ prebuilds: ReturnType<typeof prebuildState>, napi: ReturnType<typeof napiEvidence>, smoke: ReturnType<typeof electronPtySmoke> }} conditions
 */
export function decideNodePtyAction({ prebuilds, napi, smoke }) {
  const reasons = []
  if (!prebuilds.known) {
    reasons.push(`当前平台（${prebuilds.platform}）没有官方预构建清单`)
  } else if (!prebuilds.complete) {
    reasons.push(`官方预构建不齐：缺 ${prebuilds.missing.join('、')}`)
  }
  if (!napi.ok) reasons.push(...napi.reasons)
  if (!smoke.ok) {
    reasons.push(
      smoke.prebuildLoaded
        ? `真 Electron PTY 冒烟没过（退出码 ${String(smoke.status)}）`
        : `预构建原生件在 Electron 下没能按确切路径加载（退出码 ${String(smoke.status)}）`
    )
  }
  return { ignore: reasons.length === 0, reasons }
}

/** 装好的 Electron 版本（读不到就明确失败：连版本都不知道就别谈重建） */
function readElectronVersion() {
  return require('electron/package.json').version
}

/** node-pty 的包目录；解析不出去就回 null（→ 不忽略，走正常重建） */
function resolveNodePtyDir() {
  try {
    return dirname(require.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

async function main() {
  const electronVersion = readElectronVersion()
  const ptyDir = resolveNodePtyDir()
  const conditions =
    ptyDir === null
      ? null
      : {
          prebuilds: prebuildState({ platform: process.platform, arch: process.arch, ptyDir }),
          napi: napiEvidence(ptyDir),
          smoke: electronPtySmoke({ electronBinary: require('electron'), ptyDir })
        }

  let decision
  if (conditions === null) {
    decision = { ignore: false, reasons: ['解析不到 node-pty 的包目录'] }
  } else {
    const { prebuilds, napi, smoke } = conditions
    decision = decideNodePtyAction(conditions)
    console.log(
      `[app-deps] node-pty 预构建：${prebuilds.known ? (prebuilds.dir ?? '') : '该平台无官方清单'}${prebuilds.complete ? '（齐）' : `（缺 ${prebuilds.missing.join('、')}）`}`
    )
    console.log(`[app-deps] N-API 证据：${napi.ok ? '通过' : napi.reasons.join('；')}`)
    console.log(
      `[app-deps] 真 Electron PTY 冒烟（Electron ${smoke.electron ?? electronVersion}，ABI ${smoke.abi ?? '?'}，NAPI ${smoke.napi ?? '?'}）：按路径加载预构建件 ${smoke.prebuildLoaded ? '成功' : '失败'}，真起 PTY ${smoke.ok ? `通过（标记 ${smoke.marker ?? '?'}）` : `未通过（退出码 ${String(smoke.status)}）`}`
    )
    if (smoke.loaderDirs !== null && smoke.usedPrebuild === false) {
      console.log(
        `[app-deps] 注意：node-pty 自己的解析顺序先命中了非预构建目录（${smoke.loaderDirs.join('，')}）；本次判定依据是预构建件本身可加载（上一行），不靠它。`
      )
    }
  }

  const options = {
    buildPath: repoRoot,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    buildFromSource: false,
    projectRootPath: repoRoot,
    mode: 'sequential',
    disablePreGypCopy: true
  }
  if (decision.ignore) {
    options.ignoreModules = ['node-pty']
    console.log('[app-deps] node-pty 交给官方 N-API 预构建（三条都成立）；其余模块照旧重建')
  } else {
    console.log(`[app-deps] 不忽略 node-pty，走正常重建。原因：${decision.reasons.join('；')}`)
  }

  const { rebuild } = await import('@electron/rebuild')
  await rebuild(options)
  console.log('[app-deps] 原生依赖重建完成')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[app-deps] 原生依赖重建失败：', error)
    process.exit(1)
  })
}
