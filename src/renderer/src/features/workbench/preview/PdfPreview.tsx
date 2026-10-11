/**
 * PDF 预览：主进程回的字节 → pdfjs-dist 逐页画到 canvas（垂直滚动）。
 *
 * 口径与依据（`.superpowers/.../preview-research.md` §2 + round40 拆雷实测）：
 *   - **pdfjs-dist 已在依赖里**（渲染端复用同一份；主进程那条走 legacy 构建抽文字）；
 *   - v6 **零 eval**：严格 CSP（`script-src 'self'`）下能跑，拆雷实测无 CSP 违规、不需要放宽；
 *   - worker 走**同源 URL**（`?url` 导入产物），file:// 与 dev 两种源都实测可用；
 *     worker 起不来时 pdf.js 会自动退回主线程（fake worker），拆雷里两条路都跑过；
 *   - `getDocument({ data })` —— **不从 URL fetch**：字节已经在手上（IPC 结构化克隆过来）；
 *     脚本执行不用显式关：v6 的默认就是关的（构建里 `enableScripting: params.enableScripting === true`，
 *     选项本身也已从类型面移除），查过 GHSA-hq66-cqwq-w95j 的前提条件在本版本不成立；
 *   - pdfjs 会 **转移（detach）** 传进去的 buffer，而 React 严格模式会跑两遍 effect →
 *     每次都递一份新拷贝，免得第二遍拿到被掏空的数组。
 *
 * 画布是**命令式**建在容器里的（不交给 React 渲染）：页数要等文档打开才知道，
 * 若用 state 分两步（先定页数再画），严格模式的"清干净重跑"会让第二步拿不到重跑后的状态。
 * 页面串行渲染（`page.render` 有并发限制），上限 50 页，超出如实截断；
 * 切换文件时旧任务 `destroy()`（v6 的 destroy 在**加载任务**上，不在文档代理上）。
 */
import { useEffect, useRef, useState } from 'react'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Spinner } from '@renderer/components/ui/spinner'

/** 一次最多画多少页（再多就不是"预览"了；超出如实说） */
export const PDF_PAGE_LIMIT = 50

/** 量不到容器宽度时的兜底（jsdom / 首帧） */
const WIDTH_FALLBACK = 600

/** 位图倍率上限：高分屏更清晰，但不至于把显存吃光 */
const MAX_PIXEL_RATIO = 2

type PdfModule = typeof import('pdfjs-dist')

/** pdfjs 的异常名 → 人话（与主进程 `src/main/pdf.ts` 同一套口径） */
function pdfErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return '这个 PDF 有密码，打不开'
  if (name === 'InvalidPDFException') return '读不出这个 PDF（文件可能损坏）'
  return '读不出这个 PDF 的内容'
}

export function PdfPreview({ bytes }: { bytes: Uint8Array }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [drawnPages, setDrawnPages] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let loading: ReturnType<PdfModule['getDocument']> | null = null
    // 容器与组件同生命周期（下面一直渲染着它），cleanup 里用这个捕获值，不读会变的 ref.current
    const host = containerRef.current
    host?.replaceChildren()

    const run = async (): Promise<void> => {
      try {
        const pdfjs: PdfModule = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        if (cancelled) return
        loading = pdfjs.getDocument({
          // 拷贝一份：pdfjs 会转移 buffer，严格模式的第二次 effect 不能拿到被掏空的数组
          data: new Uint8Array(bytes)
        })
        const pdfDocument = await loading.promise
        if (cancelled) return

        if (host === null) return
        const width = host.clientWidth > 0 ? host.clientWidth : WIDTH_FALLBACK
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
        const count = Math.min(pdfDocument.numPages, PDF_PAGE_LIMIT)

        for (let index = 1; index <= count; index += 1) {
          if (cancelled) return
          const page = await pdfDocument.getPage(index)
          const base = page.getViewport({ scale: 1 })
          const cssScale = width / base.width
          const viewport = page.getViewport({ scale: cssScale * pixelRatio })
          const canvas = document.createElement('canvas')
          canvas.setAttribute('data-page', String(index))
          canvas.className = 'max-w-full'
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          canvas.style.width = `${Math.floor(base.width * cssScale)}px`
          canvas.style.height = `${Math.floor(base.height * cssScale)}px`
          host.append(canvas)
          const context = canvas.getContext('2d')
          if (context !== null) {
            await page.render({ canvasContext: context, viewport, canvas }).promise
          }
          page.cleanup()
        }

        if (cancelled) return
        setTotalPages(pdfDocument.numPages)
        setDrawnPages(count)
        setStatus('ready')
      } catch (cause) {
        if (!cancelled) {
          setError(pdfErrorText(cause))
          setStatus('error')
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      host?.replaceChildren()
      void loading?.destroy().catch(() => undefined)
    }
  }, [bytes])

  return (
    <div className="flex flex-col">
      {status === 'loading' ? (
        <div className="flex justify-center py-4">
          <Spinner label="加载中" className="text-ink-tertiary" />
        </div>
      ) : null}
      {status === 'error' ? (
        <p data-testid="file-preview-pdf-error" className="px-3 py-2 text-b2 text-ink-secondary">
          {error ?? '读不出这个 PDF 的内容'}
        </p>
      ) : null}
      <div
        ref={containerRef}
        data-testid="file-preview-pdf"
        data-pages={drawnPages}
        className="flex flex-col items-center gap-3 px-3 py-3"
      />
      {status === 'ready' && totalPages > drawnPages ? (
        <p data-testid="file-preview-pdf-truncated" className="pb-3 text-b2 text-ink-tertiary">
          只显示前 {drawnPages} 页（共 {totalPages} 页）
        </p>
      ) : null}
    </div>
  )
}
