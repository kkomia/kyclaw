import { describe, expect, it } from 'vitest'
import type { Cell } from '@fortune-sheet/core'
import { convertDelimited } from '../delimited'
import { ExcelPreviewError } from '../errors'
import { EXCEL_LIMITS } from '../model'

/**
 * CSV / TSV 的口径（这是"不做类型推断"的正面证据）：
 *   - 字段一律是**字面文本**（`28` 就是字符串 '28'，不是数字），公式不认、类型不猜；
 *   - 编码只接受 UTF-8 与带 BOM 的 UTF-16（解不开报 `encoding`，不硬塞半份乱码）；
 *   - 表格面积到上限就整次拒绝（`tooLarge`）。
 */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 手搓一份带 BOM 的 UTF-16LE（避开 TextEncoder 只出 UTF-8 这一条） */
function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes[2 + index * 2] = code & 0xff
    bytes[3 + index * 2] = code >> 8
  }
  return bytes
}

/** 从 celldata 里取一格（按行列找，找不到回 undefined） */
function cellOf(
  preview: ReturnType<typeof convertDelimited>,
  r: number,
  c: number
): Cell | null | undefined {
  return preview.sheets[0]?.celldata?.find((item) => item.r === r && item.c === c)?.v
}

describe('convertDelimited：CSV', () => {
  it('一张表、表名 CSV，字段是字面文本（数字不转成 number）', () => {
    const preview = convertDelimited(utf8('姓名,年龄\n张三,28\n'), 'csv', EXCEL_LIMITS)

    expect(preview.sheets).toHaveLength(1)
    expect(preview.sheets[0]?.name).toBe('CSV')
    expect(preview.sheets[0]?.status).toBe(1)
    expect(preview.missingResults).toBe(0)
    expect(preview.unsupportedFeatures).toEqual([])

    const name = cellOf(preview, 1, 0)
    const age = cellOf(preview, 1, 1)
    expect(name?.v).toBe('张三')
    // 「28」是文本：不推断类型，也不右对齐
    expect(age?.v).toBe('28')
    expect(age?.ct?.t).toBe('s')
    expect(age?.m).toBe('28')
  })

  it('引号里的逗号与换行按 CSV 规矩还原成一个字段', () => {
    const preview = convertDelimited(utf8('"a,b","多行\n值"\n'), 'csv', EXCEL_LIMITS)
    expect(cellOf(preview, 0, 0)?.v).toBe('a,b')
    expect(cellOf(preview, 0, 1)?.v).toBe('多行\n值')
  })

  it('空行不吞掉：行数照算，行列尺寸跟着最长的一行', () => {
    const preview = convertDelimited(utf8('a,b\n\nc,d'), 'csv', EXCEL_LIMITS)
    expect(preview.sheets[0]?.row).toBe(3)
    expect(preview.sheets[0]?.column).toBe(2)
  })

  it('认带 BOM 的 UTF-16LE', () => {
    const preview = convertDelimited(utf16le('a,b\n1,2\n'), 'csv', EXCEL_LIMITS)
    expect(cellOf(preview, 0, 0)?.v).toBe('a')
    expect(cellOf(preview, 1, 1)?.v).toBe('2')
  })

  it('不是 UTF-8 / 带 BOM 的 UTF-16 时报 encoding（不塞半份乱码）', () => {
    const broken = new Uint8Array([0x61, 0xc3, 0x28, 0x62])
    expect(() => convertDelimited(broken, 'csv', EXCEL_LIMITS)).toThrow(ExcelPreviewError)
    try {
      convertDelimited(broken, 'csv', EXCEL_LIMITS)
    } catch (error) {
      expect((error as ExcelPreviewError).code).toBe('encoding')
    }
  })

  it('面积越过上限就整次拒绝（tooLarge）', () => {
    const limits = { ...EXCEL_LIMITS, maxCells: 2 }
    expect(() => convertDelimited(utf8('a,b\n1,2\n'), 'csv', limits)).toThrow(ExcelPreviewError)
    try {
      convertDelimited(utf8('a,b\n1,2\n'), 'csv', limits)
    } catch (error) {
      expect((error as ExcelPreviewError).code).toBe('tooLarge')
    }
  })
})

describe('convertDelimited：TSV', () => {
  it('按制表符切、表名 TSV（逗号是普通字符）', () => {
    const preview = convertDelimited(utf8('a,b\tc\n'), 'tsv', EXCEL_LIMITS)
    expect(preview.sheets[0]?.name).toBe('TSV')
    expect(cellOf(preview, 0, 0)?.v).toBe('a,b')
    expect(cellOf(preview, 0, 1)?.v).toBe('c')
  })
})
