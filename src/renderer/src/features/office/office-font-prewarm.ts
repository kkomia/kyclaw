/**
 * Office 字体启动预注册（task-76，用户口径：「字体注册要在整个产品启动时就做预注册，
 * 不要等打开的时候再注册 拖慢速度」）。
 *
 * 背景：字体注册发生在 **隔离面** 内（`office/fonts.ts`：22 面 / 46 注册 / 27MB，spike
 * 2.05–2.58s）。隔离面是 `kyclaw-office://surface`（preview/打包）或 Vite `office.html`（dev），
 * 与主 renderer 不同文档，FontFace 无法跨文档共享；能共享的是 **同一 session 的 HTTP cache**。
 *
 * 选型（task 给了三个候选，取 1+2 的组合）：
 *   1) 启动后 idle 时段创建一个 **hidden 预热 surface**（`?officePrewarm=1`，1px/不可见/
 *      pointer-events:none/aria-hidden）；面挂载即注册全部字体（不等文档），注册完回
 *      `surface:fonts-ready { prewarm:true }`；
 *   2) 预热期间字体字节经 `kyclaw-office://` 协议读入后进 Chromium HTTP cache，首个真实
 *      文档面注册时直接从 cache 读 → 首开不再等 27MB 网络/磁盘解析；
 *   3) 首个真实文档面 `surface:fonts-ready` 到达即释放预热 iframe（内存不常驻，cache 不清），
 *      预热面不复用（iframe 被移动 DOM 会重载，跨文档 FontFace 也不能复用——不硬改架构）。
 *
 * 安全/隔离口径不变：预热面就是正常 surface 文档（同一协议、同 Csp、无 preload、无外请）；
 * 只是隐藏 + 只做字体注册。失败静默（不影响聊天/其它模块），下一次真实打开照旧注册。
 *
 * 探针/报告用的可观测点（写在 documentElement.dataset 上，避免改 IPC）：
 *   data-office-font-prewarm = loading | ready | error | skipped
 *   data-office-font-prewarm-ms / -bytes / -registrations
 */
import {
  isSurfaceFontsReady,
  type SurfaceFontsReadyStats
} from '../../office/font-prewarm-protocol'
import { currentSurfaceUrl } from './surface-url'

/** 预热面加载/注册的总超时（27MB 在慢盘上也可能 >10s，给足但别无限挂着） */
const PREWARM_TIMEOUT_MS = 30_000
/** 启动后多久开始预热（避开首屏/启动 splash 的 CPU 竞争；requestIdleCallback 超时会兜底） */
const PREWARM_DELAY_MS = 800

type PrewarmState = 'idle' | 'loading' | 'ready' | 'error' | 'skipped'

let started = false
let state: PrewarmState = 'idle'

/** 纯函数：预热面 URL（加 `officePrewarm=1`；保留原 query） */
export function buildFontPrewarmUrl(surfaceUrl: string): string {
  const url = new URL(surfaceUrl)
  url.searchParams.set('officePrewarm', '1')
  return url.href
}

/** 纯函数：把注册结果写到 dataset（探针/单测可断言；不写 console 也不发 IPC） */
export function applyPrewarmDataset(
  root: { dataset: DOMStringMap },
  kind: 'loading' | 'ready' | 'error' | 'skipped',
  stats?: Pick<SurfaceFontsReadyStats, 'fetchedBytes' | 'registrations'> & { elapsedMs?: number }
): void {
  root.dataset.officeFontPrewarm = kind
  if (kind === 'ready' && stats !== undefined) {
    if (stats.elapsedMs !== undefined) {
      root.dataset.officeFontPrewarmMs = String(Math.round(stats.elapsedMs))
    }
    root.dataset.officeFontPrewarmBytes = String(stats.fetchedBytes)
    root.dataset.officeFontPrewarmRegistrations = String(stats.registrations)
  }
}

/**
 * 启动预热（幂等）。由 renderer 入口在首屏提交后排 idle 调用；jsdom/单测不应调用（会建 iframe），
 * 需要时直接测纯函数。
 */
export function startOfficeFontPrewarm(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return
  const root = document.documentElement
  if (root.dataset.officeFontPrewarm === 'skipped') return
  started = true
  state = 'loading'
  applyPrewarmDataset(root, 'loading')

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  frame.title = 'Office 字体预热'
  frame.dataset.testid = 'office-font-prewarm-frame'
  frame.style.cssText =
    'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;'
  frame.src = buildFontPrewarmUrl(currentSurfaceUrl())
  document.body.appendChild(frame)

  const startedAt = performance.now()
  let timer: number | null = null

  const finish = (next: PrewarmState): void => {
    state = next
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    window.removeEventListener('message', onMessage)
  }

  const dispose = (): void => {
    frame.remove()
  }

  const onMessage = (event: MessageEvent): void => {
    if (!isSurfaceFontsReady(event.data)) return
    const fromPrewarm = event.source === frame.contentWindow
    if (fromPrewarm) {
      if (state !== 'loading') return
      state = 'ready'
      applyPrewarmDataset(root, 'ready', {
        fetchedBytes: event.data.stats.fetchedBytes,
        registrations: event.data.stats.registrations,
        elapsedMs: performance.now() - startedAt
      })
      // 预热面自己的 ready 不算「真实打开完成」：保留 iframe 直到真实面 ready 再释放，
      // 这样预热面注册的 FontFace（若内核同源路径复用）仍可用；内存成本已是有界的。
      // 兜底：用户一直不开 Office 时也别让隐藏面常驻，给 60s 宽限期后释放（cache 不清）。
      window.setTimeout(dispose, 60_000)
      return
    }
    // 真实文档面已就绪：预热使命完成，释放 iframe（HTTP cache 留在 session）
    if (state === 'loading' || state === 'ready') {
      finish('ready')
      window.setTimeout(dispose, 0)
    }
  }

  window.addEventListener('message', onMessage)
  timer = window.setTimeout(() => {
    if (state !== 'loading') return
    finish('error')
    dispose()
  }, PREWARM_TIMEOUT_MS)
}

/** 启动期调度：优先 requestIdleCallback（首屏后），没有就 setTimeout 兜底 */
export function scheduleOfficeFontPrewarm(): void {
  if (typeof window === 'undefined') return
  const run = (): void => startOfficeFontPrewarm()
  const ric = (
    window as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (typeof ric === 'function') ric(run, { timeout: PREWARM_DELAY_MS })
  else window.setTimeout(run, PREWARM_DELAY_MS)
}

/** 只读状态（报告/调试用） */
export function officeFontPrewarmState(): PrewarmState {
  return state
}
