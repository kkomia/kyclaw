/**
 * 模型下载器（模块 3B）：断点续传 + 体积/哈希校验 + 磁盘空间检查，纯 Node（不 import electron）。
 *
 * 三条实测过的网络事实决定了这里的形状（2026-10-11 本机，见模块 3B 报告）：
 *   1. **ModelScope 直连可用**（`/api/v1/models/{repo}/repo?FilePath=...` 先 302 到 CDN，
 *      CDN 支持 `Range` → 206 + `Content-Range`，所以续传成立）；
 *   2. **huggingface.co 直连超时**（本机不可依赖）→ HF 一路把 `hf-mirror.com` 排在前面，
 *      官方源排在后面（同一份 sha256 校验，兜底失败也不会装上一个坏文件）；
 *   3. 同一模型的"首选 + 备选"两条路走同一个 `Range` 语义，所以**中途换源也能接着下**。
 *
 * 校验口径：**先看字节数、再算 SHA256**（全量流式读一遍），两者都对才改名落最终文件名；
 * 任一不过就把 `.part` 删掉重下（带着半截文件继续没有意义，且下次必然又失败）。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { LocalModelFile } from '../../shared/local-models'

/** 磁盘余量：下载目标之外还留这么多，免得把用户盘写满（缺省 64MB） */
export const DISK_MARGIN_BYTES = 64 * 1024 * 1024

/** 进度回调的最小间隔（毫秒）：写盘很快，别把 IPC 刷爆 */
const PROGRESS_INTERVAL_MS = 300

export interface DownloadProgressEvent {
  received: number
  total: number
  phase: 'downloading' | 'verifying'
}

export interface DownloadModelOptions {
  /** 目标文件（大小与哈希的唯一依据；URL 由 `urls` 给） */
  file: { bytes: number; sha256: string }
  /** 依序尝试的下载地址（首个失败换下一个；都在同一份哈希口径下） */
  urls: readonly string[]
  /** 最终落盘路径（半截文件是 `<dest>.part`） */
  dest: string
  signal?: AbortSignal
  onProgress?: (event: DownloadProgressEvent) => void
  /** 测试注入：读目录剩余空间（缺省 fs.statfs） */
  freeBytes?: (dir: string) => Promise<number>
  log?: (message: string, error?: unknown) => void
}

export interface DownloadOutcome {
  /** 真正下成功的那个地址 */
  url: string
  bytes: number
}

/** `.part` 路径（半截文件的约定；取消/失败都留在那儿等续传） */
export function partialPath(dest: string): string {
  return `${dest}.part`
}

/** 目录剩余空间（字节）。Windows 上 statfs 的 bavail/bsize 就是可用空间 */
export async function freeBytesAt(dir: string): Promise<number> {
  const info = await statfs(dir)
  return Number(info.bavail) * Number(info.bsize)
}

/** 已有文件的字节数（不存在 = 0） */
async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/** 校验一个文件：先比字节数，再全量算 SHA256。通过回 null，否则回一句人话 */
export async function verifyModelFile(
  file: string,
  expected: { bytes: number; sha256: string }
): Promise<string | null> {
  const actualBytes = await sizeOf(file)
  if (actualBytes === 0) return '文件不存在或为空'
  if (actualBytes !== expected.bytes) {
    return `文件大小不对（得到 ${actualBytes} 字节，应为 ${expected.bytes} 字节）`
  }
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve())
  })
  const actual = hash.digest('hex')
  if (actual !== expected.sha256) return '文件校验不过（内容与清单不一致）'
  return null
}

/**
 * 下载一个文件到 `dest`（断点续传 + 校验）。**会抛**：拿不到一份校验通过的文件就抛人话错误。
 * 取消（signal）不算失败：`.part` 留着，下次从这里接着下。
 */
export async function downloadModelFile(options: DownloadModelOptions): Promise<DownloadOutcome> {
  const log = options.log ?? ((): void => undefined)
  const part = partialPath(options.dest)
  const readFree = options.freeBytes ?? freeBytesAt

  await mkdir(dirname(options.dest), { recursive: true })

  // 空间检查：按"还差多少"算，别把已经在盘上的半截当又要一份
  const already = await sizeOf(part)
  const needed = Math.max(0, options.file.bytes - already)
  const free = await readFree(dirname(options.dest))
  if (free < needed + DISK_MARGIN_BYTES) {
    throw new Error(
      `磁盘空间不够：还需要约 ${Math.ceil((needed + DISK_MARGIN_BYTES) / 1024 / 1024)} MB，` +
        `当前可用 ${Math.floor(free / 1024 / 1024)} MB`
    )
  }

  let lastError: unknown
  for (const url of options.urls) {
    try {
      await downloadFrom(url, part, options)
      const problem = await verifyModelFile(part, options.file)
      if (problem !== null) {
        // 半截/坏文件留着只会让下次继续失败：删掉重来
        await rm(part, { force: true })
        throw new Error(`${problem}（已丢弃这次下载的部分文件）`)
      }
      await rm(options.dest, { force: true })
      await rename(part, options.dest)
      return { url, bytes: options.file.bytes }
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      lastError = error
      log(`[kyclaw] 下载源失败，换下一个：${url}`, error)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? '没有可用的下载地址'))
}

/** 单源下载（从 `<dest>.part` 的当前位置续传） */
async function downloadFrom(
  url: string,
  part: string,
  options: DownloadModelOptions
): Promise<void> {
  const expected = options.file
  let start = await sizeOf(part)
  // 比清单还长的半截文件是坏账（换过源/中途被改过）：从头来
  if (start > expected.bytes) {
    await rm(part, { force: true })
    start = 0
  }
  const onProgress = options.onProgress ?? ((): void => undefined)
  if (start === expected.bytes) {
    onProgress({ received: start, total: expected.bytes, phase: 'verifying' })
    return
  }

  const response = await fetch(url, {
    headers: start > 0 ? { range: `bytes=${start}-` } : {},
    redirect: 'follow',
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`下载地址返回 ${response.status} ${response.statusText}`)
  }
  if (start > 0 && response.status !== 206) {
    // 服务端不支持 Range：这份连接是从头给的，得把半截丢掉（否则会拼出一份错文件）
    await rm(part, { force: true })
    start = 0
  }
  if (response.body === null) throw new Error('下载地址没有返回内容')

  const handle = await open(part, start > 0 ? 'r+' : 'w')
  let received = start
  let lastReport = 0
  try {
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      await handle.write(buffer, 0, buffer.length, received)
      received += buffer.length
      const now = Date.now()
      if (now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now
        onProgress({ received, total: expected.bytes, phase: 'downloading' })
      }
    }
  } finally {
    await handle.close()
  }
  onProgress({ received, total: expected.bytes, phase: 'verifying' })
  if (received !== expected.bytes) {
    throw new Error(`下载不完整（得到 ${received} 字节，应为 ${expected.bytes} 字节）`)
  }
}

/** 一个已下载模型在磁盘上的占用（找不到 = null） */
export async function fileSizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size
  } catch {
    return null
  }
}

/** 删除一个已下载的模型（连同它的侧车记录与半截文件）；不存在是空操作 */
export async function removeModelFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { force: true })
    await rm(partialPath(path), { force: true })
  }
}

/** 侧车记录文件名（`<id>.json` 与 `<id>.gguf` 同目录同名不同后缀） */
export function sidecarPathFor(modelsDir: string, id: string): string {
  return join(modelsDir, `${id}.json`)
}

/** 推荐档的 GGUF 落盘路径 */
export function modelPathFor(modelsDir: string, id: string): string {
  return join(modelsDir, `${id}.gguf`)
}

/** 判断一个路径像不像 GGUF（按扩展名；真伪由 gguf.ts 读头把门） */
export function looksLikeGguf(path: string): boolean {
  return /\.gguf$/i.test(path)
}

export type { LocalModelFile }
