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
import {
  open as openFile,
  readFile as readFileBytes,
  rename as renamePath,
  stat as statPath,
  unlink as unlinkPath
} from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  OFFICE_EDITOR_MAX_BYTES,
  OFFICE_EDITOR_ERROR_MESSAGES,
  OFFICE_MAX_OPEN_DOCUMENTS,
  type OfficeDocumentInfo,
  type OfficeEditorKind,
  type OfficeErrorCode,
  type OfficeFailure,
  type OfficeOpenResult,
  type OfficeReadResult,
  type OfficeSaveAsResult,
  type OfficeSaveResult
} from '../shared/office-editor'

/** M4-X：注册表接受的扩展名 → kind（大小写不敏感；PPTX 在 M4-P 再扩） */
export const OFFICE_EDITOR_EXTENSION_KINDS: Readonly<Record<string, OfficeEditorKind>> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx'
}

/** 路径 → 可编辑 kind（不支持的格式回 undefined，调用方回 unsupported-format） */
export function officeEditorKindOfPath(filePath: string): OfficeEditorKind | undefined {
  return OFFICE_EDITOR_EXTENSION_KINDS[extname(filePath).toLowerCase()]
}

/** 兼容旧导出名（S2/S3 单测与调用方）：现在只代表 DOCX 扩展名 */
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
  /**
   * 仅供界面显示的标题（task-80）：新建空白文档时主进程给「未命名文档」（文件名里带时间戳，
   * 不适合当标签标题）。缺省 = 文件名 basename。
   */
  displayName?: string
}

/** 文件系统 IO 的可注入子集（默认实现见 `defaultOfficeDocumentIo`） */
export interface OfficeFileStat {
  size: number
  mtimeMs: number
  isFile: boolean
}

/**
 * 写链路 IO（原子写三步各自可注入，S3 单测靠它伪造 EPERM/ENOSPC/rename 失败）：
 *   - `writeFileExclusive`：同目录临时文件、`wx` 独占创建、0o600、写满 + `sync` 后关闭；
 *   - `rename`：临时文件 → 目标（Windows 上可覆盖已有文件）；
 *   - `unlink`：失败清理临时文件（尽力，失败不影响错误分类）。
 * 读链路的默认实现同时供写链路用；缺省时 createOfficeDocuments 用真 fs 实现。
 */
export interface OfficeDocumentIo {
  /** realpath 归一（Windows 上必须用 native：大小写与短名归一） */
  realpath(filePath: string): Promise<string>
  stat(filePath: string): Promise<OfficeFileStat>
  readFile(filePath: string): Promise<Uint8Array>
  writeFileExclusive?(filePath: string, bytes: Uint8Array): Promise<void>
  rename?(from: string, to: string): Promise<void>
  unlink?(filePath: string): Promise<void>
}

/** 原子写第一步：同目录临时文件、`wx` 独占创建、0o600、write + sync + close */
async function writeFileExclusiveAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await openFile(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    // 先落稳再 rename：崩溃时目标文件要么是旧内容、要么是新内容，不会半截
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function renameFileAtomic(from: string, to: string): Promise<void> {
  await renamePath(from, to)
}

async function unlinkQuiet(filePath: string): Promise<void> {
  await unlinkPath(filePath)
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
  readFile: async (filePath) => new Uint8Array(await readFileBytes(filePath)),
  writeFileExclusive: writeFileExclusiveAtomic,
  rename: renameFileAtomic,
  unlink: unlinkQuiet
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

/** `save` / `saveAs` 的入参（documentId 由调用方给）：新字节 + 壳上次已知的磁盘 hash */
export interface OfficeSaveInput {
  bytes: Uint8Array
  /** 壳上次已知的磁盘内容 hash（冲突判据的权威）；缺省 = 用注册表记的 sha256 */
  expectedSha256?: string
}

export interface OfficeDocuments {
  /**
   * 打开一份已授权的绝对路径：realpath 归一去重 → stat → 读字节（≤上限）→ sha256 → 入表。
   * 同 realpath + 同 owner 返回既有 documentId 且 `alreadyOpen:true`（不重读）。
   */
  open(filePath: string, context: OfficeOpenContext): Promise<OfficeOpenResult>
  /** 按 id 重读字节：复核 stat/size，刷新注册表版本；owner 不符/文件没了回分类失败 */
  read(documentId: string, owner: number): Promise<OfficeReadResult>
  /**
   * 保存到原文件（S3）：owner/只读/字节闸 → 冲突检测（mtime 快路径 + sha256 权威，写前比对
   * `expectedSha256`）→ 同目录临时文件原子写（wx/0o600/write+sync+close/rename/失败清理）→
   * 写后 stat 并更新注册表 size/mtime/sha。失败一律回分类结果，不抛。
   */
  save(documentId: string, owner: number, input: OfficeSaveInput): Promise<OfficeSaveResult>
  /**
   * 另存为（S3）：写目标路径（同样原子写）→ 注册表**重定向**到新真实路径（documentId 不变）。
   * 目标已被另一已打开文档占用 → `already-open-elsewhere`；目标后缀必须仍是 `.docx`。
   */
  saveAs(
    documentId: string,
    owner: number,
    targetPath: string,
    input: OfficeSaveInput
  ): Promise<OfficeSaveAsResult>
  /** 释放一个 id（幂等；未知 id / 非本窗口 id 不动表） */
  release(documentId: string, owner: number): boolean
  /** 释放某个 webContents 打开的全部文档（webContents destroyed 清算用）；返回释放条数 */
  releaseAll(owner: number): number
  /** 按 id 查只读信息（不重读文件；save-as 给对话框默认路径用），owner 不符回 null */
  info(documentId: string, owner: number): OfficeDocumentInfo | null
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

/**
 * 写失败 → 分类（errno 只进 detail，界面看人话）。照方案 §6.4：
 * EPERM/EBUSY（被 Word/WPS/杀软占用）→ write-locked；EACCES 同样按"写不了"归 write-locked；
 * ENOSPC → no-space；其余 → write-failed。
 */
function writeFailureOf(error: unknown): { code: OfficeErrorCode; detail: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  switch (code) {
    case 'ENOSPC':
      return { code: 'no-space', detail: '' }
    case 'EPERM':
    case 'EBUSY':
    case 'EACCES':
      return { code: 'write-locked', detail: code }
    default:
      return { code: 'write-failed', detail: code ?? '未知错误' }
  }
}

/** sha256（小写 hex）：冲突判据的权威 */
export function officeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 回包用的只读信息（剥掉 realPath / owner / 入口） */
function infoOf(record: OfficeDocumentRecord): OfficeDocumentInfo {
  return {
    documentId: record.documentId,
    kind: record.kind,
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

  // 写链路三个可注入点（单测伪造 EPERM/ENOSPC/rename 失败）
  const writeExclusive = io.writeFileExclusive ?? writeFileExclusiveAtomic
  const renameAtomic = io.rename ?? renameFileAtomic
  const unlinkTemp = io.unlink ?? unlinkQuiet

  /**
   * 同目录临时文件原子写（方案 §6.4 第 4 步）：
   * 建 `.kyclaw-office-<uuid>.tmp`（wx / 0o600）→ write + sync + close → rename 覆盖目标；
   * 任一步失败都清理临时文件并按分类回错，**绝不留下半截目标**。
   */
  async function atomicWrite(
    target: string,
    bytes: Uint8Array
  ): Promise<{ ok: true } | { ok: false; code: OfficeErrorCode; detail: string }> {
    const temp = join(dirname(target), `.kyclaw-office-${randomUUID()}.tmp`)
    try {
      await writeExclusive(temp, bytes)
    } catch (error) {
      await unlinkTemp(temp).catch(() => undefined)
      return { ok: false, ...writeFailureOf(error) }
    }
    try {
      await renameAtomic(temp, target)
    } catch (error) {
      await unlinkTemp(temp).catch(() => undefined)
      return { ok: false, ...writeFailureOf(error) }
    }
    return { ok: true }
  }

  /** 写后 stat：失败不回滚已成功的写（sha 仍是权威，mtime 只是缓存） */
  async function statAfterWrite(target: string): Promise<OfficeFileStat | null> {
    try {
      return await io.stat(target)
    } catch {
      return null
    }
  }

  /** 保存前置闸门（save / saveAs 共用）：owner、只读、字节形状/上限 */
  function saveTargetOf(
    documentId: string,
    owner: number,
    bytes: Uint8Array
  ): { record: OfficeDocumentRecord } | { failure: OfficeFailure } {
    const record = byId.get(documentId)
    if (record === undefined) return { failure: officeFailure('forbidden', '文档没有打开或已关闭') }
    if (record.owner !== owner) return { failure: officeFailure('forbidden') }
    if (record.readOnly) return { failure: officeFailure('forbidden', '这份文档以只读方式打开') }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return { failure: officeFailure('write-failed', '保存内容为空') }
    }
    if (bytes.length > maxBytes) return { failure: officeFailure('too-large') }
    return { record }
  }

  /**
   * 写前冲突检测（方案 §6.4 第 3 步）：mtime+size 快路径视为未变；失配时读盘算 sha ——
   * **hash 是权威**。磁盘内容与壳已知版本（expectedSha256，缺省 = 注册表记录的 sha）不一致 →
   * `conflict` + 磁盘版本；一致但 mtime/size 失配（时钟粒度/外部工具保留 mtime）→ 刷新基线继续写。
   */
  async function checkConflict(
    record: OfficeDocumentRecord,
    expectedSha256: string | undefined
  ): Promise<{ ok: true } | { ok: false; result: OfficeSaveResult | OfficeSaveAsResult }> {
    let before: OfficeFileStat
    try {
      before = await io.stat(record.realPath)
    } catch (error) {
      return {
        ok: false,
        result: officeFailure('unreadable', `文件已不在磁盘上（${fsDetail(error)}）`)
      }
    }
    if (!before.isFile) return { ok: false, result: officeFailure('unreadable', 'not-a-file') }

    const fastUnchanged = before.mtimeMs === record.mtimeMs && before.size === record.size
    const expected = expectedSha256 ?? record.sha256

    if (!fastUnchanged) {
      let diskBytes: Uint8Array
      try {
        diskBytes = await io.readFile(record.realPath)
      } catch (error) {
        return { ok: false, result: officeFailure('unreadable', fsDetail(error)) }
      }
      const diskSha = officeSha256(diskBytes)
      if (diskSha !== expected) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'conflict',
            message: OFFICE_EDITOR_ERROR_MESSAGES.conflict,
            disk: { mtimeMs: before.mtimeMs, sha256: diskSha, size: diskBytes.length }
          }
        }
      }
      // 内容没变、只是快路径失配：用磁盘真实值刷新基线后再写
      record.size = diskBytes.length
      record.mtimeMs = before.mtimeMs
      record.sha256 = diskSha
      return { ok: true }
    }

    // 快路径说没变，但壳手里的基线不是注册表记的那份 → 壳看到过别的版本，按冲突处理
    if (expectedSha256 !== undefined && expectedSha256 !== record.sha256) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'conflict',
          message: OFFICE_EDITOR_ERROR_MESSAGES.conflict,
          disk: { mtimeMs: record.mtimeMs, sha256: record.sha256, size: record.size }
        }
      }
    }
    return { ok: true }
  }

  return {
    async open(filePath, context) {
      // ① 格式闸门先于任何 IO：不支持的格式根本不该被读进内存
      const kind = officeEditorKindOfPath(filePath)
      if (kind === undefined) return officeFailure('unsupported-format')

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
        kind,
        realPath,
        displayName: context.displayName ?? basename(realPath),
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

    async save(documentId, owner, input) {
      const target = saveTargetOf(documentId, owner, input.bytes)
      if ('failure' in target) return target.failure
      const { record } = target

      const checked = await checkConflict(record, input.expectedSha256)
      if (!checked.ok) return checked.result as OfficeSaveResult

      const written = await atomicWrite(record.realPath, input.bytes)
      if (!written.ok) return officeFailure(written.code, written.detail)

      const after = await statAfterWrite(record.realPath)
      const sha256 = officeSha256(input.bytes)
      record.size = input.bytes.length
      record.sha256 = sha256
      if (after !== null) record.mtimeMs = after.mtimeMs
      return {
        ok: true,
        documentId: record.documentId,
        mtimeMs: record.mtimeMs,
        sha256,
        size: input.bytes.length,
        savedAt: Date.now()
      }
    },

    async saveAs(documentId, owner, targetPath, input) {
      const target = saveTargetOf(documentId, owner, input.bytes)
      if ('failure' in target) return target.failure
      const { record } = target
      if (officeEditorKindOfPath(targetPath) !== record.kind) {
        return officeFailure(
          'unsupported-format',
          record.kind === 'pptx'
            ? '另存为只支持 .pptx'
            : record.kind === 'xlsx'
              ? '另存为只支持 .xlsx'
              : '另存为只支持 .docx'
        )
      }

      // 目标真实路径：已存在文件走 realpath；新文件取"真实目录 + 文件名"（目录必须存在）
      let targetReal: string
      try {
        targetReal = await io.realpath(targetPath)
      } catch {
        try {
          targetReal = join(await io.realpath(dirname(targetPath)), basename(targetPath))
        } catch (error) {
          return officeFailure('unreadable', fsDetail(error))
        }
      }
      const occupied = byRealPath.get(targetReal)
      if (occupied !== undefined && occupied !== record) {
        return officeFailure('already-open-elsewhere')
      }

      const written = await atomicWrite(targetReal, input.bytes)
      if (!written.ok) return officeFailure(written.code, written.detail)

      const after = await statAfterWrite(targetReal)
      const sha256 = officeSha256(input.bytes)
      // 注册表重定向：documentId / owner / readOnly 不变，路径与版本信息换到新文件
      if (byRealPath.get(record.realPath) === record) byRealPath.delete(record.realPath)
      record.realPath = targetReal
      record.absolutePath = targetReal
      record.displayName = basename(targetReal)
      record.displayPath = targetPath
      record.size = input.bytes.length
      record.sha256 = sha256
      if (after !== null) record.mtimeMs = after.mtimeMs
      byRealPath.set(targetReal, record)
      return {
        ok: true,
        document: infoOf(record),
        mtimeMs: record.mtimeMs,
        sha256,
        size: input.bytes.length,
        savedAt: Date.now()
      }
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

    info(documentId, owner) {
      const record = byId.get(documentId)
      if (record === undefined || record.owner !== owner) return null
      return infoOf(record)
    },

    size() {
      return byId.size
    }
  }
}
