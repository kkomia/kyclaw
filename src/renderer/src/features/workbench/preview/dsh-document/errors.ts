/**
 * PDF 失败态的人话与取消判据。
 *
 * 文案与 `src/main/pdf.ts` 的 `pdfErrorText` **同一套**：主进程抽文字层与渲染端画页
 * 面对同一份坏文件时说同一句话（加密 / 损坏 / 其它）。
 */

/** pdfjs 的异常名 → 人话（拿不到名字就给通用文案，不吐栈）。 */
export function pdfFailureText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return '这个 PDF 有密码，打不开'
  if (name === 'InvalidPDFException') return '读不出这个 PDF（文件可能损坏）'
  return '读不出这个 PDF 的内容'
}

/**
 * 取消（换文件 / 关面板 / 组件卸载）不是失败：调用方据此不要切到错误态。
 *
 * 判据是 `name === 'AbortError'`（**不能要求 `instanceof Error`**）：`AbortSignal.throwIfAborted()`
 * 抛的是 `signal.reason`，默认那个是 **`DOMException`** —— 它按 WebIDL 定义，**不继承 `Error`**
 * （浏览器、jsdom 都是这样），`instanceof Error` 那条判据会漏掉取消、把取消当失败弹给用户。
 */
export function isAbortError(error: unknown): boolean {
  return nameOf(error) === 'AbortError'
}

/** 从一个 unknown 里取 `name`（不要求它是 Error：DOMException 这类也是"有 name 的失败"）。 */
function nameOf(error: unknown): string {
  if (error instanceof Error) return error.name
  if (typeof error !== 'object' || error === null) return ''
  const name: unknown = Reflect.get(error, 'name')
  return typeof name === 'string' ? name : ''
}
