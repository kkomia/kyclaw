/**
 * M4-T 标签持久化（主进程）：userData/office-session.json。
 *
 * 语义（PLAN D19）：只存主进程元数据；恢复上限 3；按磁盘版本恢复（脏内容不冒充）；
 * 关闭期间文件被外部修改 → sha 差异计数；原子写（temp+rename）；坏文件/写失败静默。
 * 该模块**只做文件层**，不直接依赖注册表：调用方把当前打开项（含 realPath/sha）传进来。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export const OFFICE_SESSION_RESTORE_LIMIT = 3
export const OFFICE_SESSION_MAX_ENTRIES = 24
export const OFFICE_SESSION_FILE = 'office-session.json'

export const officeSessionTabSchema = z.strictObject({
  documentId: z.string().min(1),
  realPath: z.string().min(1),
  kind: z.enum(['docx', 'xlsx', 'pptx']),
  readOnly: z.boolean(),
  dirty: z.boolean(),
  sha256: z.string().min(1)
})
export type OfficeSessionTab = z.infer<typeof officeSessionTabSchema>

export const officeSessionSchema = z.strictObject({
  version: z.literal(1),
  savedAt: z.string().min(1),
  activeDocumentId: z.string().min(1).nullable(),
  tabs: z.array(officeSessionTabSchema).max(OFFICE_SESSION_MAX_ENTRIES)
})
export type OfficeSession = z.infer<typeof officeSessionSchema>

/** 写：temp 同目录 → rename；任何失败静默（返回 false，不抛）。 */
export function writeOfficeSession(filePath: string, session: OfficeSession): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${String(process.pid)}`
    writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      rmSync(`${filePath}.tmp-${String(process.pid)}`, { force: true })
    } catch {
      /* 静默 */
    }
    return false
  }
}

/** 读：坏文件/超版本/字段不符 → null（调用方静默忽略，可选删除）。 */
export function readOfficeSession(filePath: string): OfficeSession | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    const result = officeSessionSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export interface RestoreCandidate {
  documentId: string
  realPath: string
  kind: 'docx' | 'xlsx' | 'pptx'
  readOnly: boolean
  dirty: boolean
  sha256: string
}

export interface RestorePlan {
  /** 可恢复（≤3，已剔除脏/缺失/已打开） */
  restorable: RestoreCandidate[]
  /** 关闭期间被外部修改（sha 不同） */
  modifiedOnDisk: number
  /** 未恢复：超上限 + 脏 + 路径不存在 + 其他原因 */
  skipped: number
  activeDocumentId: string | null
}

/**
 * 由 session + 当前磁盘事实生成恢复计划：
 * - dirty 项永不恢复（不冒充），计入 skipped；
 * - 不存在（exists=false）计入 skipped；
 * - sha 与 session 不同 → 可恢复（按磁盘版本），计入 modifiedOnDisk；
 * - 上限 3，超出计入 skipped；active 在 restorable 内才保留。
 */
export function planOfficeSessionRestore(
  session: OfficeSession,
  disk: (realPath: string) => { exists: boolean; sha256?: string } | null
): RestorePlan {
  const restorable: RestoreCandidate[] = []
  let modifiedOnDisk = 0
  let skipped = 0
  for (const tab of session.tabs) {
    if (restorable.length >= OFFICE_SESSION_RESTORE_LIMIT) {
      skipped += 1
      continue
    }
    if (tab.dirty) {
      skipped += 1
      continue
    }
    const fact = disk(tab.realPath)
    if (fact === null || !fact.exists) {
      skipped += 1
      continue
    }
    if (fact.sha256 !== undefined && fact.sha256 !== tab.sha256) modifiedOnDisk += 1
    restorable.push(tab)
  }
  const activeDocumentId =
    session.activeDocumentId !== null &&
    restorable.some((tab) => tab.documentId === session.activeDocumentId)
      ? session.activeDocumentId
      : (restorable[0]?.documentId ?? null)
  return { restorable, modifiedOnDisk, skipped, activeDocumentId }
}

/** 会话目录下的默认文件路径。 */
export function officeSessionPath(userDataDir: string): string {
  return join(userDataDir, OFFICE_SESSION_FILE)
}
