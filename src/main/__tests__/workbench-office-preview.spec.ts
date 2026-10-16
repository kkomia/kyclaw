// @vitest-environment node
/**
 * 办公档预览的**接线层**（`main/workbench-files.ts` 的 `convertOfficeToPdf` / `readFileBounded`）：
 * 授权闸门、有界读、读取前后的真实路径与身份复验、取消。
 *
 * 这一份回答"引擎之外"的事（引擎本身由 `office-preview.spec.ts` 打）：
 *   - **授权**：越权抛人话；后缀白名单；存在性 / 目录 / 链接 / 32MB 上限；
 *   - **有界读**：上限之外一个字节都不读（不是"全读进来再 slice"）；
 *   - **源一致性**：授权之后文件被长大 / 截短 / 同大小改写 / 换成链接或目录时，
 *     一律 `source-changed`（读都没读，或读到了也不交出去）；
 *   - **取消**：请求信号响了回 `cancelled`（不是 reject），读循环里也在看信号。
 *
 * 假引擎只做一件事：`convert` 被叫到时按需触发一次 `request.source.read(...)` 并记录结果 ——
 * 一个真进程都不起，一份真引擎都不碰。
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  linkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderDocx } from '../../mastra/tools/docx'
import { PREVIEW_OFFICE_MAX_BYTES } from '../../shared/workbench'
import { OfficePreviewError } from '../../shared/office-preview'
import { convertOfficeToPdf, readFileBounded, type BoundedFileRead } from '../workbench-files'
import type {
  OfficePreviewConversion,
  OfficePreviewRequest,
  OfficePreviewService
} from '../office-preview'

/** 一份真的最小 PDF（回包里的字节） */
const PDF = Buffer.from('%PDF-1.7\nprobe\n%%EOF\n')

let root: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-office-wiring-'))
  writeFileSync(
    join(root, '方案.docx'),
    await renderDocx({ title: '方案', blocks: [{ type: 'paragraph', text: '正文一段' }] })
  )
  mkdirSync(join(root, '文件夹.docx'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 一次假转换的现场：见到的请求、读到的字节与版本、以及自己要不要抛 */
interface FakeConversion {
  preview: OfficePreviewService
  requests: OfficePreviewRequest[]
  reads: { bytes: Uint8Array; version: string }[]
}

/**
 * 假引擎：记下请求；`probe` 为真时**替调用方演一遍读源**（真实现里这一步由队列做），
 * 这样接线层那条 `readOfficeSource` 的行为（有界 / 版本）才被打得到。
 */
function fakePreview(
  options: {
    probe?: boolean
    beforeRead?: () => void
    fail?: OfficePreviewError
  } = {}
): FakeConversion {
  const requests: OfficePreviewRequest[] = []
  const reads: { bytes: Uint8Array; version: string }[] = []
  const preview: OfficePreviewService = {
    convert: async (request, abort) => {
      requests.push(request)
      if (options.probe === true) {
        options.beforeRead?.()
        const read = await request.source.read(
          abort ?? new AbortController().signal,
          request.source.bytes ?? 0
        )
        reads.push(read)
      }
      if (options.fail !== undefined) throw options.fail
      const converted: OfficePreviewConversion = {
        pdf: Uint8Array.from(PDF),
        missingFonts: [],
        cacheKey: 'cache-key',
        generation: 'gen-1'
      }
      return converted
    }
  }
  return { preview, requests, reads }
}

/** 一个没人取消的信号（用例里要的是"正常路径"） */
const idleSignal = (): AbortSignal => new AbortController().signal

describe('convertOfficeToPdf：授权闸门', () => {
  it('后缀白名单：四种之外一律 unsupported-format（不进引擎）', async () => {
    writeFileSync(join(root, '笔记.txt'), '纯文本\n')
    const fake = fakePreview()
    expect(
      await convertOfficeToPdf(root, '笔记.txt', 'foreground', fake.preview, idleSignal())
    ).toMatchObject({ kind: 'failed', code: 'unsupported-format' })
    expect(fake.requests).toHaveLength(0)
  })

  it('文件没了回 missing；是目录抛人话；越权路径抛人话（fail closed）', async () => {
    const fake = fakePreview()
    expect(
      await convertOfficeToPdf(root, '没有这个.docx', 'foreground', fake.preview, idleSignal())
    ).toMatchObject({ kind: 'failed', code: 'missing' })
    await expect(
      convertOfficeToPdf(root, '文件夹.docx', 'foreground', fake.preview, idleSignal())
    ).rejects.toThrow(/这是一个文件夹/)
    await expect(
      convertOfficeToPdf(root, '../外面.docx', 'foreground', fake.preview, idleSignal())
    ).rejects.toThrow(/路径不可用/)
    expect(fake.requests).toHaveLength(0)
  })

  it('超过工作台既有的办公档上限（32MB）：input-too-large，且一个字节都不读', async () => {
    // 真造一份超限的文件（与 workbench-files-bytes.spec 里那条上限用例同一手法）
    writeFileSync(join(root, '巨大.docx'), Buffer.alloc(PREVIEW_OFFICE_MAX_BYTES + 1))
    const fake = fakePreview({ probe: true })
    expect(
      await convertOfficeToPdf(root, '巨大.docx', 'foreground', fake.preview, idleSignal())
    ).toMatchObject({ kind: 'failed', code: 'input-too-large' })
    expect(fake.requests).toHaveLength(0)
  })

  it('成功：把授权键/版本/大小交给引擎，回 PDF 字节 + 版本 + 代次', async () => {
    const size = statSync(join(root, '方案.docx')).size
    const fake = fakePreview({ probe: true })
    const result = await convertOfficeToPdf(
      root,
      '方案.docx',
      'foreground',
      fake.preview,
      idleSignal()
    )

    expect(result).toMatchObject({
      kind: 'pdf',
      path: '方案.docx',
      size: PDF.byteLength,
      generation: 'gen-1'
    })
    if (result.kind !== 'pdf') throw new Error('应当是 pdf')
    expect(Buffer.from(result.pdf)).toEqual(PDF)
    expect(result.version.startsWith(`${size}:`)).toBe(true)

    const request = fake.requests[0]
    expect(request.extension).toBe('docx')
    expect(request.priority).toBe('foreground')
    expect(request.source.version).toBe(result.version)
    expect(request.source.bytes).toBe(size)
    // 授权键是 [会话根, 相对路径, 真实路径] 的 JSON（去重用；引擎不解析它）
    const keyParts = JSON.parse(request.source.key) as string[]
    expect(keyParts[0]).toBe(root)
    expect(keyParts[1]).toBe('方案.docx')
    expect(keyParts[2].endsWith('方案.docx')).toBe(true)

    // 读的就是那份文件：字节与磁盘一致，版本与授权时一致
    expect(fake.reads[0].version).toBe(result.version)
    expect(Buffer.from(fake.reads[0].bytes)).toEqual(
      Buffer.from(await readWhole(join(root, '方案.docx')))
    )
  })
})

describe('convertOfficeToPdf：有界读与源一致性', () => {
  it('有界：给多少预留就读到多少（多一个哨兵字节也不再读）', async () => {
    const size = statSync(join(root, '方案.docx')).size
    const reads: { bytes: Uint8Array; version: string }[] = []
    await convertOfficeToPdf(
      root,
      '方案.docx',
      'foreground',
      {
        convert: async (request, abort) => {
          // 只给 4 个字节的预留：读回来的必须是 4 + 1 = 5 个字节（哨兵），而不是整份文件
          reads.push(await request.source.read(abort ?? idleSignal(), 4))
          return { pdf: Uint8Array.from(PDF), missingFonts: [], cacheKey: 'k', generation: 'g' }
        }
      },
      idleSignal()
    )
    expect(size).toBeGreaterThan(5)
    expect(reads[0].bytes.byteLength).toBe(5)
  })

  it('授权之后文件长大：读之前就现形 → source-changed（不把长大的那份当"就是它"）', async () => {
    const path = join(root, '方案.docx')
    const original = statSync(path)
    const fake = fakePreview({
      probe: true,
      beforeRead: () => appendFileSync(path, Buffer.from('追加的一段'))
    })
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).resolves.toMatchObject({ kind: 'failed', code: 'source-changed' })
    // 请求里带的还是授权那一刻的版本；引擎一个字节都没拿到
    expect(fake.requests[0].source.version).toBe(`${original.size}:${original.mtimeMs}`)
    expect(fake.reads).toHaveLength(0)
  })

  it('授权之后被截短：source-changed（不给半截数据当完整快照）', async () => {
    const path = join(root, '方案.docx')
    const fake = fakePreview({
      probe: true,
      beforeRead: () => truncateSync(path, Math.floor(statSync(path).size / 2))
    })
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).resolves.toMatchObject({ kind: 'failed', code: 'source-changed' })
    expect(fake.reads).toHaveLength(0)
  })

  it('授权之后同大小改写（只动 mtime）：照样 source-changed', async () => {
    const path = join(root, '方案.docx')
    const original = readFileSync(path)
    const fake = fakePreview({
      probe: true,
      beforeRead: () => {
        // 同字节数的另一份内容：大小判据看不出来，只有 mtime 能揭示
        writeFileSync(path, Buffer.alloc(original.byteLength, 0x41))
      }
    })
    // 先让 mtime 与"授权那一刻"拉开（同刻改写时 mtime 可能一样）
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).resolves.toMatchObject({ kind: 'failed', code: 'source-changed' })
    expect(statSync(path).size).toBe(original.byteLength)
  })

  it('授权之后被换成区外那份的**硬链接**：source-changed，区外那份的字节一个都不出去', async () => {
    const path = join(root, '方案.docx')
    const outside = mkdtempSync(join(tmpdir(), 'kyclaw-office-outside-'))
    const secret = join(outside, '别处的秘密.docx')
    writeFileSync(secret, Buffer.from('SECRET-CONTENT'.repeat(64)))
    // 用硬链接而不是符号链接：文件的符号链接在 Windows 上要开发模式/特权（本机没有），硬链接不需要；
    // 换的时机在**授权之后**（beforeRead），也就是"这次读到的已经不是授权时那份"
    const fake = fakePreview({
      probe: true,
      beforeRead: () => {
        rmSync(path)
        linkSync(secret, path)
      }
    })
    try {
      const result = await convertOfficeToPdf(
        root,
        '方案.docx',
        'foreground',
        fake.preview,
        idleSignal()
      )
      expect(result).toMatchObject({ kind: 'failed', code: 'source-changed' })
      expect(JSON.stringify(result)).not.toContain('SECRET-CONTENT')
      // 读拿到的那份的版本与授权版本对不上 → 当场拒，一个字节都不往外交
      expect(fake.reads).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('授权之后被换成目录：source-changed（不按"一份文件"去读）', async () => {
    const path = join(root, '方案.docx')
    const fake = fakePreview({
      probe: true,
      beforeRead: () => {
        rmSync(path)
        mkdirSync(path)
      }
    })
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).resolves.toMatchObject({ kind: 'failed', code: 'source-changed' })
    expect(fake.reads).toHaveLength(0)
  })
})

describe('convertOfficeToPdf：取消与错误分类', () => {
  it('进来之前就中止：回 cancelled（不是 reject），不碰引擎', async () => {
    const controller = new AbortController()
    controller.abort()
    const fake = fakePreview()
    expect(
      await convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, controller.signal)
    ).toMatchObject({ kind: 'failed', code: 'cancelled' })
  })

  it('转换中途被取消：回 cancelled，不是把中止当失败往外抛', async () => {
    const controller = new AbortController()
    const fake = fakePreview({ probe: true, beforeRead: () => controller.abort() })
    // 这里刻意用真件那条路：读的时候 signal 已中止 → readOfficeSource 抛中止原因
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, controller.signal)
    ).resolves.toMatchObject({ kind: 'failed', code: 'cancelled' })
  })

  it('引擎的分类失败原样透传（人话也是引擎那句）', async () => {
    const fake = fakePreview({
      fail: new OfficePreviewError('invalid-document', '读不出这个文件：它可能已损坏')
    })
    expect(
      await convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).toMatchObject({
      kind: 'failed',
      code: 'invalid-document',
      message: '读不出这个文件：它可能已损坏'
    })
  })

  it('认不出的异常照抛（不当成"这份文件转不了"）', async () => {
    const fake = fakePreview()
    fake.preview.convert = async () => {
      throw new Error('engine module blew up')
    }
    await expect(
      convertOfficeToPdf(root, '方案.docx', 'foreground', fake.preview, idleSignal())
    ).rejects.toThrow('engine module blew up')
  })
})

describe('readFileBounded：有界、身份与取消', () => {
  /** 常规文件是前提：不是就抛（把 union 窄化掉，后面的断言才好写） */
  function fileRead(read: BoundedFileRead): Extract<BoundedFileRead, { regular: true }> {
    if (!read.regular) throw new Error('应当读到一份常规文件')
    return read
  }

  it('上限之内：整份读回，读前/读后身份一致', async () => {
    const path = join(root, '数据.csv')
    writeFileSync(path, '项目,金额\n房租,1200\n')
    const info = statSync(path)
    const { bytes, opened, settled } = fileRead(await readFileBounded(path, 1024))

    expect(bytes.toString('utf8')).toBe('项目,金额\n房租,1200\n')
    expect(opened).toEqual({ size: info.size, mtimeMs: info.mtimeMs })
    expect(settled).toEqual(opened)
  })

  it('超过上限：**只读 limit 字节**（不是读满再 slice），身份仍报文件真实大小', async () => {
    const path = join(root, '大.csv')
    writeFileSync(path, Buffer.alloc(4096, 0x61))
    const { bytes, opened, settled } = fileRead(await readFileBounded(path, 100))

    expect(bytes.byteLength).toBe(100)
    expect(bytes.toString('utf8')).toBe('a'.repeat(100))
    expect(opened.size).toBe(4096)
    expect(settled).toEqual(opened)
  })

  it('空文件：0 字节，身份一致', async () => {
    const path = join(root, '空.csv')
    writeFileSync(path, '')
    const { bytes, opened } = fileRead(await readFileBounded(path, 100))
    expect(bytes.byteLength).toBe(0)
    expect(opened.size).toBe(0)
  })

  it('同大小改写：两次读的身份不同（判据里有 mtime，不是只看大小）', async () => {
    const path = join(root, '同大小.csv')
    writeFileSync(path, 'a,b\n1,2\n')
    const first = fileRead(await readFileBounded(path, 1024))
    await new Promise((resolve) => setTimeout(resolve, 25))
    writeFileSync(path, 'a,b\n3,4\n') // 同样 8 字节
    const second = fileRead(await readFileBounded(path, 1024))

    expect(second.opened.size).toBe(first.opened.size)
    expect(second.opened.mtimeMs).not.toBe(first.opened.mtimeMs)
  })

  it('非普通文件（目录）：要么打不开、要么明确 regular:false —— 不谎报一份"文件"', async () => {
    const directory = join(root, '目录.csv')
    mkdirSync(directory)
    const outcome: BoundedFileRead | Error = await readFileBounded(directory, 1024).catch(
      (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
    )
    if (outcome instanceof Error) {
      // Windows：CreateFileW 对目录直接拒（EACCES/EPERM/EISDIR 之类）
      expect(['EACCES', 'EPERM', 'EISDIR', 'ENOENT']).toContain(
        (outcome as NodeJS.ErrnoException).code
      )
      return
    }
    expect(outcome.regular).toBe(false)
  })

  it('已经中止的信号：一个字节都不读（按中止原因拒）', async () => {
    const path = join(root, '数据.csv')
    writeFileSync(path, 'a,b\n')
    const controller = new AbortController()
    const reason = new Error('用户点了停止')
    controller.abort(reason)
    await expect(readFileBounded(path, 1024, controller.signal)).rejects.toBe(reason)
  })

  it('文件不在：抛（调用方应先自己 stat 出判别结果）', async () => {
    await expect(readFileBounded(join(root, '没有.csv'), 100)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

/** 读整份文件（只在断言里用；生产路径走 `readFileBounded`） */
async function readWhole(path: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  return new Uint8Array(await readFile(path))
}
