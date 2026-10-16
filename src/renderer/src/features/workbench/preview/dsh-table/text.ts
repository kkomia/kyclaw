/**
 * 表格预览的人话（本部署只有中文，所以不引 i18n 框架、不摆语言表）。
 *
 * 文案取自 DeepSeek Harness（MIT）`…/excel/locales.ts` 的 `zh` 一份；出处与许可见同目录 `NOTICE.md`。
 */
export const EXCEL_TEXT = {
  title: '表格',
  loading: '文档渲染中…',
  invalid: '无法打开此表格。请检查文件格式、内容或密码保护。',
  tooLarge: '此表格超过预览大小限制。',
  timeout: '打开表格超时。请缩小文件后重试。',
  encoding: '无法识别此文本文件的编码。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。',
  formulaWarning: '此工作簿包含公式，显示结果可能缺失或不准确。',
  unsupportedNotice: '当前预览不支持此工作簿中的{features}。请用本地应用打开，以获得完整体验。',
  worker: '表格解析组件没能启动（Worker 不可用）。重试一次；再不行就用本地应用打开这份表格。',
  charts: '图表',
  images: '图片',
  shapes: '形状',
  conditionalFormatting: '条件格式',
  /** 多项并列时的分隔（中文顿号） */
  featureSeparator: '、',
  retry: '重试'
} as const

/** 失败种类 → 人话（解析器只抛 code，界面在这儿换成字） */
export const EXCEL_ERROR_TEXT: Record<string, string> = {
  invalid: EXCEL_TEXT.invalid,
  tooLarge: EXCEL_TEXT.tooLarge,
  timeout: EXCEL_TEXT.timeout,
  encoding: EXCEL_TEXT.encoding,
  worker: EXCEL_TEXT.worker
}

/**
 * 把"认出来但不显示的内容"拼进那条提示里。
 * @param features 已按 `EXCEL_UNSUPPORTED_FEATURES` 顺序排好的 feature 名
 * @returns 整句人话
 */
export function unsupportedNotice(features: readonly string[]): string {
  const names = features.map((feature) => EXCEL_TEXT[feature as keyof typeof EXCEL_TEXT] ?? feature)
  return EXCEL_TEXT.unsupportedNotice.replace('{features}', names.join(EXCEL_TEXT.featureSeparator))
}
