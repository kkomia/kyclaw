// @vitest-environment node
/**
 * PDF 文本抽取（模块 2）：真 PDF（自造 fixture）→ 真文本 + 页数断言；扫描件形态 → 人话提示。
 * 上限（页数/单页/总量）也用 fixture 打，确认它们真的会截断并把 truncated 立起来。
 */
import { describe, expect, it } from 'vitest'
import { extractPdfText } from '../pdf'
import { buildPdf } from './pdf-fixture'
import { PDF_MAX_PAGES, PDF_PAGE_MAX_CHARS } from '../../shared/attachments'

describe('extractPdfText · 真 PDF', () => {
  it('抽到文字与页数，正文带页码标记', async () => {
    const pdf = buildPdf([['Hello PDF', 'second line'], ['Page two text']])
    const result = await extractPdfText(pdf)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('【第 1 页】')
    expect(result.text).toContain('【第 2 页】')
    expect(result.text).toContain('Hello PDF')
    expect(result.text).toContain('second line')
    expect(result.text).toContain('Page two text')
  })

  it('没有文字层的页不占空标记（混在文档里的扫描页只体现在页码跳号上）', async () => {
    const result = await extractPdfText(buildPdf([['first page'], [], ['third page']]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(3)
    expect(result.text).toContain('【第 1 页】')
    expect(result.text).toContain('【第 3 页】')
    expect(result.text).not.toContain('【第 2 页】')
  })

  it('没有文字层的 PDF（扫描件形态）→ 人话提示，不假装抽到内容', async () => {
    const pdf = buildPdf([[], []])
    const result = await extractPdfText(pdf)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('没有文字层')
  })

  it('空文件 / 坏文件各自给人话，不抛', async () => {
    const empty = await extractPdfText(new Uint8Array())
    expect(empty.ok).toBe(false)

    const broken = await extractPdfText(new TextEncoder().encode('not a pdf at all'))
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.message).not.toBe('')
  })

  it('超过页数上限 → 只抽前 PDF_MAX_PAGES 页并标 truncated', async () => {
    const pages = Array.from({ length: PDF_MAX_PAGES + 2 }, (_, index) => [`page ${index + 1}`])
    const result = await extractPdfText(buildPdf(pages))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pages).toBe(PDF_MAX_PAGES + 2)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain(`【第 ${PDF_MAX_PAGES} 页】`)
    expect(result.text).not.toContain(`【第 ${PDF_MAX_PAGES + 1} 页】`)
  }, 60_000)

  it('单页超长 → 该页截断并标 truncated', async () => {
    // 一页里塞 20 行长文本（页面开大：pdf.js 会丢掉跑出页面框的文字）
    const lines = Array.from({ length: 20 }, () => 'y'.repeat(430))
    const result = await extractPdfText(
      buildPdf([lines], { width: 2000, height: 5000, fontSize: 8, leading: 10 })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('已截断')
    // 正文长度被压到上限附近（含我们自己加的那句说明）
    expect(result.text.length).toBeLessThan(PDF_PAGE_MAX_CHARS + 200)
  }, 60_000)
})
