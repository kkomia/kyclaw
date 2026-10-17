/**
 * Office 文档注册表（M3-S2）：`documentId ↔ realpath / stat / sha256 / owner`。
 *
 * 设计红线（`.superpowers/handover/office-docx-plan.md` §6.2）：
 *   - **不保存文档内容**。表里只有显示信息 + 版本判据（size/mtime/sha256）+ 归属；
 *     需要字节时按 `documentId` 重新读盘（`read` 会复核并刷新版本）。
 *   - **realpath 去重**：Windows 大小写/8.3 短名/junction 用 `realpathSync.native` 归一
 *     （与 `permission/realpath.ts` 同一实现），同一真实文件永远只有一个 documentId。
 *   - **owner 校验**：注册表按打开它的 webContents id 记账；别的窗口读了同一个 id 一律拒绝
 *     （将来跨窗口共享要走显式协议，S2 不做）。
 *   - **不信任渲染端给的路径**：本模块只接收"已经过授权"的绝对路径，授权（选择器 / 会话根
 *     containment）在 `ipc/office.ts`；这里只做文件级分类。
 *
 * 纯逻辑 + 可注入 IO：单测用真实临时文件覆盖绝大多数行为，需要伪造 stat（>64MB、读的时候
 * 文件在变）时才替换 `OfficeDocumentIo` —— 一个 Electron 对象都不碰。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile as readFileBytes, stat as statPath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_EDITOR_ERROR_MESSAGES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  type OfficeDocumentInfo,
  type OfficeErrorCode,
  type OfficeFailure,
  type OfficeOpenResult,
  type OfficeReadResult
} from '../shared/office-editor'

/** 第一步只接 DOCX：扩展名大小写不敏感 */
export const OFFICE_DOCX_EXTENSION = '.docx'

/** 打开时的入口（只进注册表内部，不回渲染端） */
export type OfficeOpenedFrom = 'picker' | 'session'

/** `open` 的上下文：owner 是发起这次打开的 webContents id */
export interface OfficeOpenContext {
  /** webContents.id：后续 read/release 必须由同一个 sender 发起 */
  owner: number
  /** 入口类型（选择器 / 会话根）；只用于排障，不回包 */
  openedFrom: OfficeOpenedFrom
  /** 只读打开（会话入口可传；S3 保存链路会据此拒绝写） */
  readOnly?: boolean
  /**
   * 仅供界面显示的路径。选择器入口用主进程拿到的绝对路径；会话入口用渲染端给的相对路径。
   * 缺省 = 传进来的 filePath。
   */
  displayPath?: string
}

/** 文件系统 IO 的可注入子集（默认实现见 `defaultOfficeDocumentIo`） */
export interface OfficeFileStat {
  size: number
  mtimeMs: number
  isFile: boolean
}

export interface OfficeDocumentIo {
  /** realpath 归一（Windows 上必须用 native：大小写与短名归一） */
  realpath(filePath: string): Promise<string>
  stat(filePath: string): Promise<OfficeFileStat>
  readFile(filePath: string): Promise<Uint8Array>
}

/**
 * 默认 IO：realpath 用 `realpathSync.native`（与权限层同一口径），读文件异步。
 * 64MB 的同步读会卡主进程；stat/read 都走 fs/promises。
 */
export const defaultOfficeDocumentIo: OfficeDocumentIo = {
  realpath: async (filePath) => realpathSync.native(filePath),
  stat: async (filePath) => {
    const info = await statPath(filePath)
    return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() }
  },
  readFile: async (filePath) => new Uint8Array(await readFileBytes(filePath))
}

/** 注册表内部条目（比回包的 `OfficeDocumentInfo` 多 realPath / owner / 入口） */
interface OfficeDocumentRecord extends OfficeDocumentInfo {
  realPath: string
  owner: number
  openedFrom: OfficeOpenedFrom
}

export interface OfficeDocumentOptions {
  /** 单份上限（默认 64MB；测试可调小） */
  maxBytes?: number
  /** 同时打开上限（默认 24；测试可调小） */
  maxOpenDocuments?: number
}

export interface OfficeDocuments {
  /**
   * 打开一份已授权的绝对路径：realpath 归一去重 → stat → 读字节（≤上限）→ sha256 → 入表。
   * 同 realpath + 同 owner 返回既有 documentId 且 `alreadyOpen:true`（不重读）。
   */
  open(filePath: string, context: OfficeOpenContext): Promise<OfficeOpenResult>
  /** 按 id 重读字节：复核 stat/size，刷新注册表版本；owner 不符/文件没了回分类失败 */
  read(documentId: string, owner: number): Promise<OfficeReadResult>
  /** 释放一个 id（幂等；未知 id / 非本窗口 id 不动表） */
  release(documentId: string, owner: number): boolean
  /** 释放某个 webContents 打开的全部文档（webContents destroyed 清算用）；返回释放条数 */
  releaseAll(owner: number): number
  /** 表内条数（诊断/单测用） */
  size(): number
}

/** 分类失败的统一构造（人话口径只住 shared/office-editor.ts） */
export function officeFailure(code: OfficeErrorCode, detail?: string): OfficeFailure {
  const base = OFFICE_EDITOR_ERROR_MESSAGES[code]
  return {
    ok: false,
    code,
    message: detail === undefined || detail === '' ? base : `${base}（${detail}）`
  }
}

/** 读失败只暴露 errno code，不带路径/系统原文（不把本机目录结构透给渲染端） */
function fsDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === undefined || code === '' ? '未知错误' : code
}

/** sha256（小写 hex）：冲突判据的权威 */
export function officeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 回包用的只读信息（剥掉 realPath / owner / 入口） */
function infoOf(record: OfficeDocumentRecord): OfficeDocumentInfo {
  return {
    documentId: record.documentId,
    displayName: record.displayName,
    displayPath: record.displayPath,
    // realpath 归一后的绝对路径：只读回包字段（渲染端仅用于匹配/展示，不作授权参数）
    absolutePath: record.realPath,
    size: record.size,
    mtimeMs: record.mtimeMs,
    sha256: record.sha256,
    readOnly: record.readOnly
  }
}

export function createOfficeDocuments(
  io: OfficeDocumentIo = defaultOfficeDocumentIo,
  options: OfficeDocumentOptions = {}
): OfficeDocuments {
  const maxBytes = options.maxBytes ?? OFFICE_EDITOR_MAX_BYTES
  const maxOpenDocuments = options.maxOpenDocuments ?? OFFICE_MAX_OPEN_DOCUMENTS

  /** documentId → 条目 */
  const byId = new Map<string, OfficeDocumentRecord>()
  /** realpath → 条目（去重键：同一真实文件只允许一个 id） */
  const byRealPath = new Map<string, OfficeDocumentRecord>()

  function remove(record: OfficeDocumentRecord): void {
    byId.delete(record.documentId)
    // realPath 可能被 S3 的另存为改掉，但 S2 不会；删除前复核一下避免误删新条目
    if (byRealPath.get(record.realPath) === record) byRealPath.delete(record.realPath)
  }

  return {
    async open(filePath, context) {
      // ① 格式闸门先于任何 IO：非 .docx 的文件根本不该被读进内存
      if (extname(filePath).toLowerCase() !== OFFICE_DOCX_EXTENSION) {
        return officeFailure('unsupported-format')
      }

      // ② realpath 归一：去重键必须用真实路径（Windows 大小写 / 8.3 短名 / 链接）
      let realPath: string
      try {
        realPath = await io.realpath(filePath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }

      // ③ 同 realpath 去重：同 owner 直接复用；跨窗口按 owner 拒绝（不允许两边各开一份编辑）
      const existing = byRealPath.get(realPath)
      if (existing !== undefined) {
        if (existing.owner !== context.owner) {
          return officeFailure('already-open-elsewhere')
        }
        return { ok: true, alreadyOpen: true, document: infoOf(existing) }
      }

      // ④ stat：普通文件 + 大小闸门（超限不读）
      let before: OfficeFileStat
      try {
        before = await io.stat(realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (!before.isFile) return officeFailure('unreadable', 'not-a-file')
      if (before.size > maxBytes) return officeFailure('too-large')

      // ⑤ 容量：去重之后、读之前判，超限时不付读成本
      if (byId.size >= maxOpenDocuments) return officeFailure('too-many-open')

      // ⑥ 读字节 → sha256（读完再 stat 一次，用真实读到的长度与 mtime 记账）
      let bytes: Uint8Array
      try {
        bytes = await io.readFile(realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (bytes.length > maxBytes) return officeFailure('too-large')
      let after: OfficeFileStat
      try {
        after = await io.stat(realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (!after.isFile) return officeFailure('unreadable', 'not-a-file')
      if (after.size !== bytes.length) {
        // 读的当口文件在变：不把半截快照记成"当前版本"，让用户重开一次
        return officeFailure('conflict', '文件在读取期间被修改')
      }

      const record: OfficeDocumentRecord = {
        documentId: randomUUID(),
        realPath,
        displayName: basename(realPath),
        displayPath: context.displayPath === undefined ? filePath : context.displayPath,
        // 只读回包字段（infoOf 从 realPath 再取，这里满足 OfficeDocumentInfo 的形状）
        absolutePath: realPath,
        size: bytes.length,
        mtimeMs: after.mtimeMs,
        sha256: officeSha256(bytes),
        readOnly: context.readOnly === true,
        owner: context.owner,
        openedFrom: context.openedFrom
      }
      byId.set(record.documentId, record)
      byRealPath.set(realPath, record)
      return { ok: true, alreadyOpen: false, document: infoOf(record) }
    },

    async read(documentId, owner) {
      const record = byId.get(documentId)
      if (record === undefined) return officeFailure('forbidden', '文档没有打开或已关闭')
      if (record.owner !== owner) return officeFailure('forbidden')

      let before: OfficeFileStat
      try {
        before = await io.stat(record.realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (!before.isFile) return officeFailure('unreadable', 'not-a-file')
      if (before.size > maxBytes) return officeFailure('too-large')

      let bytes: Uint8Array
      try {
        bytes = await io.readFile(record.realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (bytes.length > maxBytes) return officeFailure('too-large')

      let after: OfficeFileStat
      try {
        after = await io.stat(record.realPath)
      } catch (error) {
        return officeFailure('unreadable', fsDetail(error))
      }
      if (!after.isFile) return officeFailure('unreadable', 'not-a-file')
      if (after.size !== bytes.length) {
        return officeFailure('conflict', '文件在读取期间被修改')
      }

      // 重读 = 接受磁盘当前内容为新的权威版本（外部改动在这里被"重新加载"，
      // 不是冲突；真正的冲突判定在 S3 写盘之前用壳手里的 expectedSha256 做）。
      record.size = bytes.length
      record.mtimeMs = after.mtimeMs
      record.sha256 = officeSha256(bytes)
      return { ok: true, document: infoOf(record), bytes }
    },

    release(documentId, owner) {
      const record = byId.get(documentId)
      if (record === undefined || record.owner !== owner) return false
      remove(record)
      return true
    },

    releaseAll(owner) {
      let released = 0
      for (const record of [...byId.values()]) {
        if (record.owner !== owner) continue
        remove(record)
        released += 1
      }
      return released
    },

    size() {
      return byId.size
    }
  }
}
