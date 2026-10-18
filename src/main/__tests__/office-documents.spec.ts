// @vitest-environment node
/**
 * `src/main/office-documents.ts`（M3-S2 文档注册表）聚焦单测。
 *
 * 覆盖方案 §6.2/§10.1-G2：realpath 去重、owner 校验、容量上限、错误分类、
 * release/releaseAll 生命周期、read 的 stat/hash 复核。
 *
 * 纪律：一个 Electron 都不起；临时目录都是本文件 `mkdtemp` 建的，收尾只删自己建的这些。
 * 真实文件覆盖绝大多数行为；>64MB / 读的时候文件在变这两类用注入 IO 伪造（不造巨型文件）。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOfficeDocuments,
  defaultOfficeDocumentIo,
  officeSha256,
  type OfficeDocumentIo
} from '../office-documents'
import { OFFICE_EDITOR_MAX_BYTES, OFFICE_MAX_OPEN_DOCUMENTS } from '../../shared/office-editor'

/** 本文件自建的临时目录（收尾只删这些） */
const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-documents-'))
  directories.push(directory)
  return directory
}

/** 落一份"看起来像 docx"的文件（注册表不解析 OOXML，只按扩展名 + 字节） */
function writeDocx(name: string, content = 'fake-docx-bytes'): string {
  const directory = tempDir()
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 造一个"真实路径 + 可伪造部分行为"的 IO */
function ioWith(overrides: Partial<OfficeDocumentIo>): OfficeDocumentIo {
  return { ...defaultOfficeDocumentIo, ...overrides }
}

describe('open：realpath 去重与回包形状', () => {
  it('同一真实文件第二次打开返回同一个 documentId + alreadyOpen（不重读）', async () => {
    const path = writeDocx('方案.docx', 'hello-docx')
    const docs = createOfficeDocuments()
    const readSpy = vi.spyOn(defaultOfficeDocumentIo, 'readFile')

    const first = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.alreadyOpen).toBe(false)
    expect(first.document.documentId.length).toBeGreaterThan(0)
    expect(first.document.kind).toBe('docx')
    expect(first.document.displayName).toBe('方案.docx')
    expect(first.document.displayPath).toBe(path)
    expect(first.document.size).toBe(10)
    expect(first.document.sha256).toBe(sha256OfFile(path))
    expect(first.document.readOnly).toBe(false)

    const second = await docs.open(path, {
      owner: 1,
      openedFrom: 'session',
      displayPath: '方案.docx'
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.document.documentId).toBe(first.document.documentId)
    expect(second.alreadyOpen).toBe(true)
    // 去重命中不重新读字节
    expect(readSpy).toHaveBeenCalledTimes(1)
    expect(docs.size()).toBe(1)
  })

  it('Windows 上大小写不同的同一路径也是同一个 documentId（realpath native 归一）', async () => {
    const path = writeDocx('Case.docx', 'case-bytes')
    const docs = createOfficeDocuments()

    const first = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const variant = process.platform === 'win32' ? path.toUpperCase() : path
    const second = await docs.open(variant, { owner: 1, openedFrom: 'picker' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.document.documentId).toBe(first.document.documentId)
    expect(second.alreadyOpen).toBe(true)
  })

  it('同一个 realpath 被另一个 owner 打开：拒绝（already-open-elsewhere），表里不动', async () => {
    const path = writeDocx('共享.docx')
    const docs = createOfficeDocuments()
    const first = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(first.ok).toBe(true)

    const second = await docs.open(path, { owner: 2, openedFrom: 'session' })
    expect(second).toMatchObject({ ok: false, code: 'already-open-elsewhere' })
    expect(docs.size()).toBe(1)
  })

  it('只读打开如实回 readOnly；displayPath 可用会话相对路径覆盖', async () => {
    const path = writeDocx('只读.docx')
    const docs = createOfficeDocuments()
    const result = await docs.open(path, {
      owner: 1,
      openedFrom: 'session',
      readOnly: true,
      displayPath: '子目录/只读.docx'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.readOnly).toBe(true)
    expect(result.document.displayPath).toBe('子目录/只读.docx')
  })
})

describe('M4-X：kind 矩阵（docx / xlsx；pptx 在 M4-P 前仍拒绝）', () => {
  it('打开 .xlsx → kind=xlsx；read 回包同 kind；同 realpath 去重不重读', async () => {
    const path = writeDocx('预算.xlsx', 'fake-xlsx-bytes')
    const docs = createOfficeDocuments()
    const first = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.document.kind).toBe('xlsx')
    expect(first.document.displayName).toBe('预算.xlsx')

    const read = await docs.read(first.document.documentId, 1)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.document.kind).toBe('xlsx')
    expect(read.bytes.length).toBe('fake-xlsx-bytes'.length)

    const second = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(second).toMatchObject({
      ok: true,
      alreadyOpen: true,
      document: { kind: 'xlsx', documentId: first.document.documentId }
    })
  })

  it('pptx 仍 unsupported-format（不接幽灵格式）', async () => {
    const path = writeDocx('幻灯片.pptx', 'fake-pptx')
    const realpath = vi.fn(defaultOfficeDocumentIo.realpath)
    const docs = createOfficeDocuments(ioWith({ realpath }))
    const result = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-format' })
    expect(realpath).not.toHaveBeenCalled()
  })
})

describe('open：错误分类（格式 / 大小 / 读不了 / 容量）', () => {
  it('非 .docx：unsupported-format，且不碰文件系统', async () => {
    const path = writeDocx('方案.txt', 'not-a-docx')
    const realpath = vi.fn(defaultOfficeDocumentIo.realpath)
    const stat = vi.fn(defaultOfficeDocumentIo.stat)
    const readFile = vi.fn(defaultOfficeDocumentIo.readFile)
    const docs = createOfficeDocuments(ioWith({ realpath, stat, readFile }))

    const result = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-format' })
    expect(realpath).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(docs.size()).toBe(0)
  })

  it('超过 64MB：too-large，且不把文件读进内存', async () => {
    const path = writeDocx('巨型.docx')
    const readFile = vi.fn(defaultOfficeDocumentIo.readFile)
    const docs = createOfficeDocuments(
      ioWith({
        stat: async () => ({ size: OFFICE_EDITOR_MAX_BYTES + 1, mtimeMs: 1, isFile: true }),
        readFile
      })
    )

    const result = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(result).toMatchObject({ ok: false, code: 'too-large' })
    expect(readFile).not.toHaveBeenCalled()
    expect(docs.size()).toBe(0)
  })

  it('文件不存在 / 不是普通文件：unreadable（带 errno 分类，不带路径）', async () => {
    const docs = createOfficeDocuments()
    const missingPath = join(tempDir(), '不存在.docx')
    const missing = await docs.open(missingPath, { owner: 1, openedFrom: 'picker' })
    expect(missing).toMatchObject({ ok: false, code: 'unreadable' })
    if (!missing.ok) {
      expect(missing.message).toContain('ENOENT')
      expect(missing.message).not.toContain(missingPath)
    }

    const notFile = join(tempDir(), '目录.docx')
    const notFileDocs = createOfficeDocuments(
      ioWith({
        realpath: async () => notFile,
        stat: async () => ({ size: 0, mtimeMs: 0, isFile: false })
      })
    )
    expect(await notFileDocs.open(notFile, { owner: 1, openedFrom: 'picker' })).toMatchObject({
      ok: false,
      code: 'unreadable'
    })
  })

  it('读文件失败：unreadable；读的当口文件在变（长度对不上 stat）：conflict', async () => {
    const path = writeDocx('读失败.docx', 'abcdef')
    const failing = createOfficeDocuments(
      ioWith({
        readFile: async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
      })
    )
    expect(await failing.open(path, { owner: 1, openedFrom: 'picker' })).toMatchObject({
      ok: false,
      code: 'unreadable'
    })

    const changing = createOfficeDocuments(ioWith({ readFile: async () => new Uint8Array(5) }))
    expect(await changing.open(path, { owner: 1, openedFrom: 'picker' })).toMatchObject({
      ok: false,
      code: 'conflict'
    })
  })

  it('容量上限（默认 24）：超限回 too-many-open；释放一个后可以继续打开', async () => {
    expect(OFFICE_MAX_OPEN_DOCUMENTS).toBe(24)
    const docs = createOfficeDocuments(undefined, { maxOpenDocuments: 2 })
    const first = await docs.open(writeDocx('a.docx'), { owner: 1, openedFrom: 'picker' })
    const second = await docs.open(writeDocx('b.docx'), { owner: 1, openedFrom: 'picker' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok) return

    const third = await docs.open(writeDocx('c.docx'), { owner: 1, openedFrom: 'picker' })
    expect(third).toMatchObject({ ok: false, code: 'too-many-open' })

    expect(docs.release(first.document.documentId, 1)).toBe(true)
    const retried = await docs.open(writeDocx('d.docx'), { owner: 1, openedFrom: 'picker' })
    expect(retried.ok).toBe(true)
    expect(docs.size()).toBe(2)
  })
})

describe('read：按 id 重读 + stat/hash 复核', () => {
  it('读回字节与 open 时的 sha256 一致；外部改动后 read 刷新版本而不是交旧快照', async () => {
    const path = writeDocx('版本.docx', 'v1-content')
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 7, openedFrom: 'picker' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const first = await docs.read(opened.document.documentId, 7)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(Buffer.from(first.bytes).toString('utf8')).toBe('v1-content')
    expect(first.document.sha256).toBe(officeSha256(new TextEncoder().encode('v1-content')))

    writeFileSync(path, 'v2-longer-content')
    const second = await docs.read(opened.document.documentId, 7)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(Buffer.from(second.bytes).toString('utf8')).toBe('v2-longer-content')
    expect(second.document.sha256).toBe(officeSha256(second.bytes))
    expect(second.document.size).toBe(17)
  })

  it('owner 不一致 / 未知 id：forbidden；释放后 read 也回 forbidden', async () => {
    const docs = createOfficeDocuments()
    const opened = await docs.open(writeDocx('owner.docx'), { owner: 1, openedFrom: 'picker' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const id = opened.document.documentId

    expect(await docs.read(id, 2)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await docs.read('not-a-document', 1)).toMatchObject({ ok: false, code: 'forbidden' })

    expect(docs.release(id, 1)).toBe(true)
    expect(await docs.read(id, 1)).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('文件被删：read 回 unreadable；读的时候变大超限：too-large', async () => {
    const path = writeDocx('会消失.docx', 'content')
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    rmSync(path)
    expect(await docs.read(opened.document.documentId, 1)).toMatchObject({
      ok: false,
      code: 'unreadable'
    })

    // 前两次 stat 是 open 的"读前/读后"，之后的 stat 假装文件已超限（read 阶段闸门）
    const growingPath = writeDocx('变大.docx', 'small')
    let statCalls = 0
    const growing = createOfficeDocuments(
      ioWith({
        stat: async (target) => {
          statCalls += 1
          const info = await defaultOfficeDocumentIo.stat(target)
          return statCalls <= 2
            ? info
            : { size: OFFICE_EDITOR_MAX_BYTES + 1, mtimeMs: info.mtimeMs, isFile: true }
        }
      })
    )
    const growingOpened = await growing.open(growingPath, { owner: 1, openedFrom: 'picker' })
    expect(growingOpened.ok).toBe(true)
    if (!growingOpened.ok) return
    expect(await growing.read(growingOpened.document.documentId, 1)).toMatchObject({
      ok: false,
      code: 'too-large'
    })
  })
})

describe('release / releaseAll：幂等、按 owner 清算', () => {
  it('release 未知 id / 重复释放是空操作；releaseAll 只清本 owner 的', async () => {
    const docs = createOfficeDocuments()
    const a = await docs.open(writeDocx('a.docx'), { owner: 1, openedFrom: 'picker' })
    const b = await docs.open(writeDocx('b.docx'), { owner: 1, openedFrom: 'picker' })
    const c = await docs.open(writeDocx('c.docx'), { owner: 2, openedFrom: 'picker' })
    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return

    expect(docs.release('unknown', 1)).toBe(false)
    expect(docs.release(a.document.documentId, 2)).toBe(false)
    expect(docs.size()).toBe(3)

    expect(docs.release(a.document.documentId, 1)).toBe(true)
    expect(docs.release(a.document.documentId, 1)).toBe(false)

    expect(docs.releaseAll(1)).toBe(1)
    expect(docs.size()).toBe(1)
    expect(docs.releaseAll(1)).toBe(0)
    expect(await docs.read(c.document.documentId, 2)).toMatchObject({ ok: true })
    expect(await docs.read(b.document.documentId, 1)).toMatchObject({ ok: false })
  })
})
