/**
 * 单页光栅化（含取消与清理），PDF 阅读器与 Office 转出来的 PDF 共用这一条渲染路。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/pdf/document.ts`，改动只有两处：
 *   1) 参数名 `document` → `pdfDocument`（不再遮蔽全局 `document`）；
 *   2) 去掉两个没有任何使用者的 CSS 变量（`--pdf-page-width` / `--pdf-page-height`）。
 *
 * 取消口径照抄：晚到的 `getPage` 不能写尺寸（每步 `throwIfAborted`）；在跑的渲染任务与文字层
 * 一起取消并等它们收尾；收尾后 `page.cleanup()` 释放这一页的算子表 —— **内存优先于重解析时间**
 * （既有 `PdfPreview` 为了缩放重画快刻意不调 cleanup；这一版跟着 DSH 走，页多时不至于攒住算子表）。
 */
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'

/** 打开一份 PDF 只需要这几个成员（真件与单测替身同形）。 */
export type PdfDocument = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>

/** 页面在 CSS 像素下的尺寸。 */
export interface PdfPageSize {
  readonly width: number
  readonly height: number
}

/** 与页面共用同一条取消/收尾栅栏的可选文字层（见 `text-layer.ts`）。 */
export type RenderPdfText = (
  page: PDFPageProxy,
  viewport: PageViewport
) => {
  readonly promise: Promise<void>
  cancel(): void
}

/** 单页位图的像素数上限（≈4096×4096）：高分屏也不至于把显存吃光。 */
const MAX_PAGE_PIXELS = 16_777_216

/** PDF 用户单位（1/72 in）→ CSS 像素（1/96 in）：适应宽度与文字层都按这个基准对齐。 */
const DISPLAY_SCALE = 96 / 72

/**
 * 把一页画进**独占**的画布。
 * @param pdfDocument 已打开的文档。
 * @param pageNumber 1 起的页号。
 * @param canvas 本次渲染独占的画布（先画离屏缓冲，成功后才贴回来 —— 看不到中间清空那一帧）。
 * @param signal 本次渲染的生命周期（取消即中止：不写尺寸、不留半张图）。
 * @param pixelRatio 设备像素比 × 当前倍率：面板越小/越大，位图跟着降/升，但显示尺寸不变。
 * @param renderText 可选文字层：与位图共用同一条取消与收尾栅栏。
 * @returns 这一页按 `DISPLAY_SCALE` 折算出来的 CSS 尺寸（与倍率无关，是"原始宽"的来源）。
 */
export async function renderPdfPage(
  pdfDocument: PdfDocument,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  pixelRatio: number,
  renderText?: RenderPdfText
): Promise<PdfPageSize> {
  signal.throwIfAborted()
  const page: PDFPageProxy = await pdfDocument.getPage(pageNumber)
  try {
    signal.throwIfAborted()
    const viewport = page.getViewport({ scale: DISPLAY_SCALE })
    // 限住位图分配：只改清晰度，不改显示尺寸（显示尺寸始终由 viewport 决定）
    const ratio = Math.min(
      pixelRatio,
      Math.sqrt(MAX_PAGE_PIXELS / (viewport.width * viewport.height))
    )
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
    })
    let text: ReturnType<RenderPdfText> | undefined
    let cancelled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      task.cancel()
      text?.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      text = renderText?.(page, viewport)
      if (signal.aborted) cancel()
      await Promise.all([task.promise, text?.promise])
      signal.throwIfAborted()
      return { width: viewport.width, height: viewport.height }
    } catch (error) {
      cancel()
      await Promise.allSettled([task.promise, text?.promise])
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}
