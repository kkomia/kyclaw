// @vitest-environment node
/**
 * `src/main/office-documents.ts` 的**保存链路**（M3-S3）：原子写 / 写前冲突检测 / 错误分类 /
 * save-as 重定向。一个 Electron 对象都不碰：正常路径用真临时文件（真 fs、真 sha256），
 * 写失败路径注入 `OfficeDocumentIo` 的写三点（writeFileExclusive / rename / unlink）模拟
 * EPERM / ENOSPC / rename 失败。
 *
 * 对应方案 §6.4 的六步：授权(owner/只读) → 字节闸 → 冲突检测(mtime 快路径 + sha 权威) →
 * 临时文件原子写(wx/0o600/write+sync+close/rename/失败清理) → 写后更新 stat/sha → 错误分类。
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOfficeDocuments,
  defaultOfficeDocumentIo,
  officeSha256,
  type OfficeDocumentIo
} from '../office-documents'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kyclaw-office-save-'))
  directories.push(directory)
  return directory
}

/** 写一份 docx（内容是什么不重要：S3 的写链路不解析 OOXML） */
function writeDocx(directory: string, name = '方案.docx', content = '原始字节-A'): string {
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

/** 打开一份文档并返回 registry + documentId（owner = 1） */
async function openDocument(options: { maxBytes?: number; io?: OfficeDocumentIo } = {}): Promise<{
  docs: ReturnType<typeof createOfficeDocuments>
  path: string
  directory: string
  documentId: string
  sha256: string
}> {
  const directory = tempDir()
  const path = writeDocx(directory)
  const docs = createOfficeDocuments(options.io ?? defaultOfficeDocumentIo, options)
  const opened = await docs.open(path, { owner: 1, openedFrom: 'picker' })
  if (!opened.ok) throw new Error(`打开失败：${opened.code}`)
  return {
    docs,
    path,
    directory,
    documentId: opened.document.documentId,
    sha256: opened.document.sha256
  }
}

describe('save：正常路径（真临时文件原子写 + 写后更新 stat/sha）', () => {
  it('写盘成功：磁盘字节变化、回包 sha/size 正确、注册表 read 拿到新内容、临时文件已清理', async () => {
    const { docs, path, directory, documentId } = await openDocument()
    const next = Buffer.from('保存后的新字节-B')
    const result = await docs.save(documentId, 1, {
      bytes: next,
      expectedSha256: officeSha256(Buffer.from('原始字节-A'))
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.documentId).toBe(documentId)
    expect(result.sha256).toBe(officeSha256(next))
    expect(result.size).toBe(next.byteLength)
    expect(result.mtimeMs).toBeGreaterThan(0)
    // 进程外视角：磁盘上就是刚写的字节；目录里没有残留的临时文件
    expect(readFileSync(path, 'utf8')).toBe('保存后的新字节-B')
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // 注册表也刷新了：read 回新字节与新 sha
    const read = await docs.read(documentId, 1)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(Buffer.from(read.bytes).toString('utf8')).toBe('保存后的新字节-B')
    expect(read.document.sha256).toBe(result.sha256)
  })

  it('不带 expectedSha256 时以注册表记录的 sha 为基线，也能成功保存', async () => {
    const { docs, documentId } = await openDocument()
    const result = await docs.save(documentId, 1, { bytes: Buffer.from('再存一次') })
    expect(result).toMatchObject({ ok: true })
  })

  it('字节上限：超过 maxBytes 的保存被拒，磁盘不动', async () => {
    const directory = tempDir()
    const path = writeDocx(directory, '方案.docx', 'a')
    const docs = createOfficeDocuments(undefined, { maxBytes: 8 })
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    if (!opened.ok) throw new Error(`打开失败：${opened.code}`)
    const result = await docs.save(opened.document.documentId, 1, { bytes: Buffer.alloc(9, 1) })
    expect(result).toMatchObject({ ok: false, code: 'too-large' })
    expect(readFileSync(path, 'utf8')).toBe('a')
  })

  it('owner 不一致 / 未知 documentId / 只读文档：forbidden，磁盘不动', async () => {
    const directory = tempDir()
    const path = writeDocx(directory)
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker', readOnly: true })
    if (!opened.ok) throw new Error('打开失败')

    expect(
      await docs.save(opened.document.documentId, 2, { bytes: Buffer.from('x') })
    ).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await docs.save('missing-id', 1, { bytes: Buffer.from('x') })).toMatchObject({
      ok: false,
      code: 'forbidden'
    })
    expect(
      await docs.save(opened.document.documentId, 1, { bytes: Buffer.from('x') })
    ).toMatchObject({ ok: false, code: 'forbidden' })
    expect(readFileSync(path, 'utf8')).toBe('原始字节-A')
  })
})

describe('save：写前冲突检测（mtime 快路径 + sha256 权威 + expectedSha256）', () => {
  it('外部改内容（size 也变）：expectedSha256 对不上 → conflict + disk 版本，绝不覆盖磁盘', async () => {
    const { docs, path, documentId, sha256 } = await openDocument()
    writeFileSync(path, '外部改过的内容-很长很长')

    const result = await docs.save(documentId, 1, {
      bytes: Buffer.from('我要覆盖'),
      expectedSha256: sha256
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('conflict')
    expect(result.disk?.sha256).toBe(officeSha256(Buffer.from('外部改过的内容-很长很长')))
    // 冲突时绝不写盘（不能把外部改动冲掉）
    expect(readFileSync(path, 'utf8')).toBe('外部改过的内容-很长很长')
  })

  it('外部只 touch mtime（内容没变）：hash 权威判为未变，保存成功', async () => {
    const { docs, path, documentId } = await openDocument()
    // 改 mtime：先写同内容（size 不变、mtime 变）——快路径失配，但 sha 相同
    writeFileSync(path, '原始字节-A')
    // 确保 mtime 真的前进（部分文件系统时间粒度粗）
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(path, '原始字节-A')

    const result = await docs.save(documentId, 1, { bytes: Buffer.from('新内容-C') })
    expect(result).toMatchObject({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe('新内容-C')
  })

  it('快路径说没变、但壳的 expectedSha256 不是注册表那份 → conflict（壳看到过别的版本）', async () => {
    const { docs, documentId } = await openDocument()
    const result = await docs.save(documentId, 1, {
      bytes: Buffer.from('新内容'),
      expectedSha256: 'f'.repeat(64)
    })
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('文件被删：save 回 unreadable（可另存为），不会凭空创建', async () => {
    const { docs, path, documentId } = await openDocument()
    rmSync(path)
    const result = await docs.save(documentId, 1, { bytes: Buffer.from('x') })
    expect(result).toMatchObject({ ok: false, code: 'unreadable' })
  })
})

describe('save：写失败分类 + 临时文件清理（注入写三点）', () => {
  /** 用真 fs 做读/stat，只替换写三点 */
  function ioWithFaults(fault: {
    writeError?: NodeJS.ErrnoException
    renameError?: NodeJS.ErrnoException
  }): {
    io: OfficeDocumentIo
    tempFiles: string[]
    unlinked: string[]
  } {
    const tempFiles: string[] = []
    const unlinked: string[] = []
    const io: OfficeDocumentIo = {
      ...defaultOfficeDocumentIo,
      writeFileExclusive: async (filePath, bytes) => {
        tempFiles.push(filePath)
        if (fault.writeError) throw fault.writeError
        await defaultOfficeDocumentIo.writeFileExclusive?.(filePath, bytes)
      },
      rename: async (from, to) => {
        if (fault.renameError) throw fault.renameError
        await defaultOfficeDocumentIo.rename?.(from, to)
      },
      unlink: async (filePath) => {
        unlinked.push(filePath)
        await defaultOfficeDocumentIo.unlink?.(filePath)
      }
    }
    return { io, tempFiles, unlinked }
  }

  it('EPERM（被占用/只读）→ write-locked；目标不动、临时目录清空', async () => {
    const error = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    const { io, tempFiles, unlinked } = ioWithFaults({ writeError: error })
    const { docs, path, documentId } = await openDocument({ io })

    const result = await docs.save(documentId, 1, { bytes: Buffer.from('x') })
    expect(result).toMatchObject({ ok: false, code: 'write-locked' })
    expect(readFileSync(path, 'utf8')).toBe('原始字节-A')
    expect(tempFiles).toHaveLength(1)
    expect(tempFiles[0]?.endsWith('.tmp')).toBe(true)
    expect(unlinked).toEqual(tempFiles)
  })

  it('ENOSPC → no-space；rename 失败 → write-failed，且都不留半截目标', async () => {
    const enospc = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    const first = ioWithFaults({ writeError: enospc })
    const opened = await openDocument({ io: first.io })
    expect(await opened.docs.save(opened.documentId, 1, { bytes: Buffer.from('x') })).toMatchObject(
      { ok: false, code: 'no-space' }
    )

    const renameFail = Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    const second = ioWithFaults({ renameError: renameFail })
    const opened2 = await openDocument({ io: second.io })
    expect(
      await opened2.docs.save(opened2.documentId, 1, { bytes: Buffer.from('y') })
    ).toMatchObject({ ok: false, code: 'write-failed' })
    expect(readFileSync(opened2.path, 'utf8')).toBe('原始字节-A')
    expect(second.unlinked).toEqual(second.tempFiles)
  })
})

describe('saveAs：写新落点 + 注册表重定向', () => {
  it('写到新文件：返回重定向后的 document（同名新路径/sha），旧路径释放、新路径接管', async () => {
    const { docs, directory, documentId } = await openDocument()
    const target = join(directory, '另存为-方案.docx')
    const next = Buffer.from('另存为的字节')

    const result = await docs.saveAs(documentId, 1, target, { bytes: next })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.documentId).toBe(documentId)
    expect(result.document.displayName).toBe('另存为-方案.docx')
    // absolutePath 是 realpath 归一后的路径（Windows 上 tmpdir 短名会展开成长名）
    expect(result.document.absolutePath).toBe(realpathSync.native(target))
    expect(result.document.sha256).toBe(officeSha256(next))
    expect(readFileSync(target, 'utf8')).toBe('另存为的字节')

    // 注册表已重定向：read 拿到新字节；info 的路径也是新文件
    const read = await docs.read(documentId, 1)
    expect(read.ok).toBe(true)
    if (read.ok) expect(Buffer.from(read.bytes).toString('utf8')).toBe('另存为的字节')
    expect(docs.info(documentId, 1)?.absolutePath).toBe(realpathSync.native(target))
  })

  it('M4-X：xlsx 只能另存为 .xlsx；重定向后 kind 保持 xlsx', async () => {
    const directory = tempDir()
    const path = writeDocx(directory, '预算.xlsx', '原始表格字节')
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.document.kind).toBe('xlsx')

    expect(
      await docs.saveAs(opened.document.documentId, 1, join(directory, '错后缀.docx'), {
        bytes: Buffer.from('x')
      })
    ).toMatchObject({ ok: false, code: 'unsupported-format' })

    const target = join(directory, '另存预算.xlsx')
    const result = await docs.saveAs(opened.document.documentId, 1, target, {
      bytes: Buffer.from('新表格字节')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.kind).toBe('xlsx')
    expect(result.document.displayName).toBe('另存预算.xlsx')
    expect(readFileSync(target, 'utf8')).toBe('新表格字节')
  })

  it('M4-P：pptx 只能另存为 .pptx；重定向后 kind 保持 pptx', async () => {
    const directory = tempDir()
    const path = writeDocx(directory, '幻灯片.pptx', '原始演示字节')
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker' })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.document.kind).toBe('pptx')

    for (const wrong of ['错后缀.docx', '错后缀.xlsx']) {
      expect(
        await docs.saveAs(opened.document.documentId, 1, join(directory, wrong), {
          bytes: Buffer.from('x')
        })
      ).toMatchObject({ ok: false, code: 'unsupported-format' })
    }

    const target = join(directory, '另存幻灯片.pptx')
    const result = await docs.saveAs(opened.document.documentId, 1, target, {
      bytes: Buffer.from('新演示字节')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.kind).toBe('pptx')
    expect(result.document.displayName).toBe('另存幻灯片.pptx')
    expect(readFileSync(target, 'utf8')).toBe('新演示字节')
  })

  it('目标后缀不是 docx / 目标已被另一个已打开文档占用 → 分类失败，不写文件', async () => {
    const { docs, directory, documentId } = await openDocument()
    expect(
      await docs.saveAs(documentId, 1, join(directory, 'x.txt'), { bytes: Buffer.from('x') })
    ).toMatchObject({ ok: false, code: 'unsupported-format' })

    // 另一个文档打开 target，再把它当 saveAs 目标
    const occupiedPath = writeDocx(directory, '已被占用.docx', 'occupied')
    const otherOwner = createOfficeDocuments()
    const other = await otherOwner.open(occupiedPath, { owner: 2, openedFrom: 'picker' })
    expect(other.ok).toBe(true)
    // 同一真实文件在另一个 registry 里不算本 registry 的占用；用本 registry 自己再开一份才能测
    const again = await docs.open(occupiedPath, { owner: 1, openedFrom: 'picker' })
    expect(again.ok).toBe(true)
    const result = await docs.saveAs(documentId, 1, occupiedPath, { bytes: Buffer.from('x') })
    expect(result).toMatchObject({ ok: false, code: 'already-open-elsewhere' })
    expect(readFileSync(occupiedPath, 'utf8')).toBe('occupied')
  })

  it('owner 不一致 / 只读文档：forbidden；saveAs 也走同一套前置闸门', async () => {
    const directory = tempDir()
    const path = writeDocx(directory)
    const docs = createOfficeDocuments()
    const opened = await docs.open(path, { owner: 1, openedFrom: 'picker', readOnly: true })
    if (!opened.ok) throw new Error('打开失败')
    expect(
      await docs.saveAs(opened.document.documentId, 2, join(directory, 'a.docx'), {
        bytes: Buffer.from('x')
      })
    ).toMatchObject({ ok: false, code: 'forbidden' })
    expect(
      await docs.saveAs(opened.document.documentId, 1, join(directory, 'a.docx'), {
        bytes: Buffer.from('x')
      })
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('另存为到原路径（同文件）等价于覆盖保存', async () => {
    const { docs, path, documentId } = await openDocument()
    const result = await docs.saveAs(documentId, 1, path, { bytes: Buffer.from('原地覆盖') })
    expect(result).toMatchObject({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe('原地覆盖')
  })
})

describe('info：只读信息查询（owner 校验）', () => {
  it('info 只回 owner 自己的条目；未知 id / 别的 owner 回 null', async () => {
    const { docs, documentId } = await openDocument()
    expect(docs.info(documentId, 1)?.documentId).toBe(documentId)
    expect(docs.info(documentId, 2)).toBeNull()
    expect(docs.info('missing', 1)).toBeNull()
  })
})

describe('原子写实现细节（默认 IO）', () => {
  it('写入过程先落临时文件再 rename：成功后目录里只有目标文件，且内容完整', async () => {
    const { docs, path, directory, documentId } = await openDocument()
    await docs.save(documentId, 1, { bytes: Buffer.from('完整内容') })
    const names = readdirSync(directory).sort()
    expect(names).toEqual(['方案.docx'])
    expect(readFileSync(path, 'utf8')).toBe('完整内容')
  })

  it('writeFileExclusive 用 wx 独占创建：已存在的临时名不会覆盖（单测直接打默认实现）', async () => {
    const directory = tempDir()
    const probe = join(directory, 'probe.tmp')
    writeFileSync(probe, 'existing')
    await expect(
      defaultOfficeDocumentIo.writeFileExclusive?.(probe, Buffer.from('new'))
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(probe, 'utf8')).toBe('existing')
    // vi 只是占位，保证本文件有 mock 依赖被收集时不报错
    expect(vi.isMockFunction(vi.fn())).toBe(true)
  })
})
