/**
 * 「本地模型」的目录与契约（round 28 模块 3B）：本机嵌入引擎（llama.cpp 子进程）用的 GGUF 清单、
 * 下载/管理通道的入参与回包，主进程 / preload / 渲染端共用一处。
 *
 * 三条纪律：
 *   1. **体积与哈希全部来自各源 API 实测**（2026-10-11 拉 ModelScope `repo/files` 与 HF `tree` 得到），
 *      没有估算值；每个来源各自钉自己的 sha256 —— 同一份权重被不同仓库上传过，字节数相同、
 *      内容也可能不同（例如 Qwen3-Embedding-0.6B 的 Q8_0：官方仓库与第三方镜像的 sha256 就不一样）。
 *   2. **二进制与模型都不进 git**：GGUF 落 `<userData>/models/`（下载器管理），
 *      llama.cpp 运行时落 `resources/llama/`（获取脚本 `scripts/fetch-llama.mjs`，已 gitignore）。
 *   3. 这里只放"事实"，不放获取方式：下载顺序（ModelScope → HuggingFace）由 main/llama/download.ts
 *      按 `files` 的书写顺序决定。
 */
import { z } from './zod'

/** 下载来源：ModelScope 国内直连首选；HuggingFace 备选（本机实测直连超时，默认走 hf-mirror 镜像） */
export const LOCAL_MODEL_SOURCES = ['modelscope', 'huggingface'] as const

export type LocalModelSourceId = (typeof LOCAL_MODEL_SOURCES)[number]

/**
 * 一个来源上的一个文件（**同一个模型在不同来源上是一份独立记录**：各自的 sha256 / 可选 URL 都钉死）。
 * `urls` 依次尝试（首个失败换下一个）：HuggingFace 一路是「镜像在前、官方源在后」——
 * 本机实测 huggingface.co 直连超时（见模块 3B 报告），所以镜像才是能用的那条路。
 */
export interface LocalModelFile {
  source: LocalModelSourceId
  /** 仓库全名（`owner/name`） */
  repo: string
  /** 仓库里的文件名 */
  file: string
  bytes: number
  sha256: string
  urls: readonly string[]
}

export interface LocalEmbeddingModelSpec {
  /** 稳定 id：落盘文件名 `<id>.gguf`、设置里的"当前生效模型"、IPC 入参都用它 */
  id: string
  /** 界面显示名（含量化档，用户要能分辨 610MB 与 1.1GB 是同一模型的两种档） */
  name: string
  /** 一句话定位（多语/中文/质量优先…）：是"选哪个"的信息，不是后端解释 */
  note: string
  /** 实测向量维度（引擎实际输出；自定义模型以引擎回包为准） */
  dim: number
  /** 实测池化方式（GGUF 元数据里声明的值；引擎按元数据走，命令行不覆盖） */
  pooling: 'cls' | 'last' | 'mean'
  file: LocalModelFile
}

/** ModelScope 的取文件端点（先 302 到 CDN；CDN 支持 Range，所以能续传） */
function modelscopeUrl(repo: string, file: string): string {
  const query = new URLSearchParams({ Revision: 'master', FilePath: file })
  return `https://modelscope.cn/api/v1/models/${repo}/repo?${query.toString()}`
}

/** HuggingFace 的取文件端点（镜像同路径，只有域名不同） */
function huggingfaceUrl(host: string, repo: string, file: string): string {
  return `https://${host}/${repo}/resolve/main/${file}`
}

/** 一条 HuggingFace 来源记录：镜像在前、官方源在后（实测直连超时，镜像兜底） */
function huggingface(repo: string, file: string, bytes: number, sha256: string): LocalModelFile {
  return {
    source: 'huggingface',
    repo,
    file,
    bytes,
    sha256,
    urls: [
      huggingfaceUrl('hf-mirror.com', repo, file),
      huggingfaceUrl('huggingface.co', repo, file)
    ]
  }
}

function modelscope(repo: string, file: string, bytes: number, sha256: string): LocalModelFile {
  return { source: 'modelscope', repo, file, bytes, sha256, urls: [modelscopeUrl(repo, file)] }
}

/**
 * 推荐清单（2026-10-11 实测，全部逐字节核对过各源 API 的 Size/Sha256）。顺序 = 界面顺序。
 *
 * Qwen3-Embedding 系**只有 Q8_0 与 f16 两档**（0.6B：610MB / 1142MB；没有 Q4/Q5）——
 * 别按"Q4 约 0.3GB"宣传，官方与 bullerwins 两个仓库都实测过只有这两档。
 */
export const LOCAL_EMBEDDING_MODELS: readonly LocalEmbeddingModelSpec[] = [
  {
    id: 'qwen3-embedding-0.6b-q8',
    name: 'Qwen3-Embedding-0.6B（Q8_0）',
    note: '质量优先，多语',
    dim: 1024,
    pooling: 'last',
    file: modelscope(
      'Qwen/Qwen3-Embedding-0.6B-GGUF',
      'Qwen3-Embedding-0.6B-Q8_0.gguf',
      639150592,
      '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
    )
  },
  {
    id: 'qwen3-embedding-0.6b-f16',
    name: 'Qwen3-Embedding-0.6B（f16）',
    note: '质量优先，多语',
    dim: 1024,
    pooling: 'last',
    file: modelscope(
      'Qwen/Qwen3-Embedding-0.6B-GGUF',
      'Qwen3-Embedding-0.6B-f16.gguf',
      1197629632,
      '421a27e58d165478cc7acb984a688c2aa41404968b0203e7cd743ece44c54340'
    )
  },
  {
    id: 'bge-m3-q4-k-m',
    name: 'bge-m3（Q4_K_M）',
    note: '多语',
    dim: 1024,
    pooling: 'cls',
    file: modelscope(
      'gpustack/bge-m3-GGUF',
      'bge-m3-Q4_K_M.gguf',
      437778496,
      '6d39681b26c61279ac1f82db35a04a05009e94c415b51c858ff571489a82fc06'
    )
  },
  {
    id: 'multilingual-e5-small-q8',
    name: 'multilingual-e5-small（Q8_0）',
    note: '小体积，多语',
    dim: 384,
    pooling: 'mean',
    file: huggingface(
      'cstr/multilingual-e5-small-GGUF',
      'multilingual-e5-small-q8_0.gguf',
      131624960,
      '0a34067a40f25d3149b36885faa62bee0e5284d0f9edc102acfc00e115d953e8'
    )
  },
  {
    id: 'bge-small-zh-v1.5-q8',
    name: 'bge-small-zh-v1.5（Q8_0）',
    note: '最小体积，中文',
    dim: 512,
    pooling: 'cls',
    file: modelscope(
      'gubanjie/bge-small-zh-v1.5-q8_0.gguf',
      'bge-small-zh-v1.5-q8_0.gguf',
      26472640,
      '5a88d266870fbd27c6f329df60de80e2d4cf3bbd5e6f080bd5c1b2e5abb12039'
    )
  }
]

/**
 * 同一个模型的备选来源（下载器在首选来源不通用时按它兜底）。
 * 清单里只写一条 `file`，这里补"另一条路"：**同 sha256 才算同一条备选**——
 * 哈希对不上的（同尺寸不同内容）宁可不写，免得校验到一个别家的文件。
 */
const FALLBACK_FILES: Record<string, LocalModelFile> = {
  'qwen3-embedding-0.6b-q8': huggingface(
    'Qwen/Qwen3-Embedding-0.6B-GGUF',
    'Qwen3-Embedding-0.6B-Q8_0.gguf',
    639150592,
    '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'
  ),
  'qwen3-embedding-0.6b-f16': huggingface(
    'Qwen/Qwen3-Embedding-0.6B-GGUF',
    'Qwen3-Embedding-0.6B-f16.gguf',
    1197629632,
    '421a27e58d165478cc7acb984a688c2aa41404968b0203e7cd743ece44c54340'
  ),
  'bge-m3-q4-k-m': huggingface(
    'gpustack/bge-m3-GGUF',
    'bge-m3-Q4_K_M.gguf',
    437778496,
    '6d39681b26c61279ac1f82db35a04a05009e94c415b51c858ff571489a82fc06'
  ),
  'multilingual-e5-small-q8': modelscope(
    'cstr/multilingual-e5-small-GGUF',
    'multilingual-e5-small-q8_0.gguf',
    131624960,
    '0a34067a40f25d3149b36885faa62bee0e5284d0f9edc102acfc00e115d953e8'
  ),
  'bge-small-zh-v1.5-q8': huggingface(
    'CompendiumLabs/bge-small-zh-v1.5-gguf',
    'bge-small-zh-v1.5-q8_0.gguf',
    26472640,
    '5a88d266870fbd27c6f329df60de80e2d4cf3bbd5e6f080bd5c1b2e5abb12039'
  )
}

/**
 * 一个模型的**下载路线**：首选在前，备选在后（下载器按顺序试）。
 * 备选只有"另一条路真存在且哈希一致"时才在清单里（`FALLBACK_FILES` 的键就是证据）。
 */
export function downloadPlanOf(spec: LocalEmbeddingModelSpec): LocalModelFile[] {
  const fallback = FALLBACK_FILES[spec.id]
  return fallback === undefined ? [spec.file] : [spec.file, fallback]
}

export function localModelById(id: string): LocalEmbeddingModelSpec | null {
  return LOCAL_EMBEDDING_MODELS.find((model) => model.id === id) ?? null
}

/** 自定义 GGUF 在"生效模型"里的 id（不是推荐档之一） */
export const CUSTOM_MODEL_ID = 'custom'

// ---------------------------------------------------------------- 落盘记录（主进程写、界面读）

/** 一个已下载的推荐档的落盘记录（`<userData>/models/<id>.json` 侧车文件） */
export const installedModelSchema = z.strictObject({
  id: z.string().min(1),
  source: z.enum(LOCAL_MODEL_SOURCES),
  repo: z.string().min(1),
  file: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().min(1),
  downloadedAt: z.string()
})

export type InstalledModel = z.infer<typeof installedModelSchema>

/**
 * "当前生效的本机嵌入模型"（`<userData>/models/active.json`）：**只由主进程的 localModels:* 通道写**。
 * 它是路径（自定义档就是用户自备的任意路径），所以不放进 settings.json —— 与工作区/项目同一纪律：
 * 路径必须过主进程校验/原生选择器，渲染端不能直接塞一个进来。
 */
export const activeModelSchema = z.strictObject({
  modelId: z.string().min(1),
  /** 只有自定义档才有值（推荐档按 id 推路径） */
  customPath: z.string().nullable(),
  /** 自定义档的人话补充：GGUF 头里读到的元数据（读不出就 null） */
  customInfo: z
    .strictObject({
      architecture: z.string().nullable(),
      /** 元数据里声明的池化（engine 会按它走；null = 元数据没写、交给引擎默认） */
      pooling: z.enum(['none', 'mean', 'cls', 'last', 'rank']).nullable()
    })
    .nullable(),
  selectedAt: z.string()
})

export type ActiveModel = z.infer<typeof activeModelSchema>

// ---------------------------------------------------------------- IPC 回包

/** 引擎进程的当前相位（UI 只说用户能看到的四件事） */
export const enginePhaseSchema = z.enum(['stopped', 'starting', 'running', 'error'])

export type EnginePhase = z.infer<typeof enginePhaseSchema>

/** 一次下载的进度（主进程推、界面画进度条） */
export const downloadProgressSchema = z.strictObject({
  id: z.string().min(1),
  phase: z.enum(['downloading', 'verifying', 'done', 'error']),
  received: z.number(),
  total: z.number(),
  /** 失败时的一句人话（成功/进行中为 null） */
  message: z.string().nullable()
})

export type DownloadProgress = z.infer<typeof downloadProgressSchema>

/**
 * 「本地模型」组的全貌（无入参通道的回包，也是进度推送的 payload）：
 * 一个模型一行（推荐档 + 自定义档），加上引擎相位与正在进行的下载。
 */
export const localModelsOverviewSchema = z.strictObject({
  /** 模型目录（`<userData>/models`；界面不显示，出问题时报给用户） */
  modelsDir: z.string(),
  items: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string(),
      note: z.string(),
      /** 清单里实测的下载体积（未下载也要能显示大小） */
      bytes: z.number().int().positive(),
      downloaded: z.boolean(),
      /** 本机实际占用（下载后以磁盘为准；未下载 = null） */
      installedBytes: z.number().int().nonnegative().nullable(),
      /** 下载来源（已下载才有） */
      source: z.enum(LOCAL_MODEL_SOURCES).nullable(),
      active: z.boolean(),
      /** 清单里的档（自定义档没有：它为 false） */
      custom: z.boolean()
    })
  ),
  activeId: z.string().nullable(),
  engine: z.strictObject({
    phase: enginePhaseSchema,
    /** 引擎正在用的模型 id（没起来 = null） */
    modelId: z.string().nullable(),
    /** 一句人话（错误原因 / 空闲回收说明；正常 = null） */
    detail: z.string().nullable()
  }),
  download: downloadProgressSchema.nullable()
})

export type LocalModelsOverview = z.infer<typeof localModelsOverviewSchema>

/** 空目录时的最小总览（preload 侧解析失败时兜底用；也是 UI 的初值） */
export function emptyOverview(modelsDir = ''): LocalModelsOverview {
  return {
    modelsDir,
    items: LOCAL_EMBEDDING_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      note: model.note,
      bytes: model.file.bytes,
      downloaded: false,
      installedBytes: null,
      source: null,
      active: false,
      custom: false
    })),
    activeId: null,
    engine: { phase: 'stopped', modelId: null, detail: null },
    download: null
  }
}

/** 字节数的人话（界面用）：统一按 MB 报（与任务书/清单里的实测体积同一口径，不做 GB 换算） */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 100) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}
