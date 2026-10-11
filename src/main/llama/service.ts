/**
 * 本地引擎服务（模块 3B，主进程侧）：把「清单 + 落盘记录 + 引擎子进程 + 嵌入网关 + 下载器」
 * 拼成一个东西，供两条消费路径用：
 *
 *   1. **召回装配**（mastra/embedding.ts 的 `localEngine` 一支）：`embeddingEndpoint()` 回网关的 baseURL；
 *   2. **设置页「本地模型」组**（IPC）：`overview()` 回全貌，`download/select/remove` 是动作。
 *
 * 纯 Node（目录、二进制路径、空闲时长都由调用方注入），所以整条链路能在 vitest 里用假二进制真跑。
 * 单实例：一个进程同时只装一个嵌入模型（换模型 = 换引擎，v1 口径）。
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  CUSTOM_MODEL_ID,
  LOCAL_EMBEDDING_MODELS,
  downloadPlanOf,
  localModelById,
  type DownloadProgress,
  type LocalModelsOverview
} from '../../shared/local-models'
import { createLlamaEngine, type EngineStatus, type LlamaEngine } from './engine'
import { createEmbeddingGateway, type EmbeddingGateway } from './gateway'
import { createLocalModelStore, type LocalModelStore } from './models'
import { downloadModelFile, fileSizeOf, type DownloadModelOptions } from './download'

export interface LocalModelServiceOptions {
  userDataDir: string
  /** `llama-server.exe` 的绝对路径（Electron 侧算：打包走 resources/llama，开发态走仓库 resources/llama） */
  binaryPath: string
  /** 空闲回收毫秒（现读设置；0 = 不回收） */
  idleMs?: () => number
  startupTimeoutMs?: number
  log?: (message: string, error?: unknown) => void
  /** 总览变化（下载进度、引擎相位）——主进程拿它广播给界面 */
  onChange?: () => void
  /** 测试注入 */
  downloadFile?: (options: DownloadModelOptions) => Promise<{ url: string; bytes: number }>
  freeBytes?: (dir: string) => Promise<number>
}

export interface LocalModelService {
  /**
   * 本机引擎的嵌入端点（没选模型 / 文件不在 = null；引擎文件缺失会抛人话错误）。
   * `apiKey` 是网关那一把（每次启动新生成），嵌到 embedder 的 API Key 字段里——它不是用户的密钥。
   */
  embeddingEndpoint(): Promise<{ baseUrl: string; modelId: string; apiKey: string } | null>
  overview(): Promise<LocalModelsOverview>
  /** 下载一个推荐档（单任务；已在下载就抛） */
  download(id: string): Promise<void>
  /** 取消当前下载（半截文件留着，下次续传） */
  cancel(): void
  /** 设为生效（推荐档；文件与记录都在才行） */
  select(id: string): Promise<void>
  /** 设为生效（自定义 GGUF；读不出 GGUF 头就抛人话） */
  selectCustom(path: string): Promise<void>
  /** 删除一个推荐档（生效中的先停引擎）；`custom` = 只是取消选择，不删用户文件 */
  remove(id: string): Promise<void>
  /** 引擎现读状态（设置页状态行用） */
  engineStatus(): EngineStatus
  dispose(): Promise<void>
}

function stoppedStatus(): EngineStatus {
  return { phase: 'stopped', modelId: null, detail: null }
}

export function createLocalModelService(options: LocalModelServiceOptions): LocalModelService {
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(message, error))
  const store: LocalModelStore = createLocalModelStore(options.userDataDir)
  const downloader = options.downloadFile ?? downloadModelFile

  /** 每次应用启动新生成：网关入站校验 + 转发给引擎的同一把（明文只在主进程内存里） */
  const engineKey = randomBytes(24).toString('base64url')

  let entry: { modelId: string; modelPath: string; engine: LlamaEngine } | null = null
  let download: DownloadProgress | null = null
  let downloadAbort: AbortController | undefined
  let doneTimer: ReturnType<typeof setTimeout> | undefined

  /** 下载完成后"已完成"在界面上停留的时间 */
  const DONE_LINGER_MS = 3_000

  function clearDoneTimer(): void {
    if (doneTimer !== undefined) clearTimeout(doneTimer)
    doneTimer = undefined
  }

  const notify = (): void => {
    options.onChange?.()
  }

  /** 当前生效模型对应的引擎（换模型 = 换一个引擎；老进程先收掉） */
  async function currentEngine(): Promise<LlamaEngine | null> {
    const active = await store.active()
    if (active === null) return null
    const modelPath = active.customPath ?? store.ggufPath(active.modelId)
    if ((await fileSizeOf(modelPath)) === null) return null
    if (entry !== null && entry.modelPath === modelPath && entry.modelId === active.modelId) {
      return entry.engine
    }
    if (entry !== null) {
      log(`[kyclaw] 本机嵌入模型切换：${entry.modelId} → ${active.modelId}（收掉上一个引擎）`)
      await entry.engine.dispose()
      entry = null
    }
    entry = {
      modelId: active.modelId,
      modelPath,
      engine: createLlamaEngine({
        binaryPath: options.binaryPath,
        modelPath,
        modelId: active.modelId,
        apiKey: engineKey,
        ...(options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: options.startupTimeoutMs }),
        ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
        log,
        onChange: () => notify()
      })
    }
    return entry.engine
  }

  /** 网关要一个稳定的引擎门面：模型换了、引擎重建了，网关这边的引用不变 */
  const holder: LlamaEngine = {
    ensureStarted: async () => {
      if (!existsSync(options.binaryPath)) {
        throw new Error(`本机嵌入引擎文件缺失：${options.binaryPath}（重装应用可修复）`)
      }
      const engine = await currentEngine()
      if (engine === null) throw new Error('还没有选择本机嵌入模型')
      return await engine.ensureStarted()
    },
    status: () => entry?.engine.status() ?? stoppedStatus(),
    begin: () => entry?.engine.begin() ?? ((): void => undefined),
    lastUsedAt: () => entry?.engine.lastUsedAt() ?? 0,
    stop: async (reason) => {
      await entry?.engine.stop(reason)
    },
    dispose: async () => {
      await entry?.engine.dispose()
      entry = null
    }
  }

  const gateway: EmbeddingGateway = createEmbeddingGateway({
    engine: holder,
    apiKey: engineKey,
    log
  })

  /** 正在进行的下载中途的状态（界面画进度条） */
  function downloadProgress(): DownloadProgress | null {
    return download
  }

  async function overview(): Promise<LocalModelsOverview> {
    const active = await store.active()
    const items: LocalModelsOverview['items'] = []
    for (const spec of LOCAL_EMBEDDING_MODELS) {
      const bytes = await store.installedBytes(spec.id)
      const record = bytes === null ? null : await store.record(spec.id)
      items.push({
        id: spec.id,
        name: spec.name,
        note: spec.note,
        bytes: spec.file.bytes,
        downloaded: bytes !== null && record !== null,
        installedBytes: bytes,
        source: record?.source ?? null,
        active: active?.modelId === spec.id,
        custom: false
      })
    }
    if (active?.customPath != null) {
      const customBytes = await fileSizeOf(active.customPath)
      items.push({
        id: CUSTOM_MODEL_ID,
        name: active.customPath.split(/[\\/]/).pop() ?? '自定义模型',
        note: '本机文件',
        // 清单里的"体积"对自定义档没有意义（用户自己的文件）：文件在就报它的大小，
        // 不在了就按"没下载"处理（界面会显示"文件不在"，只能取消选择）
        bytes: customBytes ?? 1,
        downloaded: customBytes !== null,
        installedBytes: customBytes,
        source: null,
        active: true,
        custom: true
      })
    }
    const status = holder.status()
    return {
      modelsDir: store.dir,
      items,
      activeId: active?.modelId ?? null,
      engine: { phase: status.phase, modelId: status.modelId, detail: status.detail },
      download: downloadProgress()
    }
  }

  return {
    embeddingEndpoint: async () => {
      const active = await store.active()
      if (active === null) return null
      const engine = await currentEngine()
      if (engine === null) return null
      if (!existsSync(options.binaryPath)) {
        throw new Error(`本机嵌入引擎文件缺失：${options.binaryPath}（重装应用可修复）`)
      }
      const { baseUrl } = await gateway.start()
      // 模型名用**生效记录**里的 id（引擎可能还没起，status() 那时是 null）
      return { baseUrl, modelId: active.modelId, apiKey: engineKey }
    },

    overview,

    engineStatus: () => holder.status(),

    download: async (id) => {
      const spec = localModelById(id)
      if (spec === null) throw new Error(`清单里没有这个模型：${id}`)
      if (
        download !== null &&
        (download.phase === 'downloading' || download.phase === 'verifying')
      ) {
        throw new Error('已经有一个下载在进行，先等它下完或取消它')
      }
      const plan = downloadPlanOf(spec)
      const urls = plan.flatMap((file) => [...file.urls])
      /** 下载器只回"实际用的那个 URL"，这里按它找回是哪个来源/仓库（写进侧车记录） */
      const byUrl = new Map(plan.flatMap((file) => file.urls.map((url) => [url, file] as const)))
      const controller = new AbortController()
      downloadAbort = controller
      download = { id, phase: 'downloading', received: 0, total: spec.file.bytes, message: null }
      notify()
      try {
        const outcome = await downloader({
          file: { bytes: spec.file.bytes, sha256: spec.file.sha256 },
          urls,
          dest: store.ggufPath(id),
          signal: controller.signal,
          onProgress: (event) => {
            download = {
              id,
              phase: event.phase,
              received: event.received,
              total: event.total,
              message: null
            }
            notify()
          },
          ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
          log
        })
        const used = byUrl.get(outcome.url) ?? plan[0]
        await store.writeRecord({
          id,
          source: used.source,
          repo: used.repo,
          file: used.file,
          bytes: spec.file.bytes,
          sha256: spec.file.sha256,
          downloadedAt: new Date().toISOString()
        })
        download = {
          id,
          phase: 'done',
          received: spec.file.bytes,
          total: spec.file.bytes,
          message: null
        }
        // "已完成"留三秒再收摊：那之后这一行的状态（已占用 + 使用/删除）本身就是结果
        clearDoneTimer()
        doneTimer = setTimeout(() => {
          if (download?.id === id && download.phase === 'done') {
            download = null
            notify()
          }
        }, DONE_LINGER_MS)
        doneTimer.unref?.()
      } catch (error) {
        if (controller.signal.aborted) {
          // 取消不是错误：进度条收掉就行（半截文件留着，下次续传）
          download = null
          notify()
          throw error
        }
        download = {
          id,
          phase: 'error',
          received: download?.id === id ? download.received : 0,
          total: spec.file.bytes,
          message: error instanceof Error ? error.message : String(error)
        }
        log(`[kyclaw] 模型下载失败：${spec.name}`, error)
        throw error
      } finally {
        downloadAbort = undefined
        notify()
      }
    },

    cancel: () => {
      downloadAbort?.abort()
      downloadAbort = undefined
      clearDoneTimer()
      download = null
      notify()
    },

    select: async (id) => {
      // 生效中的模型可能在换：先落记录再让引擎按新模型重建
      await store.select(id)
      await currentEngine()
      notify()
    },

    selectCustom: async (path) => {
      await store.selectCustom(path)
      notify()
    },

    remove: async (id) => {
      const active = await store.active()
      if (id === CUSTOM_MODEL_ID) {
        // 自定义档的"删除"= 取消选择（用户自己的 GGUF 一动不动）
        await holder.stop('manual')
        await store.clearActive()
        notify()
        return
      }
      if (active?.modelId === id) {
        // Windows 上被 mmap 的 GGUF 删不掉：先把引擎收掉再删
        await holder.stop('manual')
      }
      await store.remove(id)
      if (active?.modelId === id) entry = null
      notify()
    },

    dispose: async () => {
      downloadAbort?.abort()
      clearDoneTimer()
      await gateway.close()
      await holder.dispose()
    }
  }
}
