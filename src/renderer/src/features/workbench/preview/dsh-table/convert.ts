/**
 * 格式分派：一份字节 → 一种只读的展示结构。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/convert.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 */
import type { ExcelFormat } from './format'
import { ExcelPreviewError } from './errors'
import type { ExcelLimits, ExcelPreview } from './model'
import { convertXlsx } from './xlsx'
import { convertXls } from './xls'
import { convertDelimited } from './delimited'

/**
 * 解一份表格字节（**不重算任何公式**）。
 * @param bytes 完整文件字节
 * @param format 按后缀定下来的格式
 * @param limits 文件与矩阵上限
 * @returns 展示用工作表 + 缺公式结果的格数
 */
export async function convertExcel(
  bytes: Uint8Array,
  format: ExcelFormat,
  limits: ExcelLimits
): Promise<ExcelPreview> {
  if (bytes.byteLength > limits.maxBytes) throw new ExcelPreviewError('tooLarge')
  if (format === 'xlsx') return convertXlsx(bytes, limits)
  if (format === 'xls') return convertXls(bytes, limits)
  return convertDelimited(bytes, format, limits)
}
