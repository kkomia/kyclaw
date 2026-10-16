/**
 * 表格解析失败的五类原因（**与文案解耦**：文案在 `text.ts`，界面按 code 取人话）。
 *
 * `worker` 只由主线程产生（Worker 起不来 / 加载失败 / 收发失败）；其余四类 Worker 也会回。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/error.ts`
 * （`worker` 是本仓新增的一类，见同目录 `NOTICE.md`）；出处与许可见同目录 `NOTICE.md`。
 */
export type ExcelPreviewErrorCode = 'invalid' | 'tooLarge' | 'timeout' | 'encoding' | 'worker'

/** 解析器抛出来的"给人看的失败种类" */
export class ExcelPreviewError extends Error {
  readonly code: ExcelPreviewErrorCode

  constructor(code: ExcelPreviewErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'ExcelPreviewError'
    this.code = code
  }
}
