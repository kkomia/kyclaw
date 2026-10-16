/**
 * 页列：一页一个壳，进视口才画（按需页渲染）；画好之后在画布上叠一层**可选中**文字。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx`（`PdfPage` 与页列那一段），
 * 四处适配：
 *   1) DSH 的 tab/store/locale 座位（`PropsStore` / `PropsLocale` / `useTabInfo`）换成普通 props；
 *   2) 生命周期信号自持（DSH 用标签记录的生命周期；本仓没有标签记录，效果依赖变化即取消）；
 *   3) 类名与 `data-*` 换成本仓口径（`dsh-*` + `data-testid`），文案进组件默认值；
 *   4) 拿不到 2D 上下文 = 这一页画不出来（给错误态 + 重试），不假装它已经画好。
 *
 * 三条关键机制照抄：
 *   - **按需**：IntersectionObserver（`rootMargin: '100% 0px'`，提前一屏）进过视口才请求渲染；
 *     没有 IntersectionObserver 的环境（jsdom / 极端环境）退化成"全部都要"，正确性不依赖它；
 *   - **串行**：同一页的渲染排队走（pdf.js 的页面代理一次只允许一个渲染任务），互不打断；
 *   - **位图与倍率**：倍率变了只重画**可见页**（离屏页留旧图，滚回来再重画），画的时候先落
 *     离屏缓冲再一次性贴回可见画布 —— 看不到中间清空的那一帧。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button } from '@renderer/components/ui/button'
import { renderPdfPage, type PdfDocument } from './document'
import { pdfTextRenderer } from './text-layer'
import './dsh-document.css'

/** 拿不到 2D 上下文时抛这个（渲染层没得画，别把它当成功）。 */
const NO_CANVAS_CONTEXT = 'PDF canvas has no 2D context'

export interface PdfPagesProps {
  readonly document: PdfDocument
  /** 当前页（宿主按"最后可见页"记）：非首页在重挂时立刻渲染，不留在占位块上。 */
  readonly currentPage: number
  /** 某一页进了视口（宿主据此更新当前页）。 */
  readonly onPageVisible: (page: number) => void
  /** 第一页量到的宽度（适应宽度的基准；只在第 1 页上报）。 */
  readonly onPageWidth?: (width: number) => void
  /** 当前解析出来的倍率：位图按它重排（适应宽度变化 / 手动缩放都走这里）。 */
  readonly zoom: number
}

/**
 * @param props 文档、当前页、可见回调与倍率。
 * @returns 整列页面。
 */
export function PdfPages(props: PdfPagesProps): React.JSX.Element {
  const pages = Array.from({ length: props.document.numPages }, (_value, index) => index + 1)
  return (
    <section className="dsh-pdf-pages" data-testid="dsh-pdf-pages">
      {pages.map((page) => (
        <PdfPage
          key={page}
          document={props.document}
          page={page}
          requested={page === 1 || props.currentPage === page}
          onVisible={props.onPageVisible}
          onWidth={page === 1 ? props.onPageWidth : undefined}
          zoom={props.zoom}
        />
      ))}
    </section>
  )
}

/** 一页：占位块 → 画布 + 文字层；失败给错误态与重试。 */
function PdfPage({
  document,
  page,
  requested: initiallyRequested,
  onVisible,
  onWidth,
  zoom
}: {
  readonly document: PdfDocument
  readonly page: number
  readonly requested: boolean
  readonly onVisible: (page: number) => void
  readonly onWidth: ((width: number) => void) | undefined
  readonly zoom: number
}): React.JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const text = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  const [requested, setRequested] = useState(initiallyRequested)
  const [visible, setVisible] = useState(initiallyRequested)
  const renderedZoom = useRef<number | undefined>(undefined)
  const pendingRender = useRef<Promise<void>>(Promise.resolve())
  const textTask = useRef<ReturnType<ReturnType<typeof pdfTextRenderer>> | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready'>('loading')
  const [failure, setFailure] = useState<{ readonly error: unknown } | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)

  // 没有 IntersectionObserver 的环境（jsdom / 极端环境）退化成"全都看得到"：
  // 这一条**不进 state**（在 effect 体里同步 setState 会级联渲染），渲染期直接并进去。
  const observes = typeof IntersectionObserver === 'function'
  const wanted = requested || !observes
  const shown = visible || !observes

  useEffect(() => {
    // 缩放后的画布可能比它那页的容器宽，横向滚出去之后"容器"已经不在视口里、画布还在。
    // 所以画好之后观察的是画布本身。
    if (typeof IntersectionObserver !== 'function') return
    const node = state === 'ready' ? canvas.current : host.current
    if (node === null) return
    let disposed = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed) return
        const intersects = entries.some((entry) => entry.isIntersecting)
        setVisible(intersects)
        if (!intersects) return
        setRequested(true)
        onVisible(page)
      },
      { rootMargin: '100% 0px' }
    )
    observer.observe(node)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [page, onVisible, state])

  useEffect(
    () => () => {
      textTask.current?.cancel()
    },
    []
  )

  useEffect(() => {
    if (!wanted) return
    // 已经画过、且（离屏 或 倍率没变）：留着旧图，不动
    if (renderedZoom.current !== undefined && (!shown || renderedZoom.current === zoom)) return
    const node = canvas.current
    if (node === null) return
    const lifetime = new AbortController()
    let newText: ReturnType<ReturnType<typeof pdfTextRenderer>> | undefined
    // pdf.js 的页面代理一次只跑一个渲染任务：同一页的两次渲染排队，前一个收尾了再开
    pendingRender.current = pendingRender.current
      .then(async () => {
        lifetime.signal.throwIfAborted()
        const buffer = node.ownerDocument.createElement('canvas')
        try {
          const size = await renderPdfPage(
            document,
            page,
            buffer,
            lifetime.signal,
            window.devicePixelRatio * zoom,
            textTask.current === undefined
              ? (pdfPage, viewport) => {
                  newText = pdfTextRenderer(text.current as HTMLDivElement)(pdfPage, viewport)
                  return newText
                }
              : undefined
          )
          lifetime.signal.throwIfAborted()
          const context = node.getContext('2d')
          if (context === null) throw new Error(NO_CANVAS_CONTEXT)
          node.width = buffer.width
          node.height = buffer.height
          context.drawImage(buffer, 0, 0)
          textTask.current ??= newText
          newText = undefined
          renderedZoom.current = zoom
          setWidth(size.width)
          onWidth?.(size.width)
          setState('ready')
          setFailure(undefined)
        } finally {
          buffer.width = buffer.height = 0
          newText?.cancel()
        }
      })
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) setFailure({ error })
      })
    return () => {
      lifetime.abort()
      newText?.cancel()
    }
  }, [document, page, wanted, shown, zoom, attempt, onWidth])

  const pending = failure === undefined && state !== 'ready'
  return (
    <div ref={host} className="dsh-pdf-page" data-testid="dsh-pdf-page" data-page={page}>
      {pending ? (
        <div
          className="dsh-pdf-placeholder"
          data-testid="dsh-pdf-page-placeholder"
          role={wanted ? 'status' : undefined}
          aria-label={wanted ? '正在绘制页面' : undefined}
        />
      ) : null}
      {failure !== undefined ? (
        <div
          className="flex items-center gap-2 px-2 py-3 text-b2 text-ink-secondary"
          role="alert"
          data-testid="dsh-pdf-page-error"
          data-page={page}
          title={failure.error instanceof Error ? failure.error.message : undefined}
        >
          <span>这一页画不出来</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="dsh-pdf-page-retry"
            onClick={() => {
              // 先把错误态收掉（用户会看到占位块），再让 effect 重跑一趟
              setFailure(undefined)
              setAttempt((value) => value + 1)
            }}
          >
            重试
          </Button>
        </div>
      ) : null}
      <div
        className="dsh-zoom-surface dsh-pdf-surface"
        data-dsh-zoom-surface
        data-testid="dsh-pdf-page-surface"
        data-page={page}
        style={{ '--dsh-zoom-width': `${width ?? 0}px` } as CSSProperties}
        hidden={state !== 'ready'}
      >
        <canvas
          ref={canvas}
          className="dsh-pdf-canvas"
          data-testid="dsh-pdf-page-canvas"
          role="img"
          aria-label={`PDF 第 ${page} 页`}
        />
        <div ref={text} className="dsh-pdf-text" data-testid="dsh-pdf-page-text" />
      </div>
    </div>
  )
}
