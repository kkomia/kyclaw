/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 冒烟脚本，零依赖零类型 */
/**
 * 造一个"本地静态更新源"（T17 冒烟用；0.1.1 起可带更新日志）：写假安装包 + 与之匹配的 yml。
 *
 * electron-updater 的 generic provider 要的是 `<url>/<渠道名>.yml`（Windows），yml 里给文件名、
 * sha512、size —— 下载时会校验 sha512，所以这里必须真算。
 *
 * 用法：node scripts/make-feed.mjs <目录> <版本号> [假安装包字节数] [选项]
 *   --channel <beta|latest>   渠道文件名（默认 latest；预发布包要用 beta）
 *   --notes-file <路径>       更新日志文件：内容写进 yml 的 releaseNotes（模拟"源上带日志"）
 *   --notes <文本>            直接给一段更新日志（文本里的 `\n` 转成换行）
 *   --name <发行名>           写进 yml 的 releaseName
 *
 * 选项可以出现在位置参数之间（位置参数按出现顺序取值），既有用法一字不改。
 * （从 T17 取证目录挪进 scripts/ 让 README 的说明可复现；不进安装包——
 *  electron-builder.yml 已排除 scripts/**；假安装包装不了，只让下载/校验这条路走通）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function usage() {
  console.error(
    '用法：node scripts/make-feed.mjs <目录> <版本号> [假安装包字节数] ' +
      '[--channel beta|latest] [--notes-file <路径> | --notes <文本>] [--name <发行名>]'
  )
  process.exit(1)
}

/** 位置参数（目录/版本/字节数）与选项分开收：选项出现在位置参数之间也认 */
const positionals = []
const options = {}
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg.startsWith('--')) {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usage()
    options[arg.slice(2)] = value
    index += 1
  } else {
    positionals.push(arg)
  }
}

const [dir, version, sizeText] = positionals
if (dir === undefined || version === undefined) usage()

const channel = options.channel ?? 'latest'
if (channel !== 'beta' && channel !== 'latest') usage()

const size = Number(sizeText ?? 64 * 1024)
/** 更新日志：文件优先；没给（或给空了）= yml 里就不写 releaseNotes（界面那一块不显示） */
const rawNotes =
  options['notes-file'] === undefined
    ? options.notes?.replace(/\\n/g, '\n')
    : readFileSync(options['notes-file'], 'utf8')
const notes = (rawNotes ?? '').replace(/\r\n?/g, '\n').trim()

const fileName = `kyclaw-${version}-setup.exe`
// 假安装包：可打印内容填充（真装不了，只是让下载/校验这条路走通）
const payload = Buffer.from(
  `kyclaw ${version} 本地模拟更新源（冒烟证据，不是真安装包）\n`.repeat(Math.ceil(size / 60)),
  'utf8'
).subarray(0, size)

const sha512 = createHash('sha512').update(payload).digest('base64')

/**
 * 多行文本按 YAML 块标量（`|`）写——electron-builder 走 js-yaml 也是这个形状：
 * 逐行缩进两格即可，块标量里不用转义引号/冒号。
 */
function block(key, text) {
  const lines = text.split('\n').map((line) => (line.length === 0 ? '' : `  ${line}`))
  return `${key}: |\n${lines.join('\n')}\n`
}

const yml =
  `version: ${version}\n` +
  `files:\n  - url: ${fileName}\n    sha512: ${sha512}\n    size: ${payload.length}\n` +
  `path: ${fileName}\nsha512: ${sha512}\n` +
  (options.name === undefined ? '' : `releaseName: ${JSON.stringify(options.name)}\n`) +
  (notes.length === 0 ? '' : block('releaseNotes', notes)) +
  `releaseDate: '${new Date().toISOString()}'\n`

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, fileName), payload)
writeFileSync(join(dir, `${channel}.yml`), yml)
console.log(
  `写了 ${join(dir, `${channel}.yml`)}（version=${version}, size=${payload.length}` +
    `${notes.length === 0 ? '' : `, releaseNotes=${notes.split('\n').length} 行`}）`
)
