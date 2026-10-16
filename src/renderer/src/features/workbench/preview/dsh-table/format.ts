/**
 * 文件名后缀 → 用哪个解析器（**刻意与重型解析链分开**：判断后缀要能在轻入口里 import，
 * 不必把 exceljs / FortuneSheet 一起拖进来）。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/format.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 */
import { ExcelPreviewError } from './errors'

/** 表格预览认的四种格式 */
export type ExcelFormat = 'xlsx' | 'xls' | 'csv' | 'tsv'

/**
 * 认后缀（大小写不敏感）。
 * @param filename 文件名或路径（只看最后一个 `.` 之后那一段）
 * @returns 认得出的格式；认不出抛 `ExcelPreviewError('invalid')`
 */
export function excelFormat(filename: string): ExcelFormat {
  const suffix = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  if (suffix === 'xlsx' || suffix === 'xls' || suffix === 'csv' || suffix === 'tsv') return suffix
  throw new ExcelPreviewError('invalid')
}

/**
 * 同 `excelFormat`，但认不出时回 `null`。
 * React 入口用这个：渲染期**不抛异常**，直接落到"打不开"那一档人话。
 */
export function excelFormatOrNull(filename: string): ExcelFormat | null {
  try {
    return excelFormat(filename)
  } catch {
    return null
  }
}
