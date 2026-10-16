/**
 * PDF 阅读器（本目录对外的主件）：收**一份 PDF 字节**，铺一整列可翻页、可选中、可缩放的页面。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/pdf/pdf.tsx`（`PdfBody` 那一层），
 * 把它的宿主座位换成 kyclaw 的普通 props：
 *   - DSH 的 `tab` / `store` / `slots` / locale / `retainTab` 全部去掉（本仓没有标签记录，
 *     也没有那套注册表）：缩放偏好落成组件内 state，需要记住就由宿主接 `onZoomChange`；
 *   - `content.kind === 'bytes'` 那道判别换成直接的 `bytes` props；
 *   - 失败态文案走本仓口径（`errors.ts`，与主进程 `pdf.js` 抽文字同一套人话）。
 *
 * 谁复用它：`PdfPreview`（PDF 文件）、Office 转换后的 PDF（`DshOfficeViewer`）、
 * 以后任何"先转成 PDF 再看"的产物 —— 凡是有完整 PDF 字节的，都走这一个组件。
 *
 * **两个硬性使用条件**（接线方必须满足）：
 *   1) **宿主容器要有确定高度**（`h-full` 之类）：滚动口在组件内部，高度是 0 就什么都滚不了；
 *   2) `bytes` 的**数组实例要稳定**（放在宿主 state 里）：这一版按实例身份判断"换文件了"，
 *      每次渲染新造一个数组会反复重开文档。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/spinner'
import { PdfPages } from './PdfPages'
import { ZoomViewport } from './ZoomViewport'
import type { PdfDocument } from './document'
import { isAbortError, pdfFailureText } from './errors'
import { bundledPdfAssets, type PdfAssetOptions } from './pdf-assets'
import { openPdf, type PdfSession } from './runtime'
import { DEFAULT_ZOOM_LABELS, FIT_WIDTH, type ZoomLabels, type ZoomPreference } from './zoom'
import './dsh-document.css'

/** 适应宽度时扣掉的左右留白（页列内边距 12×2，与 `dsh-document.css` 里的一致）。 */
const PAGES_HORIZONTAL_INSET = 24

/** 打开结果：文档在手，或一句人话 + 重试。 */
type LoadState =
  | { readonly kind: 'loaded'; readonly document: PdfDocument }
  | { readonly kind: 'failed'; readonly error: unknown }

/** 这一次打开的身份证（换字节 / 点重试即换一张）。 */
interface OpenRequest {
  readonly bytes: Uint8Array | ArrayBuffer
  readonly attempt: number
}

/** 打开结果连同它属于哪一次打开。 */
type OpenResult =
  | { readonly request: OpenRequest; readonly kind: 'loaded'; readonly document: PdfDocument }
  | { readonly request: OpenRequest; readonly kind: 'failed'; readonly error: unknown }

export interface DshPdfViewerProps {
  /** 完整 PDF 字节（主进程回的原始字节 / Office 转换后的 PDF）。数组实例必须稳定，见文件头注。 */
  readonly bytes: Uint8Array | ArrayBuffer
  /** 初始缩放偏好（默认适应宽度）；**只在挂载时取一次**，之后由组件自持。 */
  readonly initialZoom?: ZoomPreference
  /** 用户改缩放（想记住偏好 / 同步到别处时接它）。 */
  readonly onZoomChange?: (preference: ZoomPreference) => void
  /** 当前可见页变化（只在真的换页时回调一次）。 */
  readonly onPageChange?: (page: number) => void
  /** 同一个滚动口交给宿主（回到顶部 / 滚到某页）。 */
  readonly scrollportRef?: (node: HTMLElement | null) => void
  /** 适应宽度是否允许放大（默认 true = 铺满可用宽；false = DSH 的只缩不放）。 */
  readonly fitWidthUpscale?: boolean
  /**
   * 本地资源（CMap / 标准字体）供给：**默认用随包 pdfjs 的那份**（`bundledPdfAssets()`）。
   * 传 `{}` 就是"什么都不给"（没内嵌字体的 CJK 之类会整页画不出来，见 `pdf-assets.ts`）。
   */
  readonly pdfAssets?: PdfAssetOptions
  /** 覆盖局部文案（默认中文）。 */
  readonly labels?: Partial<ZoomLabels>
  /** 额外类名（高度仍由宿主那侧给，见文件头注）。 */
  readonly className?: string
}

/**
 * @param props 字节、初始缩放与三个可选回调。
 * @returns 自带状态机的 PDF 阅读器。
 */
export function DshPdfViewer({
  bytes,
  initialZoom,
  onZoomChange,
  onPageChange,
  scrollportRef,
  fitWidthUpscale,
  pdfAssets,
  labels: labelOverrides,
  className
}: DshPdfViewerProps): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [pageWidth, setPageWidth] = useState<number | undefined>(undefined)
  const [renderZoom, setRenderZoom] = useState(1)
  const [preference, setPreference] = useState<ZoomPreference>(() => initialZoom ?? FIT_WIDTH)
  const [currentPage, setCurrentPage] = useState(1)
  /** 上一次报出去的页（同一个可见页反复进视口时不重复回调宿主） */
  const lastPage = useRef(1)

  /**
   * "这一次打开的身份证"：换字节 / 点重试就换一张 —— 状态不是被"重置"出来的，
   * 而是**派生的**（结果不匹配当前身份证 = 还在加载）。这样每次重新打开都不必在
   * effect 体里同步 setState（那会多一串级联渲染）。
   */
  const request = useMemo<OpenRequest>(() => ({ bytes, attempt }), [bytes, attempt])
  const [result, setResult] = useState<OpenResult | undefined>(undefined)

  const labels = useMemo<ZoomLabels>(
    () => ({ ...DEFAULT_ZOOM_LABELS, ...labelOverrides }),
    [labelOverrides]
  )

  // 本地 CMap / 标准字体：不给就用随包 pdfjs 的那份（`pdfAssets={{}}` 才是"什么都不给"）
  const assets = useMemo<PdfAssetOptions>(() => pdfAssets ?? bundledPdfAssets(), [pdfAssets])

  useEffect(() => {
    const lifetime = new AbortController()
    const session: PdfSession = openPdf(bytes, lifetime.signal, assets)
    void session.document.then(
      (document) => {
        if (!lifetime.signal.aborted) setResult({ request, kind: 'loaded', document })
      },
      (error: unknown) => {
        // 取消（换文件 / 卸载）不是失败：不落错误态
        if (!lifetime.signal.aborted && !isAbortError(error)) {
          setResult({ request, kind: 'failed', error })
        }
      }
    )
    return () => {
      lifetime.abort()
      void session.dispose()
    }
  }, [assets, bytes, request])

  const load: LoadState | undefined =
    result === undefined || result.request !== request
      ? undefined
      : result.kind === 'loaded'
        ? { kind: 'loaded', document: result.document }
        : { kind: 'failed', error: result.error }

  const handlePageVisible = useCallback(
    (page: number): void => {
      if (lastPage.current === page) return
      lastPage.current = page
      setCurrentPage(page)
      onPageChange?.(page)
    },
    [onPageChange]
  )

  const handleZoomChange = useCallback(
    (next: ZoomPreference): void => {
      setPreference(next)
      onZoomChange?.(next)
    },
    [onZoomChange]
  )

  let body: ReactNode
  if (load === undefined) {
    body = (
      <div
        className="flex flex-1 items-center justify-center gap-2 py-6 text-b2 text-ink-secondary"
        role="status"
        data-testid="dsh-pdf-loading"
      >
        <Spinner size="sm" decorative />
        <span>正在打开 PDF…</span>
      </div>
    )
  } else if (load.kind === 'failed') {
    body = (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-6"
        role="alert"
        data-testid="dsh-pdf-error"
        // 原始原因留在 title 上（与页级失败同一口径）：人话一句 + 悬停能看真话，排障不用再猜
        title={load.error instanceof Error ? load.error.message : undefined}
      >
        <p className="text-center text-b2 text-ink-secondary">{pdfFailureText(load.error)}</p>
        <Button
          variant="ghost"
          size="sm"
          data-testid="dsh-pdf-retry"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试
        </Button>
      </div>
    )
  } else {
    body = (
      <ZoomViewport
        preference={preference}
        intrinsicWidth={pageWidth}
        horizontalInset={PAGES_HORIZONTAL_INSET}
        fitWidthUpscale={fitWidthUpscale}
        labels={labels}
        onPreference={handleZoomChange}
        onRenderZoom={setRenderZoom}
        scrollportRef={scrollportRef}
      >
        <PdfPages
          document={load.document}
          currentPage={currentPage}
          onPageVisible={handlePageVisible}
          onPageWidth={setPageWidth}
          zoom={renderZoom}
        />
      </ZoomViewport>
    )
  }

  return (
    <div
      className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}
      data-testid="dsh-pdf-viewer"
      data-state={load === undefined ? 'loading' : load.kind}
      data-pages={load?.kind === 'loaded' ? load.document.numPages : undefined}
    >
      {body}
    </div>
  )
}
