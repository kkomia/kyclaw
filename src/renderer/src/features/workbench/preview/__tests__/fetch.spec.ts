import { describe, expect, it, vi } from 'vitest'
import { readPreview, readPreviewState, sourceTextOf, type PreviewWorkbench } from '../fetch'

/**
 * 取内容这一段的分流（按后缀走哪条通道）：
 *   - 办公档：**只交转换口**（不读文件、不转 —— 转换由组件挂载时发起，见 office-bridge）；
 *   - 表格：整份原始字节拉回来（解析交给渲染端的 ExcelPreview）；
 *   - 文本 / markdown / 代码：走**文本分页**第一页（`read-text-page`，续读由组件拿着取数口做）；
 *   - 图片 / PDF / HTML：字节通道。
 */
function fakeWorkbench(overrides: Partial<PreviewWorkbench> = {}): PreviewWorkbench {
  return {
    readTextPage: vi.fn(async () => ({
      kind: 'page' as const,
      text: '',
      offset: 0,
      nextOffset: 0,
      size: 0,
      version: 'test:0',
      eof: true,
      overlongLine: false
    })),
    textVersion: vi.fn(async () => ({ kind: 'version' as const, version: 'test:0', size: 0 })),
    readBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    tableBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    officePdf: vi.fn(async (_threadId: string, relative: string) => ({
      kind: 'failed' as const,
      path: relative,
      code: 'failed' as const,
      message: '测试桩'
    })),
    cancelOfficePdf: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('readPreview：办公档', () => {
  it('只交转换口：不读文件、不读字节、此刻也不发起转换', async () => {
    const workbench = fakeWorkbench()

    const state = await readPreview(workbench, 'thread-1', '方案.docx')

    expect(state.mode).toBe('office')
    expect(state.status).toBe('ready')
    expect(state.office).toBeDefined()
    expect(state.value).toBeUndefined()
    expect(workbench.readTextPage).not.toHaveBeenCalled()
    expect(workbench.readBytes).not.toHaveBeenCalled()
    expect(workbench.tableBytes).not.toHaveBeenCalled()
    expect(workbench.officePdf).not.toHaveBeenCalled()
  })

  it('转换口真能转（把桥的回包原样递下去）', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const workbench = fakeWorkbench({
      officePdf: vi.fn(async (_threadId: string, relative: string) => ({
        kind: 'pdf' as const,
        path: relative,
        version: 'v1',
        pdf,
        size: pdf.byteLength,
        missingFonts: ['等线'],
        generation: 'g1'
      }))
    })

    const state = await readPreview(workbench, 'thread-1', '旧汇报.ppt')
    const result = await state.office?.load(new AbortController().signal)

    expect(result).toEqual({ bytes: pdf, missingFonts: ['等线'] })
  })
})

describe('readPreview：表格原始字节', () => {
  it('xls / xlsx / csv / tsv 都走 tableBytes（四种后缀同一条路）', async () => {
    for (const name of ['旧台账.xls', '台账.xlsx', '名单.csv', '名单.tsv']) {
      const bytes = new Uint8Array([1, 2, 3])
      const workbench = fakeWorkbench({
        tableBytes: vi.fn(async () => ({
          kind: 'bytes' as const,
          format: name.slice(name.lastIndexOf('.') + 1) as 'xls' | 'xlsx' | 'csv' | 'tsv',
          bytes,
          size: bytes.byteLength
        }))
      })

      const state = await readPreview(workbench, 'thread-1', name)

      expect(state.mode).toBe('table')
      expect(state.status).toBe('ready')
      expect(state.value).toEqual({
        channel: 'table',
        table: { bytes, format: name.slice(name.lastIndexOf('.') + 1), size: 3 }
      })
      expect(workbench.tableBytes).toHaveBeenCalledWith('thread-1', name)
      // 表格**不**走办公档那条 PDF 管线，也不走旧的字节结构通道
      expect(workbench.readBytes).not.toHaveBeenCalled()
      expect(workbench.officePdf).not.toHaveBeenCalled()
    }
  })

  it('四种"没读到字节"都给人话（过大 / 认不出 / 没了 / 正在改）', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'too-large', size: 40 * 1024 * 1024, limit: 32 * 1024 * 1024 }, '这份表格太大'],
      [{ kind: 'unsupported', size: 12 }, '认不出这份表格'],
      [{ kind: 'missing' }, '不在磁盘上了'],
      [{ kind: 'changed' }, '正在被改动']
    ]
    for (const [result, expected] of cases) {
      const workbench = fakeWorkbench({
        tableBytes: vi.fn(async () => result as never)
      })

      const state = await readPreview(workbench, 't', '台账.xlsx')

      expect(state.status).toBe('error')
      expect(state.error).toContain(expected)
      expect(state.value).toBeUndefined()
    }
  })

  it('通道报错（IPC 失败）剥成人话', async () => {
    const failing = fakeWorkbench({
      tableBytes: vi.fn(async () => {
        throw new Error("Error invoking remote method 'workbench:table-bytes': Error: 读盘失败")
      })
    })

    const state = await readPreview(failing, 't', 'a.csv')

    expect(state.status).toBe('error')
    expect(state.error).toBe('读盘失败')
  })
})

describe('readPreview：既有两条通道不变', () => {
  it('PDF / 图片仍走 readBytes（PDF 的缩略图与大纲在 PdfPreview 那边，一路没动）', async () => {
    const bytes = new Uint8Array([0x25, 0x50])
    const workbench = fakeWorkbench({
      readBytes: vi.fn(async () => ({
        kind: 'bytes' as const,
        format: 'pdf' as const,
        bytes,
        size: 2
      }))
    })

    const state = await readPreview(workbench, 't', '报告.pdf')

    expect(state.mode).toBe('pdf')
    expect(state.value).toEqual({
      channel: 'bytes',
      bytes: { kind: 'bytes', format: 'pdf', bytes, size: 2 }
    })
    expect(workbench.readBytes).toHaveBeenCalledWith('t', '报告.pdf')
    expect(workbench.tableBytes).not.toHaveBeenCalled()
  })

  it('文本 / markdown / 代码走文本分页第一页（cursor = null），不碰字节通道', async () => {
    const workbench = fakeWorkbench({
      readTextPage: vi.fn(async () => ({
        kind: 'page' as const,
        text: '# 标题\n',
        offset: 0,
        nextOffset: 8,
        size: 8,
        version: '8:1',
        eof: true,
        overlongLine: false
      }))
    })

    const state = await readPreview(workbench, 't', '说明.md')

    expect(state.mode).toBe('markdown')
    expect(state.value?.channel).toBe('text-page')
    expect(workbench.readTextPage).toHaveBeenCalledWith('t', '说明.md', null)
    expect(workbench.readBytes).not.toHaveBeenCalled()
  })

  it('读失败与既有口径一致：错误态 + 剥包装的人话', async () => {
    const workbench = fakeWorkbench({
      readBytes: vi.fn(async () => {
        throw new Error("Error invoking remote method 'workbench:read-bytes': Error: 权限不足")
      })
    })

    const state = await readPreview(workbench, 't', 'a.png')

    expect(state.status).toBe('error')
    expect(state.error).toBe('权限不足')
  })
})

describe('readPreviewState / sourceTextOf', () => {
  it('带上是哪个会话的哪份文件；表格与办公档没有"源文"可比对（摘选位置省略）', async () => {
    const workbench = fakeWorkbench()

    const state = await readPreviewState(workbench, 'thread-9', '台账.xlsx')
    const tableState = await readPreview(workbench, 'thread-9', '台账.xlsx')
    const officeState = await readPreview(workbench, 'thread-9', '方案.docx')
    const textState = await readPreview(workbench, 'thread-9', '说明.md')

    expect([state.threadId, state.relative]).toEqual(['thread-9', '台账.xlsx'])
    expect(sourceTextOf(state)).toBeNull()
    expect(sourceTextOf(tableState)).toBeNull()
    expect(sourceTextOf(officeState)).toBeNull()
    expect(sourceTextOf(textState)).toBe('')
  })
})
