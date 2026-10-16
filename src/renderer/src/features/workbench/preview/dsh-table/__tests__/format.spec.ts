import { describe, expect, it } from 'vitest'
import { ExcelPreviewError } from '../errors'
import { excelFormat, excelFormatOrNull } from '../format'

/**
 * 后缀 → 解析器的分派（对外的组件入口靠它决定"认不认这份文件"）：
 * 四种后缀大小写不敏感；认不出时 `excelFormat` 抛 `invalid`、`excelFormatOrNull` 回 null（渲染期不抛）。
 */
describe('excelFormat：四种后缀的判定', () => {
  it('xlsx / xls / csv / tsv 都认，大小写不敏感', () => {
    expect(excelFormat('汇总.xlsx')).toBe('xlsx')
    expect(excelFormat('旧表.XLS')).toBe('xls')
    expect(excelFormat('名单.csv')).toBe('csv')
    expect(excelFormat('导出.TSV')).toBe('tsv')
  })

  it('只看最后一个点之后那一段（路径里的点不算后缀）', () => {
    expect(excelFormat('a.b.c/表格.csv')).toBe('csv')
    expect(excelFormat('C:\\工作区\\2026.10 汇总.xlsx')).toBe('xlsx')
  })

  it('认不出：抛的是带 code 的 ExcelPreviewError', () => {
    expect(() => excelFormat('说明.txt')).toThrow(ExcelPreviewError)
    try {
      excelFormat('说明.txt')
    } catch (error) {
      expect((error as ExcelPreviewError).code).toBe('invalid')
    }
    expect(() => excelFormat('没有后缀')).toThrow(ExcelPreviewError)
  })

  it('excelFormatOrNull：认不出回 null，不抛', () => {
    expect(excelFormatOrNull('说明.txt')).toBeNull()
    expect(excelFormatOrNull('没有后缀')).toBeNull()
    expect(excelFormatOrNull('名单.csv')).toBe('csv')
  })
})
