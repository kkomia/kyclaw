import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from '../frontmatter'
import { parseFrontmatterFields } from '../frontmatter-parse'

describe('splitFrontmatter：开头的 YAML 块', () => {
  it('标准块：元数据与正文切开，正文从闭合行之后开始', () => {
    const split = splitFrontmatter('---\ntitle: 标题\ntags: [a, b]\n---\n# 正文\n')
    expect(split).toEqual({ source: 'title: 标题\ntags: [a, b]', body: '# 正文\n' })
  })

  it('BOM 允许、`...` 也能闭合、CRLF 也认', () => {
    expect(splitFrontmatter('\uFEFF---\r\na: 1\r\n...\r\n正文')).toEqual({
      source: 'a: 1',
      body: '正文'
    })
  })

  it('空块（两个分隔符之间什么都没有）也算 frontmatter', () => {
    expect(splitFrontmatter('---\n---\n正文')).toEqual({ source: '', body: '正文' })
  })

  it('没闭合的开块不算 frontmatter（保持 markdown 原文）', () => {
    expect(splitFrontmatter('---\ntitle: 没关\n\n正文')).toBeUndefined()
  })

  it('不在第一行就不算（`---` 在正文里是分隔线）', () => {
    expect(splitFrontmatter('# 标题\n\n---\na: 1\n---\n')).toBeUndefined()
  })

  it('没有 frontmatter 的普通 markdown 原样返回 undefined', () => {
    expect(splitFrontmatter('# 标题\n\n正文')).toBeUndefined()
  })
})

describe('parseFrontmatterFields：字段表', () => {
  it('字符串值给解析后的值（引号去掉）；多行字符串按整段读', () => {
    const fields = parseFrontmatterFields('title: "带引号的标题"\nnote: |\n  第一行\n  第二行')
    expect(fields?.[0]).toEqual({ key: 'title', value: '带引号的标题', block: false })
    expect(fields?.[1]?.value).toBe('第一行\n第二行')
    expect(fields?.[1]?.block).toBe(false)
  })

  it('数字/布尔保持原文（`1.0` 不会变成 `1`）', () => {
    const fields = parseFrontmatterFields('version: 1.0\nok: true')
    expect(fields?.map((field) => field.value)).toEqual(['1.0', 'true'])
  })

  it('列表 / 映射值给原文并标 block（不展开、不猜结构）', () => {
    const fields = parseFrontmatterFields('tags:\n  - a\n  - b\nmeta:\n  x: 1')
    expect(fields?.[0]?.block).toBe(true)
    expect(fields?.[0]?.value).toContain('- a')
    expect(fields?.[1]?.block).toBe(true)
  })

  it('YAML 非法 / 顶层不是映射 → undefined（调用方显示原文块）', () => {
    expect(parseFrontmatterFields('a: [未闭合')).toBeUndefined()
    expect(parseFrontmatterFields('- 只是列表\n- 两项')).toBeUndefined()
  })

  it('空文档 → 空表（什么都不显示）', () => {
    expect(parseFrontmatterFields('')).toEqual([])
  })
})
