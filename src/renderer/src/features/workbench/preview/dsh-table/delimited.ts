/**
 * CSV / TSV：**每个字段都当字面文本**（不做类型推断、不认公式）。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/delimited.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 */
import Papa from 'papaparse'
import type { Sheet } from '@fortune-sheet/core'
import { ExcelPreviewError } from './errors'
import { formatCell, initialSelection, type ExcelLimits, type ExcelPreview } from './model'

/**
 * 解 UTF-8 或带 BOM 的 UTF-16 分隔文本（BOM 之外的编码不当猜：解不开就报 `encoding`）。
 * @param bytes 完整文件字节
 * @param format 逗号或制表符分隔
 * @param limits 工作表面积上限
 * @returns 单张工作表（字段全是字面值）
 */
export function convertDelimited(
  bytes: Uint8Array,
  format: 'csv' | 'tsv',
  limits: ExcelLimits
): ExcelPreview {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ExcelPreviewError('encoding', { cause: error })
  }
  const celldata: NonNullable<Sheet['celldata']> = []
  let row = 0
  let column = 1
  let failure: ExcelPreviewError | undefined
  Papa.parse<string[]>(text, {
    delimiter: format === 'csv' ? ',' : '\t',
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    step(result, parser) {
      row += 1
      column = Math.max(column, result.data.length)
      if (result.errors.length > 0 || row * column > limits.maxCells) {
        failure = new ExcelPreviewError(result.errors.length > 0 ? 'invalid' : 'tooLarge')
        parser.abort()
        return
      }
      result.data.forEach((value, c) => {
        celldata.push({ r: row - 1, c, v: formatCell({ v: value }, '@') })
      })
    }
  })
  if (failure !== undefined) throw failure
  return {
    sheets: [
      {
        id: '1',
        name: format.toUpperCase(),
        order: 0,
        status: 1,
        hide: 0,
        row: Math.max(1, row),
        column,
        celldata,
        config: {},
        luckysheet_select_save: initialSelection({})
      }
    ],
    missingResults: 0,
    unsupportedFeatures: []
  }
}
