/**
 * 打开一整份 PDF 字节：一条 `PDFDocumentLoadingTask` + 幂等清理。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts`，**worker 那一路刻意不同**：
 * DSH 自建 blob worker（它的构建里带 worker 源码），这里走打包产物里的**同源 URL**
 * （`pdfjs-dist/build/pdf.worker.min.mjs?url`）—— 与既有 `PdfPreview` 同一条路。应用 CSP 是
 * `script-src 'self'`（没有 `blob:` / `worker-src`），自建 blob worker 会被挡；worker 起不来时
 * pdf.js 自己退回主线程（fake worker），不额外报错，也不为照搬去放宽 CSP。
 *
 * 两处 DSH 口径照抄：
 *   - 传进去的字节**先拷一份**：pdf.js 会转移（detach）那个 buffer，而 React 严格模式会跑两遍 effect；
 *   - 取消时**销毁加载任务**并让文档承诺 reject（reason 是 AbortError），调用方据此不切错误态。
 *
 * 第三样是 kyclaw 这侧新加的：`assets`（本地 CMap / 标准字体供给，见 `pdf-assets.ts`）。
 * 它和 `useWorkerFetch: false` 是一对：worker 要资源时把 `{kind, filename}` 发回主线程，
 * 由 `BinaryDataFactory` 回答 —— 没有内嵌字体的 CJK 文档能不能画出来就看这一条。
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfDocument } from './document'
import type { PdfAssetOptions } from './pdf-assets'

type PdfModule = typeof import('pdfjs-dist')
type PdfLoadingTask = ReturnType<PdfModule['getDocument']>

/** 一次打开：文档承诺 + 幂等清理。 */
export interface PdfSession {
  /** 打开的文档；取消或失败都会 reject（取消的 reason 是 AbortError）。 */
  readonly document: Promise<PdfDocument>
  /** 取消、销毁文档、放掉加载任务；可重复调用，**永不 reject**。 */
  dispose(): Promise<void>
}

/** 模块只装一次（动态 import：首屏不付 pdfjs 那份代价，与既有 `PdfPreview` 同口径）。 */
let modulePromise: Promise<PdfModule> | undefined

function pdfjsModule(): Promise<PdfModule> {
  modulePromise ??= import('pdfjs-dist')
  return modulePromise
}

/** 取消时给出去的理由（拿不到 `signal.reason` 就现造一个 AbortError）。 */
function stopReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('PDF 打开被取消', 'AbortError')
}

/**
 * 打开完整字节。
 * @param data 完整 PDF 字节（内部会拷一份，调用方的数组不会被 detach）。
 * @param signal 本次打开的生命周期；不给时只有 `dispose()` 能停。
 * @param assets 本地资源（CMap / 标准字体）供给；不给就是"没有 CMap"的既有形态，
 *   没内嵌字体的 CJK 之类的页面会画不出来（见 `pdf-assets.ts` 的头注）。
 * @returns 文档承诺与幂等清理。
 */
export function openPdf(
  data: Uint8Array | ArrayBuffer,
  signal?: AbortSignal,
  assets?: PdfAssetOptions
): PdfSession {
  const lifetime = new AbortController()
  const stopped =
    signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  const failed = Promise.withResolvers<never>()
  let loading: PdfLoadingTask | undefined
  let closing: Promise<void> | undefined

  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    lifetime.abort()
    closing = Promise.resolve()
      .then(async () => {
        await loading?.destroy()
      })
      .catch((error: unknown) => {
        console.error('[kyclaw] PDF 清理失败', error)
      })
    return closing
  }

  const aborted = (): void => {
    failed.reject(stopReasonOf(stopped))
    void dispose()
  }
  stopped.addEventListener('abort', aborted, { once: true })

  const initialize = async (): Promise<PdfDocument> => {
    stopped.throwIfAborted()
    const pdfjs = await pdfjsModule()
    stopped.throwIfAborted()
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const source = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    loading = pdfjs.getDocument({
      data: source.slice(),
      // 完整字节已经在手上，不再让 worker 去 fetch（也不给它 URL）——
      // 这一档同时决定了"CMap / 标准字体由主线程的 BinaryDataFactory 答"，见 `pdf-assets.ts`
      useWorkerFetch: false,
      cMapPacked: assets?.cMapPacked ?? true,
      stopAtErrors: true,
      enableXfa: false,
      ...(assets?.BinaryDataFactory === undefined
        ? {}
        : { BinaryDataFactory: assets.BinaryDataFactory })
    })
    const opened = await loading.promise
    stopped.throwIfAborted()
    return opened
  }

  // 与 DSH 同形：先开工、再与"取消/失败"赛跑；输的一方不残留（catch 里统一收尾）
  const document = Promise.race([initialize(), failed.promise]).catch(
    async (error: unknown): Promise<never> => {
      await dispose()
      throw error
    }
  )

  return { document, dispose }
}
