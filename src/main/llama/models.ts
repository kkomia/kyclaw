/**
 * 本地模型的落盘布局（模块 3B）：`<userData>/models/` 下的文件与两份记录。纯 Node（目录由调用方注入）。
 *
 *   - `<id>.gguf`  下载好的推荐档模型（**不进 git**；自定义档不复制，原地引用）
 *   - `<id>.json`  侧车记录（哪个来源下的、多大、哈希、什么时候）——按它显示占用与来源
 *   - `active.json` "当前生效模型"（推荐档 id 或自定义路径）——**只由主进程写**：
 *                  它是路径，与工作区/项目同一纪律，渲染端塞不进来
 *
 * 记录读不出来（手改坏了 / 老版本留下的）一律当"没有"：宁可让用户重下一次，
 * 也不要拿一份对不上的哈希去跑引擎。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  activeModelSchema,
  installedModelSchema,
  localModelById,
  type ActiveModel,
  type InstalledModel
} from '../../shared/local-models'
import { fileSizeOf, modelPathFor, removeModelFiles, sidecarPathFor } from './download'
import { readGgufInfo, type GgufInfo } from './gguf'

export const ACTIVE_FILE = 'active.json'

/** 模型目录（`<userData>/models`） */
export function modelsDirOf(userDataDir: string): string {
  return join(userDataDir, 'models')
}

async function readJson<T>(file: string, parse: (raw: unknown) => T | null): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export interface LocalModelStore {
  readonly dir: string
  /** 推荐档的 GGUF 路径（无论下没下） */
  ggufPath(id: string): string
  /** 已下载的推荐档记录（没有 = null） */
  record(id: string): Promise<InstalledModel | null>
  /** 磁盘上的实际占用（没有文件 = null） */
  installedBytes(id: string): Promise<number | null>
  /** 写入记录（下载成功后） */
  writeRecord(record: InstalledModel): Promise<void>
  /** 当前生效模型（没有 = null） */
  active(): Promise<ActiveModel | null>
  /** 设为生效：推荐档（校验文件与记录都在） */
  select(id: string): Promise<ActiveModel>
  /** 设为生效：自定义 GGUF（读 GGUF 头把门，读不出人话错误） */
  selectCustom(path: string): Promise<{ active: ActiveModel; info: GgufInfo }>
  /** 当前生效模型的绝对路径（引擎用；文件不在 = null） */
  activeGgufPath(): Promise<string | null>
  /** 取消"当前生效"（自定义档就是这么取消的：只摘记录，不动用户的文件） */
  clearActive(): Promise<void>
  /** 删除一个推荐档（模型 + 侧车 + 半截文件）；生效中的那一条连带把 active 清掉 */
  remove(id: string): Promise<void>
}

export function createLocalModelStore(userDataDir: string): LocalModelStore {
  const dir = modelsDirOf(userDataDir)

  const activeFile = (): string => join(dir, ACTIVE_FILE)

  async function readActive(): Promise<ActiveModel | null> {
    return await readJson(activeFile(), (raw) => {
      const parsed = activeModelSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    })
  }

  return {
    dir,
    ggufPath: (id) => modelPathFor(dir, id),

    record: async (id) =>
      await readJson(sidecarPathFor(dir, id), (raw) => {
        const parsed = installedModelSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      }),

    installedBytes: async (id) => await fileSizeOf(modelPathFor(dir, id)),

    writeRecord: async (record) => {
      await writeJson(sidecarPathFor(dir, record.id), record)
    },

    active: readActive,

    select: async (id) => {
      const spec = localModelById(id)
      if (spec === null) throw new Error(`清单里没有这个模型：${id}`)
      const record = await readJson(sidecarPathFor(dir, id), (raw) => {
        const parsed = installedModelSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      })
      const bytes = await fileSizeOf(modelPathFor(dir, id))
      if (record === null || bytes === null) throw new Error('这个模型还没下载完，先下载再使用')
      const active: ActiveModel = {
        modelId: id,
        customPath: null,
        customInfo: null,
        selectedAt: new Date().toISOString()
      }
      await writeJson(activeFile(), active)
      return active
    },

    selectCustom: async (path) => {
      const info = await readGgufInfo(path)
      const active: ActiveModel = {
        modelId: 'custom',
        customPath: path,
        customInfo: { architecture: info.architecture, pooling: info.pooling },
        selectedAt: new Date().toISOString()
      }
      await writeJson(activeFile(), active)
      return { active, info }
    },

    activeGgufPath: async () => {
      const active = await readActive()
      if (active === null) return null
      const path = active.customPath ?? modelPathFor(dir, active.modelId)
      return (await fileSizeOf(path)) === null ? null : path
    },

    clearActive: async () => {
      await removeModelFiles([activeFile()])
    },

    remove: async (id) => {
      await removeModelFiles([modelPathFor(dir, id), sidecarPathFor(dir, id)])
      const active = await readActive()
      if (active !== null && active.modelId === id) await removeModelFiles([activeFile()])
    }
  }
}
