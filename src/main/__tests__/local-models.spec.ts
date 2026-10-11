// @vitest-environment node
/**
 * 模块 3B：本地引擎服务（主进程侧）的测试：清单/记录/生效/删除 + 端点交给召回那一层。
 *
 * 用假下载器（直接按清单体积写个文件，不起网络）+ 假二进制（fixtures/llama-server-stub.mjs），
 * 打的是"设置页那几个按钮按下去之后主进程真发生了什么"：
 *   1. 没选模型 → `embeddingEndpoint()` 回 null（召回那一层据此把状态说成"还没有启用本机模型"）；
 *   2. 下载 → 侧车记录 + 占用 + 来源；设为生效 → active.json；endpoint 出现（网关起监听）；
 *   3. 删除生效中的模型 → 引擎先停再删（Windows 上被 mmap 的文件删不掉）；
 *   4. 自定义 GGUF：读头把门（不是 GGUF 就回人话），选中后按绝对路径生效。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_EMBEDDING_MODELS, localModelById } from '../../shared/local-models'
import { createLocalModelService, type LocalModelService } from '../llama/service'
import { partialPath } from '../llama/download'
import { modelPathFor, sidecarPathFor } from '../llama/download'

const STUB = resolve(__dirname, '../../../fixtures/llama-server-stub.mjs')
const SMALL = localModelById('bge-small-zh-v1.5-q8')!
const QWEN = localModelById('qwen3-embedding-0.6b-q8')!

const open: Array<() => Promise<void>> = []
const dirs: string[] = []

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-local-models-'))
  dirs.push(dir)
  return dir
}

interface Built {
  service: LocalModelService
  userDataDir: string
  /** 假下载器写下的"模型文件"内容（按清单体积缩水：测试不需要真 600MB） */
  downloaded: string[]
}

function build(options: { withBinary?: boolean } = {}): Built {
  const userDataDir = workDir()
  const downloaded: string[] = []
  const service = createLocalModelService({
    userDataDir,
    binaryPath:
      options.withBinary === false ? join(userDataDir, '没有这个引擎.exe') : process.execPath,
    log: () => undefined,
    downloadFile: async ({ dest, file, onProgress }) => {
      // 假下载器：写一个与清单同大小（但内容随便）的文件，并走一遍进度回调
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, Buffer.alloc(Math.min(file.bytes, 4096), 3))
      downloaded.push(dest)
      onProgress?.({ received: file.bytes, total: file.bytes, phase: 'verifying' })
      return { url: 'https://example.invalid/model.gguf', bytes: file.bytes }
    }
  })
  open.push(() => service.dispose())
  return { service, userDataDir, downloaded }
}

/** 合成一个 GGUF 头（够 readGgufInfo 认出来） */
function syntheticGguf(): Buffer {
  const name = Buffer.from('bert.pooling_type', 'utf8')
  const kv = Buffer.alloc(8 + name.length + 4 + 4)
  kv.writeBigUInt64LE(BigInt(name.length), 0)
  name.copy(kv, 8)
  kv.writeUInt32LE(4, 8 + name.length) // TYPE_UINT32
  kv.writeUInt32LE(2, 8 + name.length + 4) // cls
  const head = Buffer.alloc(24)
  head.write('GGUF', 0, 'ascii')
  head.writeUInt32LE(3, 4)
  head.writeBigUInt64LE(1n, 8)
  head.writeBigUInt64LE(1n, 16)
  return Buffer.concat([head, kv, Buffer.alloc(32, 0)])
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('本地模型服务：清单与生效', () => {
  it('没选模型：清单全是"未下载"，endpoint 回 null（召回那一层据此说"还没有启用本机模型"）', async () => {
    const { service } = build()
    const overview = await service.overview()
    expect(overview.items).toHaveLength(LOCAL_EMBEDDING_MODELS.length)
    expect(overview.items.every((item) => !item.downloaded && !item.active)).toBe(true)
    // 未下载也要能显示大小（清单里实测的体积）
    expect(overview.items.find((item) => item.id === QWEN.id)?.bytes).toBe(639150592)
    expect(overview.activeId).toBeNull()
    expect(overview.engine.phase).toBe('stopped')
    expect(await service.embeddingEndpoint()).toBeNull()
  }, 30_000)

  it('下载 → 记录与占用就位（来源是清单里的首选来源）；设为生效 → active 跟着走', async () => {
    const { service, userDataDir } = build()
    await service.download(SMALL.id)

    const afterDownload = await service.overview()
    const item = afterDownload.items.find((candidate) => candidate.id === SMALL.id)!
    expect(item.downloaded).toBe(true)
    expect(item.installedBytes).toBe(4096) // 假下载器只写了 4KB
    expect(item.source).toBe(SMALL.file.source)
    expect(afterDownload.download?.phase).toBe('done')
    // 侧车记录落在模型目录里（下一个应用版本读它算占用与来源）
    expect(existsSync(sidecarPathFor(join(userDataDir, 'models'), SMALL.id))).toBe(true)

    await service.select(SMALL.id)
    const afterSelect = await service.overview()
    expect(afterSelect.activeId).toBe(SMALL.id)
    expect(afterSelect.items.find((candidate) => candidate.id === SMALL.id)?.active).toBe(true)
    expect(existsSync(join(userDataDir, 'models', 'active.json'))).toBe(true)
  }, 30_000)

  it('没下载就"使用"：拒绝（不留一个指向不存在文件的生效记录）', async () => {
    const { service } = build()
    await expect(service.select(QWEN.id)).rejects.toThrow(/还没下载/)
  }, 30_000)

  it('删除已下载的模型：文件与记录一起没；生效中的那条会把 active 一起摘掉', async () => {
    const { service, userDataDir } = build()
    await service.download(SMALL.id)
    await service.select(SMALL.id)
    const gguf = modelPathFor(join(userDataDir, 'models'), SMALL.id)
    savePartial(gguf)
    expect(existsSync(gguf)).toBe(true)

    await service.remove(SMALL.id)
    expect(existsSync(gguf)).toBe(false)
    expect(existsSync(partialPath(gguf))).toBe(false)
    expect(existsSync(sidecarPathFor(join(userDataDir, 'models'), SMALL.id))).toBe(false)
    const overview = await service.overview()
    expect(overview.activeId).toBeNull()
    expect(overview.items.find((candidate) => candidate.id === SMALL.id)?.downloaded).toBe(false)
  }, 30_000)
})

describe('本地模型服务：自定义 GGUF', () => {
  it('读得出 GGUF 头就收下（记架构与池化）；读不出就回人话', async () => {
    const { service } = build()
    const dir = workDir()

    const bad = join(dir, '不是模型.gguf')
    writeFileSync(bad, 'plain text, not a model')
    await expect(service.selectCustom(bad)).rejects.toThrow(/不是 GGUF/)

    const good = join(dir, '自定义.gguf')
    writeFileSync(good, syntheticGguf())
    await service.selectCustom(good)

    const overview = await service.overview()
    expect(overview.activeId).toBe('custom')
    const custom = overview.items.find((item) => item.custom)
    expect(custom?.name).toBe('自定义.gguf')
    expect(custom?.active).toBe(true)
    expect(custom?.installedBytes).toBe(syntheticGguf().length)
  }, 30_000)

  it('自定义档的"删除"= 取消选择：用户自己的文件一动不动', async () => {
    const { service } = build()
    const dir = workDir()
    const file = join(dir, 'my-model.gguf')
    writeFileSync(file, syntheticGguf())
    await service.selectCustom(file)

    await service.remove('custom')
    expect(existsSync(file)).toBe(true)
    expect((await service.overview()).activeId).toBeNull()
  }, 30_000)
})

describe('本地模型服务：端点与引擎文件', () => {
  it('选好模型之后给出网关端点（含本机密钥；模型名是清单 id）', async () => {
    const { service } = build()
    await service.download(SMALL.id)
    await service.select(SMALL.id)

    const endpoint = await service.embeddingEndpoint()
    expect(endpoint).not.toBeNull()
    expect(endpoint?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(endpoint?.modelId).toBe(SMALL.id)
    expect((endpoint?.apiKey ?? '').length).toBeGreaterThan(20)
  }, 30_000)

  it('引擎文件缺失：endpoint 抛人话（不是静默回 null——那是"没有模型"的意思）', async () => {
    const { service } = build({ withBinary: false })
    await service.download(SMALL.id)
    await service.select(SMALL.id)
    await expect(service.embeddingEndpoint()).rejects.toThrow(/引擎文件缺失/)
  }, 30_000)
})

/** 造一个半截下载文件（测删除是否连 .part 一起清） */
function savePartial(gguf: string): void {
  writeFileSync(partialPath(gguf), Buffer.from('half'))
  // 顺手确认它的哈希与真实文件不同（避免误判）
  expect(
    createHash('sha256')
      .update(readFileSync(partialPath(gguf)))
      .digest('hex')
  ).not.toBe(SMALL.file.sha256)
}

void STUB
