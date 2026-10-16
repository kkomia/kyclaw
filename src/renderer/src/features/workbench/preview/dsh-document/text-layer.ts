/**
 * 可选中的文字层：pdf.js 官方的 `TextLayerBuilder` 负责文字定位、选区边界与复制归一化，
 * 这里只负责把它对齐到画布上 —— 宽度变化（适应宽度 / 面板缩放）用一层 CSS `scale` 把整层跟着缩放，
 * 不必为每一次变宽重排文字（位图那边才需要重画）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/pdf/text.ts`，四处改动：
 *   1) 宿主量不到宽度时**不写** `scale`（写 0 会把整层文字缩成看不见；未布局 / jsdom 都走这一条）；
 *   2) 没有 `ResizeObserver` 的环境不装观察器（懒更新是优化，不是正确性）；
 *   3) `pdf_viewer.mjs`（约 320 KB）改成**用到时才 import** —— 与"pdfjs 本身就是按需装"的口径一致，
 *      首屏不为一个很少用到的能力付这份代价；取消得比 import 早也算数（下面的 `cancelled`）；
 *   4) 先挂 `globalThis.pdfjsLib` 再 import：pdf.js 的 web 层在**模块求值期**就从那里取引擎
 *      （`pdf_viewer.mjs` 顶部那段解构），不挂就会当场炸。
 *
 * 样式（定位、字号、选区配色）在 `dsh-document.css` 的 `.dsh-pdf-text` 那一段，
 * 口径照 pdfjs-dist 的 `web/pdf_viewer.css`（Apache-2.0，Mozilla）核过。
 */
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'
import type { RenderPdfText } from './document'

type PdfViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs')
type TextLayerBuilderCtor = PdfViewerModule['TextLayerBuilder']
type TextLayerBuilderInstance = InstanceType<TextLayerBuilderCtor>

/** web 层只装一次（模块求值本身也被 import 缓存兜住，这里只是别重复挂 globalThis）。 */
let builderPromise: Promise<TextLayerBuilderCtor> | undefined

function textLayerBuilder(): Promise<TextLayerBuilderCtor> {
  builderPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist')
    ;(globalThis as { pdfjsLib?: unknown }).pdfjsLib ??= pdfjs
    const web = await import('pdfjs-dist/web/pdf_viewer.mjs')
    return web.TextLayerBuilder
  })()
  return builderPromise
}

/**
 * 造一个"把文字层挂进这个宿主"的渲染器。
 * @param host 与画布同尺寸的绝对定位宿主（`.dsh-pdf-text`）。
 * @returns 渲染器；`cancel()` 同时收掉 resize 观察器与那一层 DOM（import 还没回来也算数）。
 */
export function pdfTextRenderer(host: HTMLDivElement): RenderPdfText {
  return (page: PDFPageProxy, viewport: PageViewport) => {
    let cancelled = false
    let layer: TextLayerBuilderInstance | undefined
    let container: HTMLDivElement | undefined
    let observer: ResizeObserver | null = null

    const fit = (): void => {
      // 宽度适应的合成：文字层按原始 viewport 排版，再整体缩到画布实际宽度
      if (container === undefined) return
      const width = host.getBoundingClientRect().width
      if (width > 0) container.style.setProperty('scale', String(width / viewport.width))
    }

    const promise = textLayerBuilder().then(async (TextLayerBuilder) => {
      if (cancelled) return
      layer = new TextLayerBuilder({ pdfPage: page })
      container = layer.div
      // pdfjs 的字号口径：字号 = --text-scale-factor × 每段自己的 --font-height
      container.style.setProperty(
        '--total-scale-factor',
        String(viewport.scale * viewport.userUnit)
      )
      container.style.setProperty('--scale-round-x', '1px')
      container.style.setProperty('--scale-round-y', '1px')
      host.append(container)
      observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
      observer?.observe(host)
      fit()
      // pdf.js 6 的类型把 images 标成必填，但只有"图片也进文字层"那条新路用它；
      // 官方的文字层在有图无图两种文档上都这么调（这里同样只给 viewport）。
      await layer.render({ viewport } as Parameters<TextLayerBuilderInstance['render']>[0])
    })

    return {
      promise,
      cancel(): void {
        cancelled = true
        observer?.disconnect()
        layer?.cancel()
        container?.remove()
      }
    }
  }
}
