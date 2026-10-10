/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 出包脚本，零依赖零类型 */
/**
 * 出包入口（T15）：`pnpm package` = electron-vite build + electron-builder（Windows NSIS 用户级安装）。
 *
 * 为什么单起一个脚本而不是一行 npm script：
 *   1. `--publish never` 要写死——本次不接更新通道（T17），而 electron-builder 在 CI 环境里
 *      默认会试着发布；
 *   2. 出包后自检两个"构建成功但装完会发现"的坑：安装包在不在、asarUnpack 有没有真的把
 *      libsql 的原生绑定（@libsql/win32-x64-msvc/index.node）与 ?asset 资源解到 app.asar.unpacked。
 *
 * 环境照传：pnpm 会把 .npmrc 的镜像写成 npm_config_electron_mirror /
 * npm_config_electron_builder_binaries_mirror，Electron 与 NSIS 的下载靠它走 npmmirror。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT, 'dist')
const UNPACKED_DIR = join(DIST_DIR, 'win-unpacked', 'resources', 'app.asar.unpacked')

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

run('electron-vite', ['build'])
run('electron-builder', ['--win', '--publish', 'never'])

const installers = existsSync(DIST_DIR)
  ? readdirSync(DIST_DIR).filter((name) => name.endsWith('-setup.exe'))
  : []
if (installers.length === 0) fail('dist/ 下没有 NSIS 安装包（*-setup.exe）')

if (!existsSync(UNPACKED_DIR)) fail(`没有解包目录：${UNPACKED_DIR}（asarUnpack 没生效）`)
const unpacked = listFiles(UNPACKED_DIR)
const libsqlBindings = unpacked.filter((path) => path.endsWith('.node') && path.includes('@libsql'))
if (libsqlBindings.length === 0) {
  fail('app.asar.unpacked 里没有 @libsql 的 .node——装了也起不了库（asarUnpack 规则被改坏了？）')
}

console.log('[package] 产物：')
for (const name of installers) {
  console.log(
    `  dist/${name}  ${(statSync(join(DIST_DIR, name)).size / 1024 / 1024).toFixed(1)} MB`
  )
}
console.log(`[package] 解包的原生绑定：${libsqlBindings.join('、')}`)
