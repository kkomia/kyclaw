/**
 * 造一个"本地静态更新源"（T17 冒烟用）：写假安装包 + 与之匹配的 latest.yml。
 *
 * electron-updater 的 generic provider 要的是 `<url>/latest.yml`（Windows 的 latest 通道），
 * yml 里给文件名、sha512、size —— 下载时会校验 sha512，所以这里必须真算。
 *
 * 用法：node scripts/make-feed.mjs <目录> <版本号> [假安装包字节数]
 * （从 T17 取证目录挪进 scripts/ 让 README 的说明可复现；不进安装包——
 *  electron-builder.yml 已排除 scripts/**；假安装包装不了，只让下载/校验这条路走通）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, version, sizeText] = process.argv.slice(2)
if (!dir || !version) {
  console.error('用法：node scripts/make-feed.mjs <目录> <版本号> [假安装包字节数]')
  process.exit(1)
}

const size = Number(sizeText ?? 64 * 1024)
const fileName = `kyclaw-${version}-setup.exe`
// 假安装包：可打印内容填充（真装不了，只是让下载/校验这条路走通）
const payload = Buffer.from(
  `kyclaw ${version} 本地模拟更新源（冒烟证据，不是真安装包）\n`.repeat(Math.ceil(size / 60)),
  'utf8'
).subarray(0, size)

const sha512 = createHash('sha512').update(payload).digest('base64')
const latestYml = `version: ${version}
files:
  - url: ${fileName}
    sha512: ${sha512}
    size: ${payload.length}
path: ${fileName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, fileName), payload)
writeFileSync(join(dir, 'latest.yml'), latestYml)
console.log(`写了 ${join(dir, 'latest.yml')}（version=${version}, size=${payload.length}）`)
