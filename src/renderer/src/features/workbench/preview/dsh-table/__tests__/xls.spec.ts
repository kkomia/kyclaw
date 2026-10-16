import { describe, expect, it } from 'vitest'
import { utils as sheetUtils, write, type WorkBook } from 'xlsx'
import type { Cell } from '@fortune-sheet/core'
import { ExcelPreviewError } from '../errors'
import { EXCEL_LIMITS } from '../model'
import { convertXls } from '../xls'

/**
 * 老版 .xls（BIFF8）的口径（夹具用 SheetJS 现写一份真的二进制）：
 *   - 存下来的值 / 数字类型 / 合并区都能读出来，日期按 Excel 序列号还原成文本；
 *   - **不接受改名成 .xls 的文本**（按 CFB / BIFF 的暗号判，不按后缀信）；
 *   - 面积到上限整次拒绝。
 */
function xlsBytes(build: (workbook: WorkBook) => void): Uint8Array {
  const workbook: WorkBook = { SheetNames: [], Sheets: {} }
  build(workbook)
  const written: ArrayBuffer = write(workbook, { type: 'array', bookType: 'biff8' })
  return new Uint8Array(written)
}

/** 按行列取一格 */
function cellOf(
  preview: ReturnType<typeof convertXls>,
  index: number,
  r: number,
  c: number
): Cell | null | undefined {
  return preview.sheets[index]?.celldata?.find((item) => item.r === r && item.c === c)?.v
}

describe('convertXls：值与版面', () => {
  it('多张表按顺序进来，第一张当活动表；数字是数字、文本是文本', () => {
    const bytes = xlsBytes((workbook) => {
      workbook.SheetNames = ['名单', '说明']
      workbook.Sheets['名单'] = sheetUtils.aoa_to_sheet([
        ['姓名', '年龄'],
        ['张三', 28]
      ])
      workbook.Sheets['说明'] = sheetUtils.aoa_to_sheet([['只有一行']])
    })
    const preview = convertXls(bytes, EXCEL_LIMITS)

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['名单', '说明'])
    expect(preview.sheets[0]?.status).toBe(1)
    expect(preview.sheets[1]?.status).toBe(0)
    expect(preview.sheets[0]?.hide).toBe(0)

    expect(cellOf(preview, 0, 1, 0)?.v).toBe('张三')
    const age = cellOf(preview, 0, 1, 1)
    expect(age?.v).toBe(28)
    expect(age?.ct?.t).toBe('n')
    expect(age?.ht).toBe(2)
  })

  it('日期序列号按文件的格式串还原成日期文本（不是裸数字）', () => {
    const bytes = xlsBytes((workbook) => {
      workbook.SheetNames = ['日期']
      workbook.Sheets['日期'] = sheetUtils.aoa_to_sheet([])
      workbook.Sheets['日期']['A1'] = { t: 'n', v: 45000, z: 'yyyy-mm-dd' }
    })
    const preview = convertXls(bytes, EXCEL_LIMITS)

    const cell = cellOf(preview, 0, 0, 0)
    expect(cell?.v).toBe(45000)
    expect(String(cell?.m)).toContain('2023')
  })

  it('合并区：主格带值，从属格只留 mc', () => {
    const bytes = xlsBytes((workbook) => {
      const sheet = sheetUtils.aoa_to_sheet([])
      sheet['A1'] = { t: 's', v: '合计' }
      sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]
      workbook.SheetNames = ['合并']
      workbook.Sheets['合并'] = sheet
    })
    const preview = convertXls(bytes, EXCEL_LIMITS)

    expect(preview.sheets[0]?.config?.merge?.['0_0']).toEqual({ r: 0, c: 0, rs: 1, cs: 2 })
    expect(cellOf(preview, 0, 0, 0)?.v).toBe('合计')
    const follower = cellOf(preview, 0, 0, 1)
    expect(follower?.mc).toEqual({ r: 0, c: 0 })
    expect(follower?.v).toBeUndefined()
  })
})

describe('convertXls：失败分类', () => {
  it('改名成 .xls 的文本 → invalid（按暗号判，不按后缀信）', () => {
    const text = new TextEncoder().encode('a,b\n1,2\n')
    let code = 'no-error'
    try {
      convertXls(text, EXCEL_LIMITS)
    } catch (error) {
      code = error instanceof ExcelPreviewError ? error.code : `not-excel-error:${String(error)}`
    }
    expect(code).toBe('invalid')
  })

  it('面积越过上限 → tooLarge', () => {
    const bytes = xlsBytes((workbook) => {
      workbook.SheetNames = ['大表']
      workbook.Sheets['大表'] = sheetUtils.aoa_to_sheet([
        [1, 2, 3],
        [4, 5, 6]
      ])
    })
    expect(() => convertXls(bytes, { ...EXCEL_LIMITS, maxCells: 4 })).toThrow(ExcelPreviewError)
    try {
      convertXls(bytes, { ...EXCEL_LIMITS, maxCells: 4 })
    } catch (error) {
      expect((error as ExcelPreviewError).code).toBe('tooLarge')
    }
  })
})
