/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 获取脚本，零依赖零类型 */
/**
 * 获取本机嵌入引擎的运行时（模块 3B）：`pnpm fetch:llama`。
 *
 * llama.cpp 的 win-cpu-x64 构建**不进 git**（40MB 级二进制），这个脚本负责：
 *   1. 下载 pin 死的那个 release 压缩包（版本、文件名、体积、SHA256 全写在下面）；
 *   2. 校验压缩包 SHA256（不通过就不解压，直接失败）；
 *   3. 只解出 `llama-server.exe` 与它的必需 DLL（其余 30 多个 exe/dll 不落地），
 *      另外留下 libomp 的许可文件（我们分发它，得跟着许可）；
 *   4. 写一份 `manifest.json`（每个文件的大小与 SHA256），供打包自检与排障。
 *
 * 实测（2026-10-11，本机）：
 *   - **github.com 直连下载不通**（connect 超时），`api.github.com` 通 —— 所以镜像不是可选项，是主路；
 *     直连仍排在第一位，网络能通的地方就走官方（省一次中转）；
 *   - 镜像 `gh-proxy.com` / `ghfast.top` / `ghproxy.net` 都回 206（支持 Range）且实测能下完、哈希一致；
 *   - 21 个必需文件合计 44.2MB（裁剪掉 llama-cli / quantize / bench 等后，原压缩包 18.6MB）。
 *
 * ZIP 解压自己实现（零依赖）：Node 没有内置 zip，而项目规矩是"不加新 npm 依赖"。
 * 只支持 stored/deflate 两种压缩方法（llama.cpp 的构建产物就是这两种）。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'resources', 'llama')
const CACHE_DIR = join(OUT_DIR, '.cache')

/** pin 死的构建（换版本时：改这里 + 跑一次 `--force` + 更新 README/报告里的数字） */
const PINNED = {
  variant: 'win-cpu-x64',
  build: 'b11541',
  version: '0.6.0-dev (build 11541, commit f2918cabb)',
  asset: 'llama-b11541-bin-win-cpu-x64.zip',
  bytes: 19518702,
  sha256: 'cdc0535d11038bb337dfba3c15682050eaa9c07aedd0f915b4c09e8a8e8c0a5c',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-cpu-x64.zip',
  mirrors: [
    'https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-cpu-x64.zip',
    'https://ghfast.top/https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-cpu-x64.zip',
    'https://ghproxy.net/https://github.com/ggml-org/llama.cpp/releases/download/b11541/llama-b11541-bin-win-cpu-x64.zip'
  ]
}

/**
 * 需要的文件（其余一概不落盘）：
 *   - `llama-server.exe` 只是壳，真正的东西在 `llama-server-impl.dll`；
 *   - `mtmd.dll` 是硬依赖（少了它进程起不来，实测退出码 127）；
 *   - `ggml-cpu-*.dll` 是**按 CPU 指令集分的多份实现**（ggml 运行时挑最好的一份加载）：
 *     只留 `ggml-cpu-x64.dll` 也能跑，但实测同样一批嵌入慢 2–3 倍（5457 → 约 2000 tokens/s），
 *     所以整组都留下（约 19MB，占裁剪后体积的 43%）。
 */
const REQUIRED = [
  'llama-server.exe',
  'llama-server-impl.dll',
  'llama-common.dll',
  'llama.dll',
  'ggml.dll',
  'ggml-base.dll',
  'mtmd.dll',
  'libomp.dll'
]

const NEEDED_PREFIXES = ['ggml-cpu-']
/** 跟着走的分发许可（libomp / LLVM OpenMP 的许可文件，压缩包自带） */
const LICENSES = ['LICENSE-LLVM-OpenMP']

function fail(message) {
  console.error(`[fetch-llama] ${message}`)
  process.exit(1)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 极简 ZIP 读取（stored / deflate，够用即可；不支持 zip64） */
function readZip(buffer) {
  const EOCD = 0x06054b50
  const CENTRAL = 0x02014b50
  const LOCAL = 0x04034b50
  const scanFrom = Math.max(0, buffer.length - 66_000)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= scanFrom; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL) throw new Error('ZIP 中央目录损坏')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP 用了 zip64（本脚本不支持）：${name}`)
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return {
    entries,
    extract(name) {
      const entry = entries.find((candidate) => candidate.name === name)
      if (entry === undefined) return undefined
      if (buffer.readUInt32LE(entry.localOffset) !== LOCAL)
        throw new Error(`ZIP 条目头损坏：${name}`)
      const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
      const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
      const start = entry.localOffset + 30 + nameLength + extraLength
      const raw = buffer.subarray(start, start + entry.compressedSize)
      if (entry.method === 0) return Buffer.from(raw)
      if (entry.method === 8) return inflateRawSync(raw)
      throw new Error(`ZIP 压缩方法不认识（${entry.method}）：${name}`)
    }
  }
}

async function downloadTo(url, dest) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk))
    received += chunk.length
  }
  const body = Buffer.concat(chunks)
  await writeFile(dest, body)
  return { received, body }
}

/** 拿压缩包（缓存命中就直接用，但同样过 SHA256） */
async function fetchZip(force) {
  const cached = join(CACHE_DIR, PINNED.asset)
  if (!force && existsSync(cached)) {
    const body = await readFile(cached)
    if (sha256(body) === PINNED.sha256) {
      console.log(`[fetch-llama] 用缓存：${cached}`)
      return body
    }
    console.log('[fetch-llama] 缓存的包哈希不对，重新下载')
  }
  await mkdir(CACHE_DIR, { recursive: true })
  const candidates = [PINNED.url, ...PINNED.mirrors]
  let lastError
  for (const url of candidates) {
    const started = Date.now()
    try {
      console.log(`[fetch-llama] 下载 ${url}`)
      const { body } = await downloadTo(url, cached)
      const seconds = Math.max(0.001, (Date.now() - started) / 1000)
      const actual = sha256(body)
      if (actual !== PINNED.sha256) {
        await rm(cached, { force: true })
        throw new Error(`SHA256 不匹配（得到 ${actual}）`)
      }
      console.log(
        `[fetch-llama] 完成：${human(body.length)}，用时 ${seconds.toFixed(1)}s（${(body.length / 1024 / 1024 / seconds).toFixed(2)} MB/s），SHA256 通过`
      )
      return body
    } catch (error) {
      lastError = error
      console.warn(
        `[fetch-llama] 这个来源不行，换下一个：${error instanceof Error ? error.message : error}`
      )
    }
  }
  fail(`所有来源都失败：${lastError instanceof Error ? lastError.message : lastError}`)
}

async function install(zip) {
  const archive = readZip(zip)
  /** 条目名可能带目录前缀：一律取 basename（llama.cpp 的包是平的，稳妥起见） */
  const wanted = archive.entries
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ name: entry.name, base: entry.name.split('/').pop() ?? entry.name }))
    .filter(
      ({ base }) =>
        REQUIRED.includes(base) ||
        LICENSES.includes(base) ||
        (NEEDED_PREFIXES.some((prefix) => base.startsWith(prefix)) && base.endsWith('.dll'))
    )
  const missing = REQUIRED.filter((name) => !wanted.some(({ base }) => base === name))
  if (missing.length > 0) fail(`压缩包里缺必需文件：${missing.join('、')}`)
  if (wanted.length < REQUIRED.length) fail('压缩包里没有找到完整的引擎文件组')

  // 先清掉旧的引擎文件（保留 .cache 与 manifest），避免上一版残留混进来
  for (const name of await readdir(OUT_DIR).catch(() => [])) {
    if (name === '.cache' || name === 'manifest.json') continue
    await rm(join(OUT_DIR, name), { recursive: true, force: true })
  }

  const files = []
  let total = 0
  for (const { name, base } of wanted) {
    const body = archive.extract(name)
    if (body === undefined) continue
    await writeFile(join(OUT_DIR, base), body)
    files.push({ name: base, bytes: body.length, sha256: sha256(body) })
    total += body.length
  }

  const manifest = {
    variant: PINNED.variant,
    build: PINNED.build,
    version: PINNED.version,
    source: PINNED.url,
    asset: PINNED.asset,
    assetBytes: PINNED.bytes,
    assetSha256: PINNED.sha256,
    trimmedBytes: total,
    trimmedFiles: files.length,
    files: files.sort((left, right) => left.name.localeCompare(right.name))
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(
    `[fetch-llama] 已裁剪：${files.length} 个文件，${human(total)}（原包 ${human(PINNED.bytes)}）`
  )
  console.log(`[fetch-llama] 落地目录：${OUT_DIR}`)
}

/** 只核对已安装目录与 manifest（打包前自检 / 排障用） */
async function verify() {
  const manifestPath = join(OUT_DIR, 'manifest.json')
  if (!existsSync(manifestPath)) fail('还没有安装：先跑一次 `pnpm fetch:llama`')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  let total = 0
  for (const file of manifest.files) {
    const path = join(OUT_DIR, file.name)
    if (!existsSync(path)) fail(`缺文件：${file.name}`)
    const body = await readFile(path)
    if (body.length !== file.bytes || sha256(body) !== file.sha256)
      fail(`文件与 manifest 不一致：${file.name}`)
    total += body.length
  }
  const size = await stat(join(OUT_DIR, 'llama-server.exe'))
  console.log(
    `[fetch-llama] 校验通过：${manifest.build}（${manifest.version}），${manifest.files.length} 个文件，${human(total)}，llama-server.exe ${size.size} 字节`
  )
}

const force = process.argv.includes('--force')
if (process.argv.includes('--verify')) {
  await verify()
} else {
  const zip = await fetchZip(force)
  await install(zip)
  await verify()
}
