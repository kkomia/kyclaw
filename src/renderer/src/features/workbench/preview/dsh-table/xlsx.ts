/**
 * XLSX → 展示格：**不画图、不重算公式**（公式只留原文，结果取文件里存的那份缓存）。
 * 不依赖 React，也不依赖宿主。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 * 与上游的差异只在**类型面**（本仓库 tsconfig 不接受 `.ts` 后缀 import，命名类型直接从包具名导入）
 * 与"取连续 buffer"的一处显式收敛（`contiguousBuffer`）。
 */
import ExcelJS from 'exceljs'
import type {
  Borders,
  Cell as ExcelCell,
  Color,
  Column,
  Font,
  BorderStyle,
  Workbook,
  WorksheetView
} from 'exceljs'
import type { Cell, CellStyle, Sheet, SheetConfig } from '@fortune-sheet/core'
import { XMLParser } from 'fast-xml-parser'
import { ExcelPreviewError } from './errors'
import {
  EXCEL_UNSUPPORTED_FEATURES,
  formatCell,
  initialSelection,
  type ExcelLimits,
  type ExcelPreview,
  type ExcelUnsupportedFeature
} from './model'
import { XlsxPreviewArchive } from './xlsx-archive'

const BORDER_STYLES: Record<BorderStyle, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13
}
const THEME_ORDER = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink'
]

/**
 * 解一份 XLSX（摘掉 drawings，公式保留原文但不重算）。
 * @param bytes 完整文件字节
 * @param limits 文件与矩阵上限
 * @returns 可以直接喂给只读 FortuneSheet 的工作表
 */
export async function convertXlsx(bytes: Uint8Array, limits: ExcelLimits): Promise<ExcelPreview> {
  const workbook = new ExcelJS.Workbook()
  let unsupportedFeatures: Set<ExcelUnsupportedFeature>
  try {
    const archive = new XlsxPreviewArchive(bytes)
    const preview = archive.withoutDrawings()
    await workbook.xlsx.load(contiguousBuffer(preview), { ignoreNodes: ['drawing'] })
    unsupportedFeatures = archive.unsupportedFeatures
  } catch (error) {
    throw new ExcelPreviewError('invalid', { cause: error })
  }
  if (!workbook.worksheets.some((sheet) => sheet.state === 'visible')) {
    throw new ExcelPreviewError('invalid')
  }
  let area = 0
  const colors = themeColors(workbook)
  let missingResults = 0
  let active = false
  const sheets = workbook.worksheets.map((worksheet, order): Sheet => {
    let row = 1
    let column = 1
    const include = (r: number, c: number): void => {
      row = Math.max(row, r + 1)
      column = Math.max(column, c + 1)
      const sheetArea = row * column
      if (
        !Number.isSafeInteger(sheetArea) ||
        !Number.isSafeInteger(area + sheetArea) ||
        area + sheetArea > limits.maxCells
      ) {
        throw new ExcelPreviewError('tooLarge')
      }
    }
    const config: Required<
      Pick<SheetConfig, 'merge' | 'rowlen' | 'columnlen' | 'rowhidden' | 'colhidden' | 'borderInfo'>
    > = { merge: {}, rowlen: {}, columnlen: {}, rowhidden: {}, colhidden: {}, borderInfo: [] }
    const celldata: NonNullable<Sheet['celldata']> = []
    for (const range of worksheet.model.merges) {
      // ExcelJS 把合并区规范成两个单元格地址。
      const [start, end] = range.split(':') as [string, string]
      const first = worksheet.getCell(start)
      const last = worksheet.getCell(end)
      const merge = {
        r: Number(first.row) - 1,
        c: Number(first.col) - 1,
        rs: Number(last.row) - Number(first.row) + 1,
        cs: Number(last.col) - Number(first.col) + 1
      }
      include(merge.r + merge.rs - 1, merge.c + merge.cs - 1)
      config.merge[`${merge.r}_${merge.c}`] = merge
    }
    // ExcelJS 的类型里，没解析到的集合与样式字段是缺省的。
    const columns = worksheet.columns as Column[] | null
    ;(columns ?? []).forEach((item, index) => {
      if (item.width !== undefined) config.columnlen[index] = columnPixels(item.width)
      if (item.hidden) config.colhidden[index] = 0
    })
    worksheet.eachRow({ includeEmpty: true }, (line) => {
      const r = line.number - 1
      const height = line.height as number | undefined
      if (height !== undefined) config.rowlen[r] = (height * 96) / 72
      if (line.hidden) config.rowhidden[r] = 0
      line.eachCell({ includeEmpty: true }, (cell) => {
        const c = Number(cell.col) - 1
        include(r, c)
        const v = convertCell(cell, colors)
        if (v.f !== undefined && v.v === undefined) missingResults += 1
        if (cell.isMerged) {
          v.mc = config.merge[`${r}_${c}`] ?? {
            r: Number(cell.master.row) - 1,
            c: Number(cell.master.col) - 1
          }
          if (cell.address !== cell.master.address) {
            delete v.v
            delete v.m
            delete v.f
          }
        }
        celldata.push({ r, c, v })
        const border = cell.border as Partial<Borders> | undefined
        if (border !== undefined) {
          const value: Record<string, unknown> = { row_index: r, col_index: c }
          for (const [side, key] of [
            ['top', 't'],
            ['bottom', 'b'],
            ['left', 'l'],
            ['right', 'r']
          ] as const) {
            const edge = border[side]
            if (edge?.style !== undefined) {
              value[key] = {
                style: BORDER_STYLES[edge.style],
                color: colorOf(edge.color, colors) ?? '#000000'
              }
            }
          }
          config.borderInfo.push({ rangeType: 'cell', value })
        }
      })
    })
    config.rowlen = withinBounds(config.rowlen, row)
    config.rowhidden = withinBounds(config.rowhidden, row)
    config.columnlen = withinBounds(config.columnlen, column)
    config.colhidden = withinBounds(config.colhidden, column)
    area += row * column
    const view = (worksheet.views as WorksheetView[] | null)?.[0]
    const visible = worksheet.state === 'visible'
    const status = visible && !active ? 1 : 0
    active ||= visible
    const sheet: Sheet = {
      id: String(worksheet.id),
      name: worksheet.name,
      order,
      status,
      hide: visible ? 0 : 1,
      row,
      column,
      config,
      celldata,
      showGridLines: view?.showGridLines !== false,
      defaultRowHeight: (worksheet.properties.defaultRowHeight * 96) / 72,
      luckysheet_select_save: initialSelection(config)
    }
    if (worksheet.properties.defaultColWidth !== undefined) {
      sheet.defaultColWidth = columnPixels(worksheet.properties.defaultColWidth)
    }
    if (view?.state === 'frozen' && (view.xSplit || view.ySplit)) {
      sheet.frozen = {
        type: view.xSplit && view.ySplit ? 'rangeBoth' : view.ySplit ? 'rangeRow' : 'rangeColumn',
        range: { row_focus: (view.ySplit || 0) - 1, column_focus: (view.xSplit || 0) - 1 }
      }
    }
    return sheet
  })
  return {
    sheets,
    missingResults,
    unsupportedFeatures: EXCEL_UNSUPPORTED_FEATURES.filter((feature) =>
      unsupportedFeatures.has(feature)
    )
  }
}

/**
 * 取一段连续字节交给 ExcelJS（占满整个 ArrayBuffer 时直接复用，否则拷一份）。
 * 上游是原地三元表达式；这里显式收成 `ArrayBuffer`，`SharedArrayBuffer` 那种情形走拷贝。
 */
function contiguousBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer
  }
  const copy = new ArrayBuffer(byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function convertCell(
  cell: Omit<ExcelCell, 'font' | 'fill' | 'alignment'> &
    Partial<Pick<ExcelCell, 'font' | 'fill' | 'alignment'>>,
  colors: readonly (string | undefined)[]
): Cell {
  const font = cell.font
  const alignment = cell.alignment
  const result: Cell = fontStyle(font, colors)
  const bg =
    cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid'
      ? colorOf(cell.fill.fgColor, colors)
      : undefined
  if (bg !== undefined) result.bg = bg
  if (alignment !== undefined) {
    if (alignment.horizontal !== undefined) {
      result.ht = alignment.horizontal === 'center' ? 0 : alignment.horizontal === 'right' ? 2 : 1
    }
    result.vt = alignment.vertical === 'top' ? 1 : alignment.vertical === 'middle' ? 0 : 2
    result.tb = alignment.wrapText ? '2' : '1'
    if (alignment.textRotation === 'vertical') result.tr = '3'
    else if (alignment.textRotation !== undefined) result.rt = alignment.textRotation
  }
  const value = cell.value
  let display: unknown = value
  if (
    value !== null &&
    typeof value === 'object' &&
    ('formula' in value || 'sharedFormula' in value)
  ) {
    result.f = `=${cell.formula}`
    // ExcelJS 会把假值的缓存从 cell.value 里省掉，而 cell.result 上仍留着 0 与 false。
    const cached: unknown = cell.result
    display = cached
  }
  const richText = richTextOf(display)
  if (richText !== undefined) {
    setRichText(result, richText, colors)
  } else if (display instanceof Date) {
    // FortuneSheet 走 1900 日期系统；ExcelJS 已经把工作簿纪元解析过了。
    result.v = display.getTime() / 86_400_000 + 25569
  } else if (display !== null && typeof display === 'object') {
    const text: unknown = Reflect.get(display, 'text')
    const hyperlinkRichText = richTextOf(text)
    if (hyperlinkRichText !== undefined) setRichText(result, hyperlinkRichText, colors)
    else if (typeof text === 'string') result.v = text
    else result.v = String(Reflect.get(display, 'error'))
  } else if (
    typeof display === 'string' ||
    typeof display === 'number' ||
    typeof display === 'boolean'
  ) {
    result.v = display
  }
  return formatCell(result, cell.numFmt || 'General')
}

type RichTextRun = { text: string; font?: Partial<Font> | undefined }

function richTextOf(value: unknown): RichTextRun[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source: unknown = Reflect.get(value, 'richText')
  if (!Array.isArray(source)) return undefined
  return source.map((item): RichTextRun => {
    const run = record(item)
    const font = run.font
    return {
      text: String(run.text),
      font: typeof font === 'object' && font !== null ? font : undefined
    }
  })
}

function setRichText(
  result: Cell,
  runs: readonly RichTextRun[],
  colors: readonly (string | undefined)[]
): void {
  result.ct = {
    t: 'inlineStr',
    s: runs.map((run) => ({ v: run.text, ...fontStyle(run.font, colors) }))
  }
  result.v = runs.map((run) => run.text).join('')
}

function withinBounds(values: Record<number, number>, length: number): Record<number, number> {
  const result: Record<number, number> = {}
  for (const [key, value] of Object.entries(values)) {
    const index = Number(key)
    if (index < length) result[index] = value
  }
  return result
}

function fontStyle(
  font: Partial<Font> | undefined,
  colors: readonly (string | undefined)[]
): CellStyle {
  if (font === undefined) return {}
  const result: CellStyle = {
    bl: font.bold ? 1 : 0,
    it: font.italic ? 1 : 0,
    cl: font.strike ? 1 : 0,
    un:
      font.underline !== undefined && font.underline !== false && font.underline !== 'none' ? 1 : 0
  }
  if (font.name !== undefined) result.ff = font.name
  if (font.size !== undefined) result.fs = font.size
  const fc = colorOf(font.color, colors)
  if (fc !== undefined) result.fc = fc
  return result
}

function columnPixels(width: number): number {
  return Math.floor(width < 1 ? width * 12 : width * 7 + 5)
}

function colorOf(
  color: Partial<Color> | undefined,
  themes: readonly (string | undefined)[]
): string | undefined {
  if (color === undefined) return undefined
  const rgb = color.argb?.slice(-6) ?? (color.theme === undefined ? undefined : themes[color.theme])
  if (rgb === undefined || !/^[\da-f]{6}$/iu.test(rgb)) return undefined
  // ExcelJS 的运行期保留 OOXML 的 tint，但它的类型声明里没有这一项。
  const tint: unknown = Reflect.get(color, 'tint')
  if (typeof tint !== 'number' || tint === 0) return `#${rgb}`
  return `#${[0, 2, 4]
    .map((offset) => {
      const channel = Number.parseInt(rgb.slice(offset, offset + 2), 16)
      return Math.round(
        Math.max(
          0,
          Math.min(255, tint < 0 ? channel * (1 + tint) : channel * (1 - tint) + 255 * tint)
        )
      )
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`
}

function themeColors(workbook: Workbook): (string | undefined)[] {
  const themes: unknown = workbook.model.themes
  const xml = record(themes).theme1
  if (typeof xml !== 'string') return []
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    processEntities: false
  }).parse(xml)
  const scheme = record(record(record(parsed).theme).themeElements).clrScheme
  return THEME_ORDER.map((name) => {
    const color = record(record(scheme)[name])
    const value = record(color.srgbClr)['@_val'] ?? record(color.sysClr)['@_lastClr']
    return typeof value === 'string' ? value : undefined
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
