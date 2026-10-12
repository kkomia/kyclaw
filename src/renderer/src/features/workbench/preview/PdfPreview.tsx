/**
 * PDF 预览：主进程回的字节 → pdfjs-dist 逐页画到 canvas（垂直滚动）+ 缩放 + 缩略图/目录侧栏。
 *
 * ── 既有口径（round 40/50，逐条不动）──────────────────────────────────────────
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
 * 页面串行渲染（`page.render` 一条一条来），上限 50 页，超出如实截断；
 * 切换文件时旧任务 `destroy()`（v6 的 destroy 在**加载任务**上，不在文档代理上）。
 * 换文件的"状态归零"交给 `PreviewBody` 的 `key={relative}` 重挂（换路径即换组件），这里不写 reset。
 *
 * ── round 52（用户：放大缩小 + 展开 pdf 目录）──────────────────────────────────
 *   1) **缩放是档位制**（`PDF_ZOOM_STEPS`，0.5 → 3，步进约 ×1.25）：**1 = 适应宽度 = 默认档**，
 *      也就是本轮之前的口径（每页 = 容器可用宽 / 页宽）。一次调档分两手：
 *        · 立刻：按倍率**同步**铺开每张画布的 CSS 尺寸 —— 位图还是上一档、被拉伸显示，
 *          但布局与滚动条当场跟上，不会出现"半秒空白"（雷点 5：不许闪现）。
 *          容器宽变化（侧栏开合 / 面板缩放 / 全屏）走同一条路，页面始终"适应宽度"。
 *        · 停手 `REPAINT_DELAY` 毫秒后：**整本重画**（位图按 `适应宽度 × 档位 × 像素比` 重排）——
 *          清晰档。重画顺序**可见页优先**（IntersectionObserver 记的可视页先画，其余按页号补），
 *          连点十下也只重画一趟（防抖），且同一时刻只允许一趟在跑（令牌作废旧的那趟）。
 *      为什么不纯 CSS 缩放：位图不重排，200% 就是糊的；为什么不"每按一次重画一本"：那是 50 页 × N 次。
 *      重画不闪的机制：新倍率先画进**离屏画布**，再在一个同步块里"改位图尺寸 + 贴回去" ——
 *      浏览器不会在这个块中间绘制，所以看不到清空的那一帧。
 *      逐页 `page.cleanup()` 不再调用：它会把算子表丢掉，缩放重画就得重新解析一遍（v6 里 cleanup
 *      只在没有在跑的任务时才真清，留着也没坏处，但重画会明显变慢）；收尾交给 `loading.destroy()`。
 *   2) **侧栏**：左上角开关 → 左侧滑出（宽度过渡，不硬切；内层固定宽，动画期间不重排）：
 *        · 缩略图：每页一张小 canvas（低倍渲染）+ 页码，**懒渲染** —— IntersectionObserver 进视口才挂，
 *          一批 `THUMB_BATCH` 张，挂上就画；点一下跳该页（平滑滚动），当前页描边高亮，滚动联动；
 *        · 目录：文档带 outline 才有这一档（`getOutline` → `getPageIndex` 解析成页码），点了跳页。
 *        没有 IntersectionObserver 的环境（jsdom / 极端环境）走"全都要、照样分批挂"的兜底：
 *        懒渲染是优化，不是正确性。
 *   3) Ctrl + 滚轮 = 缩小 / 放大（与图片查看器同一手势）。Electron 默认会让 Ctrl+滚轮缩放**整个界面**，
 *      这里用**非被动**监听把这一处拦下来（React 的 onWheel 是被动监听，preventDefault 不起作用）。
 *   4) 版面口径：canvas 走 `mx-auto block` —— 装得下居中（= 既有观感），放大到装不下时 auto 边距归零、
 *      左对齐，横向滚动摸得到左边（flex 的 `items-center` 在溢出时左侧是够不着的）。**不挂 `max-w-full`**：
 *      它会把放大后的宽度夹回容器宽、而高度还是放大值 —— 页面会被拉长。
 */
import { PanelLeft, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { cn } from '@renderer/components/ui/cn'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Spinner } from '@renderer/components/ui/spinner'

/** 一次最多画多少页（再多就不是"预览"了；超出如实说） */
export const PDF_PAGE_LIMIT = 50

/** 量不到容器宽度时的兜底（jsdom / 首帧） */
const WIDTH_FALLBACK = 600

/** 位图倍率上限：高分屏更清晰，但不至于把显存吃光 */
const MAX_PIXEL_RATIO = 2

/** 缩放档位：相对「适应宽度」的倍率（1 = 适应宽度 = 默认档），步进约 ×1.25 */
const PDF_ZOOM_STEPS: readonly number[] = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 3]

/** 默认档 = 适应宽度 */
const PDF_ZOOM_DEFAULT = 1

/** 调档 / 变宽到重画之间的防抖（连点只重画一趟；这段时间里页面已经被拉伸铺好了） */
const REPAINT_DELAY = 180

/** 侧栏缩略图的位图宽（CSS 像素，再乘像素比；页码下面那行字看得清就够） */
const THUMB_WIDTH = 140

/** 缩略图一批挂几张：进视口那一下不会同时起 50 个 canvas / 50 次渲染 */
const THUMB_BATCH = 3

/** 侧栏宽（内层固定这个宽：外层做宽度过渡时内容不跟着重排） */
const SIDEBAR_WIDTH_CLASS = 'w-44'

type PdfModule = typeof import('pdfjs-dist')
type PdfLoadingTask = ReturnType<PdfModule['getDocument']>
type PdfDocument = Awaited<PdfLoadingTask['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>
type PdfOutlineNode = NonNullable<Awaited<ReturnType<PdfDocument['getOutline']>>>[number]

/** 目录项：目的地已解析成页码（跳转直接 `jumpToPage`） */
interface OutlineEntry {
  key: string
  title: string
  depth: number
  page: number
}

/** pdfjs 的异常名 → 人话（与主进程 `src/main/pdf.ts` 同一套口径） */
function pdfErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return '这个 PDF 有密码，打不开'
  if (name === 'InvalidPDFException') return '读不出这个 PDF（文件可能损坏）'
  return '读不出这个 PDF 的内容'
}

/** 一个方向走一档（纯函数）：端点站住不动；不在档位表里（理论到不了）回默认档 */
function stepZoom(zoom: number, direction: 1 | -1): number {
  const index = PDF_ZOOM_STEPS.indexOf(zoom)
  if (index === -1) return PDF_ZOOM_DEFAULT
  const next = Math.min(Math.max(index + direction, 0), PDF_ZOOM_STEPS.length - 1)
  return PDF_ZOOM_STEPS[next] ?? PDF_ZOOM_DEFAULT
}

/**
 * 缩略图的懒渲染批次（纯函数，单测直接打）：给"进过视口的页"和"已经挂上画布的页"，
 * 算出这一批该新挂哪几张 —— 按页号升序、跳过已挂的、最多 `limit` 张。
 * 分批的理由：进视口那一下不一次起 50 个 canvas（50 次 getPage / 50 次渲染）。
 */
// eslint-disable-next-line react-refresh/only-export-components -- 纯口径，单测要直接打它；拆文件不值当
export function nextThumbBatch(
  wanted: readonly number[],
  mounted: readonly number[],
  limit: number
): number[] {
  const have = new Set(mounted)
  const batch: number[] = []
  for (const page of [...new Set(wanted)].sort((a, b) => a - b)) {
    if (have.has(page)) continue
    batch.push(page)
    if (batch.length >= limit) break
  }
  return batch
}

/** 页面容器的可用宽（减掉左右内边距 —— canvas 的 `max-w-full` 按内容盒裁，不减就会把高度算多） */
function contentWidthOf(host: HTMLElement, fallback: number = WIDTH_FALLBACK): number {
  const style = window.getComputedStyle(host)
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
  const width = host.clientWidth - padding
  return width > 0 ? width : fallback
}

/** 把每张画布的 CSS 尺寸按倍率缩放（同步；位图不动 —— 旧图被拉伸显示，等防抖那趟重画） */
function scaleCanvases(host: HTMLElement, factor: number): void {
  if (!(factor > 0) || factor === 1) return
  for (const canvas of host.querySelectorAll('canvas')) {
    const width = Number.parseFloat(canvas.style.width)
    const height = Number.parseFloat(canvas.style.height)
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue
    canvas.style.width = `${Math.round(width * factor)}px`
    canvas.style.height = `${Math.round(height * factor)}px`
  }
}

/** 在页序里插画布：可见页优先的重画可能先建后面的页，DOM 顺序仍要是 1..N */
function insertInPageOrder(host: HTMLElement, canvas: HTMLCanvasElement, page: number): void {
  const following = Array.from(host.children).find(
    (node) => Number((node as HTMLElement).dataset.page) > page
  )
  host.insertBefore(canvas, following ?? null)
}

/** 渲染顺序（纯函数）：可见页升序在前，其余按页号补 —— 用户正看着的那页先变清晰 */
function pageOrderOf(count: number, visible: Iterable<number>): number[] {
  const front = [...new Set(visible)]
    .filter((page) => page >= 1 && page <= count)
    .sort((a, b) => a - b)
  const seen = new Set(front)
  for (let page = 1; page <= count; page += 1) if (!seen.has(page)) front.push(page)
  return front
}

/** 画一页到可见画布：新倍率先画进离屏，再一个同步块里"改尺寸 + 贴回"（中间没有 await，看不到空白帧） */
async function paintPage(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  cssScale: number,
  pixelRatio: number
): Promise<void> {
  const base = page.getViewport({ scale: 1 })
  canvas.style.width = `${Math.max(1, Math.floor(base.width * cssScale))}px`
  canvas.style.height = `${Math.max(1, Math.floor(base.height * cssScale))}px`
  const viewport = page.getViewport({ scale: cssScale * pixelRatio })
  const width = Math.max(1, Math.floor(viewport.width))
  const height = Math.max(1, Math.floor(viewport.height))
  const context = canvas.getContext('2d')
  if (context === null) {
    // 没有 2d 上下文（jsdom）：只记尺寸，不画 —— 页数与版式照旧记账
    canvas.width = width
    canvas.height = height
    return
  }
  const stage = document.createElement('canvas')
  stage.width = width
  stage.height = height
  const stageContext = stage.getContext('2d')
  if (stageContext !== null) {
    await page.render({ canvasContext: stageContext, viewport, canvas: stage }).promise
  }
  canvas.width = width
  canvas.height = height
  context.drawImage(stage, 0, 0)
}

/** 画一张缩略图（低倍；画布尺寸随页面比例，摆在固定比例的框里 object-contain 居中） */
async function paintThumb(
  page: PdfPage,
  canvas: HTMLCanvasElement,
  pixelRatio: number
): Promise<void> {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * pixelRatio })
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const context = canvas.getContext('2d')
  if (context === null) return
  await page.render({ canvasContext: context, viewport, canvas }).promise
}

/** 目录项的目的地 → 页码（拿不到给 null：这一项就不进目录，而不是跳到一个瞎猜的页） */
async function pageOfDest(doc: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const target = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    const ref = Array.isArray(target) ? target[0] : null
    if (ref === null || typeof ref !== 'object') return null
    const index = await doc.getPageIndex(ref as Parameters<PdfDocument['getPageIndex']>[0])
    return typeof index === 'number' && index >= 0 ? index + 1 : null
  } catch {
    return null
  }
}

/** outline 树 → 扁平目录（带层级缩进与页码）；解析不出来的节点跳过，子树照走 */
async function outlineEntriesOf(doc: PdfDocument): Promise<OutlineEntry[]> {
  const nodes = await doc.getOutline()
  if (nodes === null || nodes.length === 0) return []
  const entries: OutlineEntry[] = []
  const walk = async (items: PdfOutlineNode[], depth: number, path: string): Promise<void> => {
    for (const [index, node] of items.entries()) {
      const key = `${path}/${index}`
      const page = await pageOfDest(doc, node.dest)
      if (page !== null) {
        entries.push({ key, title: node.title.trim() || `第 ${page} 页`, depth, page })
      }
      if (node.items.length > 0) await walk(node.items, depth + 1, key)
    }
  }
  await walk(nodes, 0, '')
  return entries
}

export function PdfPreview({ bytes }: { bytes: Uint8Array }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const thumbListRef = useRef<HTMLDivElement | null>(null)

  /** 打开的那份文档（命令式渲染用；React 侧只关心"画到哪一步了"） */
  const docRef = useRef<PdfDocument | null>(null)
  /** 这一份要画多少页（min(总页数, 上限)） */
  const countRef = useRef(0)
  /** 上次量到的可用宽（宽变化时按比例铺尺寸） */
  const widthRef = useRef<number | null>(null)
  /** 当前档（命令式那一手读它，不读 state） */
  const zoomRef = useRef<number>(PDF_ZOOM_DEFAULT)
  /** 已经按哪个口径（档 + 宽）铺过尺寸了：防抖的重画据此去重，不做白工 */
  const paintedRef = useRef('')
  /** 渲染代次：新的一趟开工即作废旧的一趟（可见页优先的重画不会互相踩） */
  const tokenRef = useRef(0)
  /** 当前在视口里的页（页 → 该页顶边相对滚动口顶边的偏移；IntersectionObserver 维护） */
  const visibleRef = useRef(new Map<number, number>())
  /** 缩略图：进过视口的页 / 已经挂上画布的页（都是命令式镜，state 只管渲染） */
  const wantedRef = useRef(new Set<number>())
  const mountedRef = useRef<number[]>([])
  const paintedThumbsRef = useRef(new Set<number>())

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  /** 已经画出来的页数（data-pages；截断提示也看它） */
  const [drawnPages, setDrawnPages] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  /** 这一份要画多少页（侧栏列表按它铺） */
  const [pageCount, setPageCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number>(PDF_ZOOM_DEFAULT)
  /** 容器宽变过（重画的口径变了）→ 触发防抖那一趟 */
  const [widthTick, setWidthTick] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'thumbs' | 'outline'>('thumbs')
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  /** 缩略图框的宽高比（按第一页；各页比例不同就让画布 object-contain 居中） */
  const [thumbAspect, setThumbAspect] = useState('1 / 1.414')
  /** 已经挂上画布的缩略图页号（渲染用；命令式镜像在 mountedRef） */
  const [mountedThumbs, setMountedThumbs] = useState<number[]>([])
  /** 视口里来了新页 → 触发下一批挂载 */
  const [thumbTick, setThumbTick] = useState(0)

  /**
   * 一趟渲染（整本）：建缺的画布、按当前口径铺尺寸、位图不在这一档的重画（可见页优先）。
   * 同时只允许一趟在跑：开工即取一个令牌，旧的一趟在下一个检查点自己退场。
   */
  const renderPass = useCallback(async (doc: PdfDocument, host: HTMLElement): Promise<void> => {
    const count = countRef.current
    if (count === 0) return
    const token = (tokenRef.current += 1)
    const width = contentWidthOf(host)
    const zoomLevel = zoomRef.current
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
    paintedRef.current = `${zoomLevel}|${Math.round(width)}`

    for (const page of pageOrderOf(count, visibleRef.current.keys())) {
      if (tokenRef.current !== token) return
      const pdfPage = await doc.getPage(page)
      const base = pdfPage.getViewport({ scale: 1 })
      const cssScale = (width / base.width) * zoomLevel
      let canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-page="${page}"]`)
      if (canvas === null) {
        canvas = document.createElement('canvas')
        canvas.setAttribute('data-page', String(page))
        // `mx-auto`：装得下时居中（既有观感），装不下时 auto 边距归零 → 左对齐，
        // 横向滚动能摸到左边（flex 的 items-center 在溢出时左侧是够不着的）。
        // **不挂 `max-w-full`**：那会把放大后的宽度夹回容器宽、而高度还是放大值 —— 页面被拉长。
        canvas.className = 'mx-auto block'
        insertInPageOrder(host, canvas, page)
      }
      if (page === 1) setThumbAspect(`${Math.round(base.width)} / ${Math.round(base.height)}`)
      const scale = String(Math.round(cssScale * 1000) / 1000)
      if (canvas.dataset.scale === scale) continue // 位图已经是这一档（比如上一趟被顶掉之前画过了）
      await paintPage(pdfPage, canvas, cssScale, pixelRatio)
      canvas.dataset.scale = scale
    }

    if (tokenRef.current !== token) return
    if (host.querySelectorAll('canvas').length >= count) {
      setDrawnPages(count)
      setStatus('ready')
    }
  }, [])

  /** 防抖后的重画：口径没变（同一档同一宽）就不做白工 */
  const repaint = useCallback((): void => {
    const doc = docRef.current
    const host = hostRef.current
    if (doc === null || host === null) return
    if (paintedRef.current === `${zoomRef.current}|${Math.round(contentWidthOf(host))}`) return
    void renderPass(doc, host)
  }, [renderPass])

  /** 调一档：**先同步铺尺寸**（观感与布局当场跟上），重画交给下面那道防抖 */
  const zoomBy = useCallback((direction: 1 | -1): void => {
    const next = stepZoom(zoomRef.current, direction)
    if (next === zoomRef.current) return
    const factor = next / zoomRef.current
    zoomRef.current = next
    const host = hostRef.current
    if (host !== null) scaleCanvases(host, factor)
    setZoom(next)
  }, [])

  /** 跳页：当前页立刻高亮（滚动是平滑的，别等它滚到） */
  const jumpToPage = useCallback((page: number): void => {
    setCurrentPage(page)
    const scroller = scrollRef.current
    const canvas =
      hostRef.current?.querySelector<HTMLElement>(`canvas[data-page="${page}"]`) ?? null
    if (scroller === null || canvas === null) return
    const top =
      scroller.scrollTop + canvas.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'smooth' })
    else scroller.scrollTop = top
  }, [])

  /** 打开文档 → 首趟渲染（换文件的归零交给 PreviewBody 的 key=relative 重挂，这里只清旧画布） */
  useEffect(() => {
    let cancelled = false
    let loading: PdfLoadingTask | null = null
    // 容器与组件同生命周期（下面一直渲染着它），cleanup 里用这个捕获值，不读会变的 ref.current
    const host = hostRef.current
    host?.replaceChildren()
    docRef.current = null
    countRef.current = 0
    paintedRef.current = ''
    tokenRef.current += 1
    widthRef.current = null
    visibleRef.current.clear()
    wantedRef.current.clear()
    mountedRef.current = []
    paintedThumbsRef.current.clear()

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
        docRef.current = pdfDocument
        countRef.current = Math.min(pdfDocument.numPages, PDF_PAGE_LIMIT)
        setTotalPages(pdfDocument.numPages)
        setPageCount(countRef.current)
        if (host === null) return
        // 目录：拿不到（没书签 / 解析不出）就只留缩略图那一档，不当错误
        void outlineEntriesOf(pdfDocument).then(
          (entries) => {
            if (!cancelled) setOutline(entries)
          },
          () => undefined
        )
        await renderPass(pdfDocument, host)
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
  }, [bytes, renderPass])

  /** 调档 / 变宽 → 防抖重画（这段时间里页面已经被同步铺好了） */
  useEffect(() => {
    if (pageCount === 0) return
    const timer = window.setTimeout(repaint, REPAINT_DELAY)
    return () => window.clearTimeout(timer)
  }, [zoom, widthTick, pageCount, repaint])

  /** 容器宽变了（侧栏开合 / 面板缩放 / 全屏）：按宽度比例同步铺开（页面始终适应宽度），再防抖重画 */
  useEffect(() => {
    const host = hostRef.current
    if (host === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      const width = contentWidthOf(host, 0)
      if (width <= 0) return // 面板收起 / 没布局（w-0）：先不动，等它回来
      const previous = widthRef.current
      if (previous !== null && Math.abs(previous - width) < 1) return
      widthRef.current = width
      if (previous !== null) scaleCanvases(host, width / previous)
      setWidthTick((tick) => tick + 1)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  /** 缩略图：进视口的页记账（懒渲染的入口）；没有 IntersectionObserver 就全要（照样分批挂） */
  useEffect(() => {
    if (pageCount === 0 || !sidebarOpen || sidebarTab !== 'thumbs') return
    const scroller = thumbListRef.current
    if (scroller === null) return
    if (typeof IntersectionObserver !== 'function') {
      for (let page = 1; page <= pageCount; page += 1) wantedRef.current.add(page)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        let added = false
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const page = Number((entry.target as HTMLElement).dataset.thumbPage)
          if (!Number.isInteger(page) || wantedRef.current.has(page)) continue
          wantedRef.current.add(page)
          added = true
        }
        if (added) setThumbTick((tick) => tick + 1)
      },
      { root: scroller, rootMargin: '200px 0px' }
    )
    for (const node of scroller.querySelectorAll('[data-thumb-page]')) observer.observe(node)
    return () => observer.disconnect()
  }, [pageCount, sidebarOpen, sidebarTab, drawnPages])

  /** 懒挂：进过视口的页每批挂 `THUMB_BATCH` 张（一批一帧，别一次起 50 个 canvas） */
  useEffect(() => {
    if (pageCount === 0 || !sidebarOpen || sidebarTab !== 'thumbs') return
    const timer = window.setTimeout(() => {
      const batch = nextThumbBatch([...wantedRef.current], mountedRef.current, THUMB_BATCH)
      if (batch.length === 0) return
      mountedRef.current = [...mountedRef.current, ...batch]
      setMountedThumbs(mountedRef.current)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [thumbTick, mountedThumbs, pageCount, sidebarOpen, sidebarTab, drawnPages])

  /** 挂上就画（低倍；一本只画一次 —— 失败也记账，免得反复重试卡住后面那些页） */
  useEffect(() => {
    const doc = docRef.current
    if (doc === null) return
    const pending = mountedThumbs.filter((page) => !paintedThumbsRef.current.has(page))
    if (pending.length === 0) return
    let cancelled = false
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
    void (async () => {
      for (const page of pending) {
        if (cancelled) return
        const canvas =
          thumbListRef.current?.querySelector<HTMLCanvasElement>(`canvas[data-thumb="${page}"]`) ??
          null
        if (canvas === null) continue // 还没挂上：这一轮跳过，下一轮再说
        try {
          await paintThumb(await doc.getPage(page), canvas, pixelRatio)
        } catch {
          // 缩略图画不出来不影响正文那本（记账跳过）
        }
        paintedThumbsRef.current.add(page)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mountedThumbs])

  /**
   * 当前页 + 可视页：视口里"露得最多"的那页就是当前页（滚动联动）。
   *
   * 为什么不用 IntersectionObserver：它只在"进入/离开"那一下回调，回调里的 rect 是**当时**的；
   * 停在视口里的页再滚动时不回调 → 手里那份偏移会馊掉，反查出错的当前页（真机探针实测到过）。
   * 改成 rAF 节流 + 直接量几何：确定、可复用（`visibleRef` 同时给"可见页优先重画"用）。
   * 特例：滚到底（滚动位置被夹住、末页顶不到视口顶）时认**最后一页** —— 按面积算会停在倒数第二页，
   * 与"点了末页缩略图"的直觉打架（真机探针里 3 页那份就是被夹住的情形）。
   */
  useEffect(() => {
    if (status !== 'ready' || typeof window.requestAnimationFrame !== 'function') return
    const scroller = scrollRef.current
    const host = hostRef.current
    if (scroller === null || host === null) return
    let frame = 0
    const offsets = visibleRef.current
    const measure = (): void => {
      frame = 0
      const top = scroller.getBoundingClientRect().top
      const bottom = top + scroller.clientHeight
      offsets.clear()
      let best: number | null = null
      let bestArea = 0
      let last: number | null = null
      for (const canvas of host.querySelectorAll('canvas')) {
        const page = Number((canvas as HTMLElement).dataset.page)
        if (!Number.isInteger(page)) continue
        const box = canvas.getBoundingClientRect()
        const visible = Math.min(box.bottom, bottom) - Math.max(box.top, top)
        if (visible <= 0) continue // 不在视口里（含整页在视口上方）
        offsets.set(page, box.top - top)
        last = page
        if (visible > bestArea) {
          bestArea = visible
          best = page
        }
      }
      const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1
      const current = atBottom && last !== null ? last : best
      if (current !== null) setCurrentPage(current)
    }
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure)
    }
    schedule() // 首帧也量一次（在 rAF 回调里 setState，不在 effect 体里同步 set）
    scroller.addEventListener('scroll', schedule, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', schedule)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      offsets.clear()
    }
  }, [status, drawnPages, zoom, widthTick])

  /** Ctrl + 滚轮缩放（非被动监听才拦得住 Electron 默认的"整页缩放"） */
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      zoomBy(event.deltaY < 0 ? 1 : -1)
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  const atMinZoom = zoom === PDF_ZOOM_STEPS[0]
  const atMaxZoom = zoom === PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]
  const pages = Array.from({ length: pageCount }, (_value, index) => index + 1)

  return (
    <div data-testid="pdf-viewer" className="flex h-full min-h-0">
      {/* 缩略图 / 目录侧栏：宽度过渡滑出（不硬切）；内层固定宽，动画期间内容不重排 */}
      <aside
        data-testid="pdf-sidebar"
        data-open={sidebarOpen ? 'true' : 'false'}
        inert={!sidebarOpen}
        className={cn(
          'shrink-0 overflow-hidden transition-[width] duration-(--motion-main) ease-main',
          sidebarOpen ? SIDEBAR_WIDTH_CLASS : 'w-0'
        )}
      >
        <div className={cn('flex h-full flex-col', SIDEBAR_WIDTH_CLASS)}>
          {outline.length > 0 ? (
            <div className="flex shrink-0 items-center gap-0.5 px-2 py-2">
              <SidebarTab
                testId="pdf-tab-thumbs"
                active={sidebarTab === 'thumbs'}
                onClick={() => setSidebarTab('thumbs')}
              >
                缩略图
              </SidebarTab>
              <SidebarTab
                testId="pdf-tab-outline"
                active={sidebarTab === 'outline'}
                onClick={() => setSidebarTab('outline')}
              >
                目录
              </SidebarTab>
            </div>
          ) : null}
          {sidebarTab === 'outline' && outline.length > 0 ? (
            <div
              data-testid="pdf-outline"
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]"
            >
              {outline.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  data-testid="pdf-outline-item"
                  data-page={entry.page}
                  data-current={entry.page === currentPage ? 'true' : 'false'}
                  onClick={() => jumpToPage(entry.page)}
                  style={{ paddingLeft: `${8 + Math.min(entry.depth, 3) * 10}px` }}
                  title={entry.title}
                  className={cn(
                    'block w-full cursor-default truncate rounded-control py-1 pr-2 text-left text-b2 transition-colors duration-(--motion-fast) ease-main hover:bg-hover',
                    entry.page === currentPage ? 'bg-selected text-ink' : 'text-ink-secondary'
                  )}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          ) : (
            <div
              ref={thumbListRef}
              data-testid="pdf-thumbnails"
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]"
            >
              {pages.map((page) => (
                <button
                  key={page}
                  type="button"
                  data-testid="pdf-thumb"
                  data-thumb-page={page}
                  data-current={page === currentPage ? 'true' : 'false'}
                  onClick={() => jumpToPage(page)}
                  className={cn(
                    'mb-2 flex w-full cursor-default flex-col items-center gap-1 rounded-control p-1 transition-colors duration-(--motion-fast) ease-main hover:bg-hover',
                    page === currentPage ? 'bg-selected' : null
                  )}
                >
                  <span
                    className={cn(
                      'flex w-full items-center justify-center overflow-hidden rounded-button-sm bg-secondary',
                      page === currentPage ? 'ring-2 ring-accent' : null
                    )}
                    style={{ aspectRatio: thumbAspect }}
                  >
                    {mountedThumbs.includes(page) ? (
                      <canvas data-thumb={page} className="block h-full w-full object-contain" />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      'text-c2',
                      page === currentPage ? 'text-ink' : 'text-ink-tertiary'
                    )}
                  >
                    {page}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 顶部一条：左开关、右缩放（面板内的一条工具行，不叠框线：雷点 7） */}
        <div className="flex h-9 shrink-0 items-center gap-1 px-2">
          <IconButton
            data-testid="pdf-sidebar-toggle"
            label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            icon={<PanelLeft />}
            onClick={() => setSidebarOpen((open) => !open)}
            className="border-transparent hover:bg-hover"
          />
          <span className="min-w-0 flex-1" />
          <IconButton
            data-testid="pdf-zoom-out"
            label="缩小"
            icon={<ZoomOut />}
            disabled={atMinZoom}
            onClick={() => zoomBy(-1)}
            className="border-transparent hover:bg-hover"
          />
          <IconButton
            data-testid="pdf-zoom-in"
            label="放大"
            icon={<ZoomIn />}
            disabled={atMaxZoom}
            onClick={() => zoomBy(1)}
            className="border-transparent hover:bg-hover"
          />
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {status === 'loading' ? (
            <div className="flex justify-center py-4">
              <Spinner label="加载中" className="text-ink-tertiary" />
            </div>
          ) : null}
          {status === 'error' ? (
            <p
              data-testid="file-preview-pdf-error"
              className="px-3 py-2 text-b2 text-ink-secondary"
            >
              {error ?? '读不出这个 PDF 的内容'}
            </p>
          ) : null}
          <div
            ref={hostRef}
            data-testid="file-preview-pdf"
            data-pages={drawnPages}
            data-zoom={zoom}
            className="block space-y-3 px-3 py-3"
          />
          {status === 'ready' && totalPages > drawnPages ? (
            <p data-testid="file-preview-pdf-truncated" className="pb-3 text-b2 text-ink-tertiary">
              只显示前 {drawnPages} 页（共 {totalPages} 页）
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 侧栏顶上那两档（缩略图 / 目录）：文档带书签才画出来 —— 不给假的分段控件 */
function SidebarTab({
  testId,
  active,
  onClick,
  children
}: {
  testId: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'cursor-default rounded-control px-2 py-1 text-b2 transition-colors duration-(--motion-fast) ease-main',
        active ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}
