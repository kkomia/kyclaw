// @vitest-environment node
/**
 * 模块 3B：模型下载器的测试（真起一个本地 HTTP 源，不碰外网）。
 *
 * 覆盖四件在真网络里会真的出岔子的事：**续传**（Range/206 + 断在半截的文件）、
 * **校验**（字节数 / SHA256，不过就丢弃重来）、**磁盘空间检查**（不够就当场说）、
 * **多来源兜底**（首选 404 换下一个）。另加一条"服务端不支持 Range"的兜底：
 * 那时半截文件必须丢掉，不能拼出一份错文件。
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadPlanOf, localModelById } from '../../shared/local-models'
import {
  DISK_MARGIN_BYTES,
  downloadModelFile,
  partialPath,
  verifyModelFile,
  type DownloadProgressEvent
} from '../llama/download'

/** 1.5MB 的假模型（够测分块与"断在半截"） */
const PAYLOAD = Buffer.alloc(1_500_000, 7)
for (let index = 0; index < PAYLOAD.length; index += 997) PAYLOAD[index] = index % 251
const MANIFEST = {
  bytes: PAYLOAD.length,
  sha256: createHash('sha256').update(PAYLOAD).digest('hex')
}

interface Source {
  url: string
  /** 收到的 Range 头（每次请求一条） */
  ranges: Array<string | undefined>
  close: () => Promise<void>
}

const open: Array<() => Promise<void>> = []
const dirs: string[] = []

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-download-'))
  dirs.push(dir)
  return dir
}

async function startSource(
  options: { honorRange?: boolean; body?: Buffer; status?: number } = {}
): Promise<Source> {
  const body = options.body ?? PAYLOAD
  const honorRange = options.honorRange ?? true
  const source: Source = { url: '', ranges: [], close: async () => undefined }
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    source.ranges.push(request.headers.range as string | undefined)
    if (options.status !== undefined && options.status !== 200) {
      response.writeHead(options.status).end()
      return
    }
    const range = request.headers.range
    if (honorRange && typeof range === 'string' && range.startsWith('bytes=')) {
      const start = Number(range.slice('bytes='.length).replace('-', ''))
      if (start >= body.length) {
        response.writeHead(416).end()
        return
      }
      const slice = body.subarray(start)
      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`
      })
      response.end(slice)
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length)
    })
    response.end(body)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  source.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`
  source.close = () =>
    new Promise<void>((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    })
  open.push(source.close)
  return source
}

/** 磁盘空间：给个"够"的默认值，测不够时注入小值 */
const enoughSpace = async (): Promise<number> => 10 * 1024 * 1024 * 1024

afterEach(async () => {
  while (open.length > 0) await open.pop()?.()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('模型下载器：正常路径', () => {
  it('下完 → 校验 → 落到最终文件名；.part 不残留；进度单调', async () => {
    const source = await startSource()
    const dest = join(workDir(), 'model.gguf')
    const progress: DownloadProgressEvent[] = []

    const outcome = await downloadModelFile({
      file: MANIFEST,
      urls: [source.url],
      dest,
      freeBytes: enoughSpace,
      onProgress: (event) => progress.push(event)
    })

    expect(outcome.url).toBe(source.url)
    expect(statSync(dest).size).toBe(MANIFEST.bytes)
    expect(await verifyModelFile(dest, MANIFEST)).toBeNull()
    expect(existsSync(partialPath(dest))).toBe(false)
    expect(progress.at(-1)?.phase).toBe('verifying')
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.received).toBeGreaterThanOrEqual(progress[index - 1]!.received)
    }
  }, 30_000)

  it('校验不过（清单哈希是别人的）：丢弃重来，并抛出人话', async () => {
    const source = await startSource()
    const dest = join(workDir(), 'model.gguf')

    await expect(
      downloadModelFile({
        file: { bytes: MANIFEST.bytes, sha256: 'f'.repeat(64) },
        urls: [source.url],
        dest,
        freeBytes: enoughSpace
      })
    ).rejects.toThrow(/校验不过/)
    expect(existsSync(dest)).toBe(false)
    // 坏文件不能留着（否则下次续传必然接着坏）
    expect(existsSync(partialPath(dest))).toBe(false)
  }, 30_000)

  it('字节数不对：报"下载不完整"', async () => {
    const source = await startSource({ body: PAYLOAD.subarray(0, PAYLOAD.length - 100) })
    const dest = join(workDir(), 'model.gguf')
    await expect(
      downloadModelFile({
        file: MANIFEST,
        urls: [source.url],
        dest,
        freeBytes: enoughSpace
      })
    ).rejects.toThrow(/不完整/)
  }, 30_000)
})

describe('模型下载器：断点续传', () => {
  it('半截文件（.part）在场：带 Range 接着下，最后拼出一份哈希正确的文件', async () => {
    const cut = 900_000
    const dest = join(workDir(), 'model.gguf')
    writeFileSync(partialPath(dest), PAYLOAD.subarray(0, cut))

    const source = await startSource()
    await downloadModelFile({
      file: MANIFEST,
      urls: [source.url],
      dest,
      freeBytes: enoughSpace
    })

    expect(source.ranges).toEqual([`bytes=${cut}-`])
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(await verifyModelFile(dest, MANIFEST)).toBeNull()
  }, 30_000)

  it('服务端不支持 Range（回 200 全量）：丢掉半截、从头下，不拼出错文件', async () => {
    const dest = join(workDir(), 'model.gguf')
    writeFileSync(partialPath(dest), Buffer.alloc(900_000, 1)) // 内容是错的（与服务端不一致）
    const source = await startSource({ honorRange: false })

    await downloadModelFile({
      file: MANIFEST,
      urls: [source.url],
      dest,
      freeBytes: enoughSpace
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  }, 30_000)

  it('取消（AbortSignal）：半截文件留着，下次能接着下', async () => {
    const dest = join(workDir(), 'model.gguf')
    const controller = new AbortController()
    const source = await startSource()
    controller.abort()
    await expect(
      downloadModelFile({
        file: MANIFEST,
        urls: [source.url],
        dest,
        signal: controller.signal,
        freeBytes: enoughSpace
      })
    ).rejects.toThrow()

    // 取消之后没有产出最终文件（半截文件留不留都可以，但不能是"看着像下好了"的状态）
    expect(existsSync(dest)).toBe(false)
  }, 30_000)
})

describe('模型下载器：来源兜底与磁盘检查', () => {
  it('首选来源 404：自动换下一个（并记下真正用到的那个地址）', async () => {
    const dead = await startSource({ status: 404 })
    const good = await startSource()
    const dest = join(workDir(), 'model.gguf')

    const outcome = await downloadModelFile({
      file: MANIFEST,
      urls: [dead.url, good.url],
      dest,
      freeBytes: enoughSpace
    })
    expect(outcome.url).toBe(good.url)
    expect(await verifyModelFile(dest, MANIFEST)).toBeNull()
  }, 30_000)

  it('磁盘空间不够：当场回人话（含还差多少 / 当前可用），一个字节都不下', async () => {
    const source = await startSource()
    const dest = join(workDir(), 'model.gguf')
    await expect(
      downloadModelFile({
        file: MANIFEST,
        urls: [source.url],
        dest,
        freeBytes: async () => DISK_MARGIN_BYTES + 1024
      })
    ).rejects.toThrow(/磁盘空间不够/)
    expect(source.ranges).toHaveLength(0)
    expect(existsSync(dest)).toBe(false)
  }, 30_000)

  it('空间是按"还差多少"算的：已经下了一半就不该按整份要空间', async () => {
    const cut = 1_400_000
    const dest = join(workDir(), 'model.gguf')
    writeFileSync(partialPath(dest), PAYLOAD.subarray(0, cut))
    const source = await startSource()

    // 剩余只需 100000 字节：给 (剩余 + 余量 - 1) 就该失败
    await expect(
      downloadModelFile({
        file: MANIFEST,
        urls: [source.url],
        dest,
        freeBytes: async () => MANIFEST.bytes - cut + DISK_MARGIN_BYTES - 1
      })
    ).rejects.toThrow(/磁盘空间不够/)

    await downloadModelFile({
      file: MANIFEST,
      urls: [source.url],
      dest,
      freeBytes: async () => MANIFEST.bytes - cut + DISK_MARGIN_BYTES + 1
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
  }, 30_000)
})

/**
 * 真网络那一路（默认不跑）：`KYCLAW_REAL_NETWORK=1 npx vitest run src/main/__tests__/llama-download.spec.ts`
 *
 * 拿最小档（bge-small-zh-v1.5 Q8_0，26.5MB）真下两次，量的是清单里那两个来源在国内网络里
 * **到底通不通、多快、能不能续传**（ModelScope 走 302 到 CDN，续传要跨重定向保住 Range）。
 * 放在门禁外是因为它依赖外网与源站可用性——环境问题不该把本地红灯点亮。
 */
const REAL_NETWORK = process.env.KYCLAW_REAL_NETWORK === '1'
const SMALL = localModelById('bge-small-zh-v1.5-q8')!

describe.skipIf(!REAL_NETWORK)('模型下载器：真网络（KYCLAW_REAL_NETWORK=1 才跑）', () => {
  const manifest = { bytes: SMALL.file.bytes, sha256: SMALL.file.sha256 }

  it('ModelScope：完整下一次（量速度）', async () => {
    const dest = join(workDir(), 'real-modelscope.gguf')
    const started = Date.now()
    const outcome = await downloadModelFile({
      file: manifest,
      urls: downloadPlanOf(SMALL)[0]!.urls,
      dest,
      freeBytes: enoughSpace
    })
    const seconds = (Date.now() - started) / 1000
    console.log(
      `[real] ModelScope ${SMALL.file.file}：${(manifest.bytes / 1024 / 1024).toFixed(1)} MB / ${seconds.toFixed(1)}s = ${(manifest.bytes / 1024 / 1024 / seconds).toFixed(2)} MB/s`
    )
    expect(outcome.url).toContain('modelscope.cn')
    expect(await verifyModelFile(dest, manifest)).toBeNull()
  }, 300_000)

  it('ModelScope：断点续传（半截文件 + Range 跨 302 重定向）', async () => {
    const source = join(workDir(), 'real-resume-source.gguf')
    await downloadModelFile({
      file: manifest,
      urls: downloadPlanOf(SMALL)[0]!.urls,
      dest: source,
      freeBytes: enoughSpace
    })

    // 造一个"下到 3MB 断了"的现场：把前 3MB 拷成半截文件
    const cut = 3 * 1024 * 1024
    const dest = join(workDir(), 'real-resume.gguf')
    const whole = readFileSync(source)
    writeFileSync(partialPath(dest), whole.subarray(0, cut))

    const started = Date.now()
    await downloadModelFile({
      file: manifest,
      urls: downloadPlanOf(SMALL)[0]!.urls,
      dest,
      freeBytes: enoughSpace
    })
    const seconds = (Date.now() - started) / 1000
    console.log(
      `[real] 续传（从 ${(cut / 1024 / 1024).toFixed(0)} MB 接着下）：用 ${seconds.toFixed(1)}s，${((manifest.bytes - cut) / 1024 / 1024 / seconds).toFixed(2)} MB/s`
    )
    expect(readFileSync(dest).equals(whole)).toBe(true)
    expect(await verifyModelFile(dest, manifest)).toBeNull()
  }, 300_000)

  it('HuggingFace（镜像在前）：完整下一次', async () => {
    const plan = downloadPlanOf(SMALL)
    const hf = plan.find((file) => file.source === 'huggingface')
    expect(hf).toBeDefined()

    const dest = join(workDir(), 'real-hf.gguf')
    const started = Date.now()
    const outcome = await downloadModelFile({
      file: manifest,
      urls: hf!.urls,
      dest,
      freeBytes: enoughSpace
    })
    const seconds = (Date.now() - started) / 1000
    console.log(
      `[real] HuggingFace（用到的地址：${outcome.url}）：${(manifest.bytes / 1024 / 1024).toFixed(1)} MB / ${seconds.toFixed(1)}s = ${(manifest.bytes / 1024 / 1024 / seconds).toFixed(2)} MB/s`
    )
    expect(await verifyModelFile(dest, manifest)).toBeNull()
  }, 300_000)
})
