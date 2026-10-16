import { describe, expect, it } from 'vitest'
import ExcelJS, { type Workbook } from 'exceljs'
import type { Cell } from '@fortune-sheet/core'
import { ExcelPreviewError } from '../errors'
import { EXCEL_LIMITS } from '../model'
import { convertXlsx } from '../xlsx'

/**
 * XLSX 的口径（都用**现搭的真 xlsx 字节**打，不手拼 XML）：
 *   - 值 / 数字格式 / 合并区 / 隐藏表都进得来，从属合并格**不重复显示值**（照 Excel 的样子）；
 *   - 公式**只留原文**：有缓存结果就显示缓存，没有就记一笔 `missingResults`（一律不重算）；
 *   - 认出来但不显示的内容（图片这类）要如实报出来，同时**解析本身照样成功**；
 *   - 面积到上限 / 全隐藏 / 根本不是 xlsx，都归到明确的失败种类。
 */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/** 现搭一份 xlsx 字节 */
async function xlsxBytes(build: (workbook: Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  build(workbook)
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** 按行列取一格 */
function cellOf(
  sheets: Awaited<ReturnType<typeof convertXlsx>>['sheets'],
  index: number,
  r: number,
  c: number
): Cell | null | undefined {
  return sheets[index]?.celldata?.find((item) => item.r === r && item.c === c)?.v
}

/** 失败种类（不用 toThrow 的字符串匹配，直接读 code） */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof ExcelPreviewError ? error.code : `not-excel-error:${String(error)}`
  }
  return 'no-error'
}

describe('convertXlsx：值 / 版面 / 合并', () => {
  it('多表按顺序进来，第一张可见表当活动表，隐藏表标 hide', async () => {
    const bytes = await xlsxBytes((workbook) => {
      workbook.addWorksheet('汇总').addRow(['项目', '金额'])
      workbook.addWorksheet('附注').state = 'hidden'
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['汇总', '附注'])
    expect(preview.sheets[0]?.status).toBe(1)
    expect(preview.sheets[1]?.hide).toBe(1)
    expect(preview.sheets[1]?.status).toBe(0)
    expect(preview.missingResults).toBe(0)
  })

  it('数字按数值收：右对齐（ht=2）、类型 n、展示文本带千分位格式', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.addRow(['项目', '金额'])
      sheet.getCell('A2').value = '房租'
      sheet.getCell('B2').value = 1200
      sheet.getCell('B2').numFmt = '#,##0'
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    const text = cellOf(preview.sheets, 0, 1, 0)
    const number = cellOf(preview.sheets, 0, 1, 1)
    expect(text?.v).toBe('房租')
    expect(text?.ht).toBe(1)
    expect(number?.v).toBe(1200)
    expect(number?.ct?.t).toBe('n')
    expect(number?.ht).toBe(2)
    // 数字格式真过了一遍（具体分隔符跟着 numeral 走，这里只认"数字还在"）
    expect(String(number?.m).replace(/\D/g, '')).toBe('1200')
  })

  it('合并区：主格有值，从属格只留 mc（不重复显示值）', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.getCell('A1').value = '标题'
      sheet.mergeCells('A1:B1')
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    expect(preview.sheets[0]?.config?.merge?.['0_0']).toEqual({ r: 0, c: 0, rs: 1, cs: 2 })
    expect(cellOf(preview.sheets, 0, 0, 0)?.v).toBe('标题')
    const follower = cellOf(preview.sheets, 0, 0, 1)
    expect(follower?.mc).toEqual({ r: 0, c: 0 })
    expect(follower?.v).toBeUndefined()
    expect(follower?.m).toBeUndefined()
  })

  it('行列版面与网格线都跟着文件走', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.addRow(['项目', '金额'])
      sheet.getColumn(2).width = 20
      sheet.getRow(1).height = 30
      sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    const sheet = preview.sheets[0]
    expect(sheet?.config?.columnlen?.[1]).toBeGreaterThan(0)
    expect(sheet?.config?.rowlen?.[0]).toBe(40)
    expect(sheet?.showGridLines).toBe(true)
    expect(sheet?.defaultRowHeight).toBeGreaterThan(0)
    expect(sheet?.frozen?.type).toBe('rangeBoth')
  })
})

describe('convertXlsx：公式一律不重算', () => {
  it('带缓存结果就用缓存，没缓存只留原文并记一笔', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.getCell('B1').value = 1200
      sheet.getCell('C1').value = { formula: 'B1*2', result: 2400 }
      sheet.getCell('D1').value = { formula: 'SUM(B1:B1)' }
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    const cached = cellOf(preview.sheets, 0, 0, 2)
    expect(cached?.f).toBe('=B1*2')
    expect(cached?.v).toBe(2400)

    const missing = cellOf(preview.sheets, 0, 0, 3)
    expect(missing?.f).toBe('=SUM(B1:B1)')
    expect(missing?.v).toBeUndefined()
    expect(preview.missingResults).toBe(1)
  })
})

describe('convertXlsx：认出来但不显示的内容', () => {
  it('含图片的工作簿照样解析成功，同时报出"图片"', async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet('汇总')
      sheet.getCell('A1').value = '带图'
      const imageId = workbook.addImage({ base64: ONE_PIXEL_PNG, extension: 'png' })
      sheet.addImage(imageId, 'C1:D2')
    })
    const preview = await convertXlsx(bytes, EXCEL_LIMITS)

    expect(preview.sheets[0]?.name).toBe('汇总')
    expect(cellOf(preview.sheets, 0, 0, 0)?.v).toBe('带图')
    expect(preview.unsupportedFeatures).toContain('images')
  })
})

describe('convertXlsx：失败分类', () => {
  it('面积越过上限 → tooLarge', async () => {
    const bytes = await xlsxBytes((workbook) => {
      workbook.addWorksheet('汇总').addRows([
        [1, 2, 3],
        [4, 5, 6]
      ])
    })
    expect(await codeOf(() => convertXlsx(bytes, { ...EXCEL_LIMITS, maxCells: 4 }))).toBe(
      'tooLarge'
    )
  })

  it('全隐藏的工作簿 → invalid（没有可显示的表）', async () => {
    const bytes = await xlsxBytes((workbook) => {
      workbook.addWorksheet('汇总').state = 'hidden'
    })
    expect(await codeOf(() => convertXlsx(bytes, EXCEL_LIMITS))).toBe('invalid')
  })

  it('不是 xlsx 的字节 → invalid', async () => {
    expect(await codeOf(() => convertXlsx(new Uint8Array([1, 2, 3]), EXCEL_LIMITS))).toBe('invalid')
  })
})
