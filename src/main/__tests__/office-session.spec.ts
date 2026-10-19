import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICE_SESSION_RESTORE_LIMIT,
  officeSessionPath,
  planOfficeSessionRestore,
  readOfficeSession,
  writeOfficeSession,
  type OfficeSession
} from '../office-session'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-office-session-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tab(
  id: string,
  overrides: Partial<OfficeSession['tabs'][number]> = {}
): OfficeSession['tabs'][number] {
  return {
    documentId: id,
    realPath: `C:\\docs\\${id}.docx`,
    kind: 'docx' as const,
    readOnly: false,
    dirty: false,
    sha256: `sha-${id}`,
    ...overrides
  }
}
function session(tabs: OfficeSession['tabs'], active: string | null = null): OfficeSession {
  return { version: 1, savedAt: new Date(0).toISOString(), activeDocumentId: active, tabs }
}

describe('office-session 文件层', () => {
  it('原子写可读回；temp 文件不残留；路径在 userData 下', () => {
    const dir = tempDir()
    const path = officeSessionPath(dir)
    expect(path.endsWith('office-session.json')).toBe(true)
    expect(writeOfficeSession(path, session([tab('a')], 'a'))).toBe(true)
    expect(readOfficeSession(path)).toEqual(session([tab('a')], 'a'))
    expect(() => readFileSync(`${path}.tmp-${String(process.pid)}`)).toThrow()
  })

  it('坏文件 / 错 schema / 超版本 → null（静默）', () => {
    const dir = tempDir()
    const path = officeSessionPath(dir)
    writeFileSync(path, '{oops')
    expect(readOfficeSession(path)).toBeNull()
    writeFileSync(path, JSON.stringify({ version: 2, tabs: [] }))
    expect(readOfficeSession(path)).toBeNull()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        savedAt: 'x',
        activeDocumentId: null,
        tabs: [{ documentId: '' }]
      })
    )
    expect(readOfficeSession(path)).toBeNull()
  })

  it('写失败（路径是目录）静默返回 false，不抛', () => {
    const dir = tempDir()
    expect(writeOfficeSession(dir, session([]))).toBe(false)
  })
})

describe('office-session 恢复计划（D19）', () => {
  const disk =
    (sha: string | undefined = undefined) =>
    (realPath: string) => {
      if (realPath.includes('missing')) return { exists: false }
      return {
        exists: true,
        sha256: sha ?? realPath.replace(/^.*\\/, 'sha-').replace(/\.docx$/, '')
      }
    }

  it('恢复上限 3；超出计入 skipped', () => {
    const tabs = ['a', 'b', 'c', 'd', 'e'].map((id) => tab(id))
    const plan = planOfficeSessionRestore(session(tabs, 'd'), disk('sha-a'))
    expect(plan.restorable).toHaveLength(OFFICE_SESSION_RESTORE_LIMIT)
    expect(plan.restorable.map((t) => t.documentId)).toEqual(['a', 'b', 'c'])
    expect(plan.skipped).toBe(2)
    expect(plan.activeDocumentId).toBe('a') // active 不在恢复集 → 首个
  })

  it('脏内容不恢复、不再冒充；缺失文件 skipped；active 保留', () => {
    const plan = planOfficeSessionRestore(
      session([tab('a', { dirty: true }), tab('b'), tab('missing-doc')], 'b'),
      disk()
    )
    expect(plan.restorable.map((t) => t.documentId)).toEqual(['b'])
    expect(plan.skipped).toBe(2)
    expect(plan.modifiedOnDisk).toBe(0)
    expect(plan.activeDocumentId).toBe('b')
  })

  it('关闭期间外部修改：sha 不同 → 可恢复但计入 modifiedOnDisk', () => {
    const plan = planOfficeSessionRestore(session([tab('a'), tab('b')]), (realPath) =>
      realPath.includes('a')
        ? { exists: true, sha256: 'changed' }
        : { exists: true, sha256: 'sha-b' }
    )
    expect(plan.restorable).toHaveLength(2)
    expect(plan.modifiedOnDisk).toBe(1)
    expect(plan.skipped).toBe(0)
  })

  it('空 session → 0 恢复、active null', () => {
    const plan = planOfficeSessionRestore(session([]), () => null)
    expect(plan).toEqual({ restorable: [], modifiedOnDisk: 0, skipped: 0, activeDocumentId: null })
  })
})
