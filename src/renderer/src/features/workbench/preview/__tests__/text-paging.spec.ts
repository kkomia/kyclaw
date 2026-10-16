import { describe, expect, it, vi } from 'vitest'
import type { OfficePreviewResult } from '@shared/office-preview'
import type { TextPage, TextPageResult } from '@shared/workbench-text'
import { readPreview, sourceTextOf, textPagerFor, type PreviewWorkbench } from '../fetch'

/**
 * 文本分页在"取内容"这一层的接线：
 *   - 第一页走 `workbench:read-text-page`（不再是 64KB 的 read-file），并把续读口一起交出去；
 *   - 读不到第一页的四种情形翻成人话（与表格那条同一口径）；
 *   - `sourceTextOf` 只在"整份都在手里"（一页读完）时给源文 —— 分页中给 null，
 *     免得摘选拿第一页去算**错的**行号。
 */
function pageOf(partial: Partial<TextPage> = {}): TextPage {
  const text = partial.text ?? '正文\n'
  const size = partial.size ?? Buffer.byteLength(text, 'utf8')
  return {
    kind: 'page',
    text,
    offset: partial.offset ?? 0,
    nextOffset: partial.nextOffset ?? size,
    size,
    version: partial.version ?? '7:1',
    eof: partial.eof ?? true,
    overlongLine: partial.overlongLine ?? false
  }
}

function bench(overrides: Partial<PreviewWorkbench> = {}): PreviewWorkbench {
  return {
    readTextPage: vi.fn(async (): Promise<TextPageResult> => ({ kind: 'missing' })),
    textVersion: vi.fn(async () => ({ kind: 'missing' as const })),
    readBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    tableBytes: vi.fn(async () => ({ kind: 'unsupported' as const, size: 0 })),
    officePdf: vi.fn(async (): Promise<OfficePreviewResult> => ({
      kind: 'failed',
      path: 'x',
      code: 'unavailable',
      message: '测试桩'
    })),
    cancelOfficePdf: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('readPreview：文本走分页第一页', () => {
  it('.txt：调 read-text-page（cursor = null），值里带第一页与续读口；不碰字节通道', async () => {
    const page = pageOf({ text: '第一段\n', nextOffset: 4, size: 8, eof: false })
    const readTextPage = vi.fn(async (): Promise<TextPageResult> => page)
    const workbench = bench({ readTextPage })

    const state = await readPreview(workbench, 'thread-1', 'note.txt')

    expect(readTextPage).toHaveBeenCalledWith('thread-1', 'note.txt', null)
    expect(workbench.readBytes).not.toHaveBeenCalled()
    expect(state.status).toBe('ready')
    expect(state.mode).toBe('text')
    expect(state.value?.channel).toBe('text-page')
    if (state.value?.channel !== 'text-page') throw new Error('跑偏了')
    expect(state.value.textPage.page).toEqual(page)
    // 续读口把游标原样转给通道、版本探询走 text-version
    await state.value.textPage.pager.readPage({ offset: 4, version: page.version })
    expect(readTextPage).toHaveBeenLastCalledWith('thread-1', 'note.txt', {
      offset: 4,
      version: page.version
    })
  })

  it('markdown / 代码也走同一条（渲染方式由 mode 决定，取数不分岔）', async () => {
    const readTextPage = vi.fn(async (): Promise<TextPageResult> => pageOf())
    const workbench = bench({ readTextPage })

    expect((await readPreview(workbench, 't', 'README.md')).mode).toBe('markdown')
    expect((await readPreview(workbench, 't', 'src/a.ts')).mode).toBe('code')
    expect(readTextPage).toHaveBeenCalledWith('t', 'README.md', null)
    expect(readTextPage).toHaveBeenCalledWith('t', 'src/a.ts', null)
  })

  it('四种读不到都有现成人话（二进制 / 太大 / 没了 / 正在改）', async () => {
    const cases: Array<[TextPageResult, string]> = [
      [{ kind: 'binary', size: 2048 }, '二进制'],
      [{ kind: 'too-large', size: 70 * 1024 * 1024, limit: 64 * 1024 * 1024 }, '文件太大'],
      [{ kind: 'missing' }, '不在磁盘上'],
      [{ kind: 'changed' }, '正在被改动']
    ]
    for (const [result, expected] of cases) {
      const workbench = bench({ readTextPage: vi.fn(async () => result) })
      const state = await readPreview(workbench, 't', 'note.txt')
      expect(state.status).toBe('error')
      expect(state.error).toContain(expected)
    }
  })

  it('越权（通道抛）也走错误落点，不吞', async () => {
    const workbench = bench({
      readTextPage: vi.fn(async () => {
        throw new Error('目标路径在工作区之外')
      })
    })
    const state = await readPreview(workbench, 't', '../外面.txt')
    expect(state.status).toBe('error')
    expect(state.error).toContain('工作区之外')
  })
})

describe('sourceTextOf：只在"整份都在手里"时给源文', () => {
  it('一页读完 → 给文本；分页中（还有没加载的）→ null', async () => {
    const complete = bench({ readTextPage: vi.fn(async () => pageOf({ text: 'a\nb\n' })) })
    const state = await readPreview(complete, 't', 'a.txt')
    expect(sourceTextOf(state)).toBe('a\nb\n')

    const partial = bench({
      readTextPage: vi.fn(async () => pageOf({ text: 'a\n', eof: false, nextOffset: 2, size: 8 }))
    })
    const partialState = await readPreview(partial, 't', 'big.txt')
    expect(sourceTextOf(partialState)).toBeNull()
  })

  it('字节 / 表格通道没有可比对的文本 → null（行为不变）', async () => {
    const bytes = bench({
      readBytes: vi.fn(async () => ({
        kind: 'bytes' as const,
        format: 'image-png' as const,
        bytes: new Uint8Array([1]),
        size: 1
      }))
    })
    expect(sourceTextOf(await readPreview(bytes, 't', 'a.png'))).toBeNull()

    const table = bench({
      tableBytes: vi.fn(async () => ({
        kind: 'bytes' as const,
        format: 'csv' as const,
        bytes: new Uint8Array([1]),
        size: 1
      }))
    })
    expect(sourceTextOf(await readPreview(table, 't', 'a.csv'))).toBeNull()
  })
})

describe('textPagerFor：取数口', () => {
  it('readPage / version 各自转到对应通道', async () => {
    const workbench = bench({
      textVersion: vi.fn(async () => ({ kind: 'version' as const, version: '9:2', size: 9 }))
    })
    const pager = textPagerFor(workbench, 'thread-9', 'log.txt')
    await pager.version()
    expect(workbench.textVersion).toHaveBeenCalledWith('thread-9', 'log.txt')
    await pager.readPage(null)
    expect(workbench.readTextPage).toHaveBeenCalledWith('thread-9', 'log.txt', null)
  })
})
