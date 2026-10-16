/**
 * 主线程 ↔ 解析 Worker 之间的两条消息（只放**类型与判据**，两边 import 同一份，协议不会各写一套）。
 *
 * 上游（DeepSeek Harness, MIT）把这段类型与 `validPreview` 摆在 `excel/parse.ts` 里：
 * 它的 worker 是 `?raw` 内联脚本，没法共享类型。这里单独抽一个模块，出处与许可见同目录 `NOTICE.md`。
 */
import type { ExcelFormat } from './format'
import type { ExcelPreviewErrorCode } from './errors'
import { EXCEL_UNSUPPORTED_FEATURES, type ExcelLimits, type ExcelPreview } from './model'

/** 主线程 → Worker：一份字节 + 解析器选择 + 上限（字节随消息**转移**，不拷贝） */
export interface ParserRequest {
  bytes: Uint8Array<ArrayBuffer>
  format: ExcelFormat
  limits: ExcelLimits
}

/** Worker → 主线程：成功带结果，失败只带一个可枚举的种类 */
export type ParserResponse =
  { ok: true; value: ExcelPreview } | { ok: false; code: ExcelPreviewErrorCode }

/** Worker 自己**可能回**的失败种类（`worker` 是主线程专有的：Worker 起不来时用，不会从 Worker 回） */
export const PARSER_ERROR_CODES: readonly ExcelPreviewErrorCode[] = [
  'invalid',
  'tooLarge',
  'timeout',
  'encoding'
]

/** 收到的是不是白名单里的失败种类 */
export function isParserErrorCode(value: unknown): value is ExcelPreviewErrorCode {
  return typeof value === 'string' && (PARSER_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * 跨线程边界回来的东西要**当真校验一遍**（Worker 出错时可能回任何形状）。
 * @param value Worker 回包里的 value
 * @returns 是不是一份能直接画的解析结果
 */
export function validPreview(value: unknown): value is ExcelPreview {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sheets' in value) ||
    !('missingResults' in value)
  ) {
    return false
  }
  return (
    typeof value.missingResults === 'number' &&
    Number.isSafeInteger(value.missingResults) &&
    value.missingResults >= 0 &&
    'unsupportedFeatures' in value &&
    Array.isArray(value.unsupportedFeatures) &&
    value.unsupportedFeatures.every((feature: unknown) =>
      EXCEL_UNSUPPORTED_FEATURES.some((known) => known === feature)
    ) &&
    Array.isArray(value.sheets) &&
    value.sheets.length > 0 &&
    value.sheets.every(
      (sheet: unknown) =>
        typeof sheet === 'object' &&
        sheet !== null &&
        'name' in sheet &&
        typeof sheet.name === 'string' &&
        'celldata' in sheet &&
        Array.isArray(sheet.celldata)
    )
  )
}
