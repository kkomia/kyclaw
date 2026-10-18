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

type PrewarmState = 'idle' | 'loading' | 'ready' | 'error' | 'skipped'

let started = false
let state: PrewarmState = 'idle'
/** task-101：可升格复用（首个文档面直接拿走）的预热 iframe 与其 host */
let prewarmHost: HTMLDivElement | null = null
let prewarmFrame: HTMLIFrameElement | null = null
let prewarmAdopted = false
let disposeTimer: number | null = null
/** 观测计数（写 document.documentElement.dataset；不新增 IPC/权限） */
let prewarmAdoptions = 0
let prewarmFallbacks = 0
/** 是否被升格过（被升格过就不再因「其它真实面 ready」提前销毁，留给 60s 归还窗口复用） */
let prewarmEverAdopted = false
/** 预热面自握手得到的 nonce（升格时 OfficeSurface 直接沿用，不再等 5s hello 窗口） */
let prewarmNonce: string | null = null

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
  // task-100：探针可量「启动后多久开始/就绪」（performance.now 相对渲染端导航起点）
  if (kind === 'loading') root.dataset.officeFontPrewarmStartAt = String(performance.now())
  if (kind === 'ready' || kind === 'error') {
    root.dataset.officeFontPrewarmReadyAt = String(performance.now())
  }
  if (kind === 'ready' && stats !== undefined) {
    if (stats.elapsedMs !== undefined) {
      root.dataset.officeFontPrewarmMs = String(Math.round(stats.elapsedMs))
    }
    root.dataset.officeFontPrewarmBytes = String(stats.fetchedBytes)
    root.dataset.officeFontPrewarmRegistrations = String(stats.registrations)
  }
}

/**
 * 启动预热（幂等）。由 renderer 入口在**启动阶段**（首帧后）调用；
 * jsdom/单测不应调用（会建 iframe），纯函数单独测。
 *
 * task-101：预热面**不再销毁**——首个文档打开时由 OfficeSurface `takePrewarmedSurface()` 直接
 * 「升格」复用这个已注册 46 字体的 surface 文档（保持 iframe 在原 DOM 位置、只切可见性/尺寸，
 * 避免 reparent 触发文档重载）。同一文档后续换文档只走 `doc:open` 消息，字体注册 **0 次**。
 */
export function startOfficeFontPrewarm(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return
  const root = document.documentElement
  if (root.dataset.officeFontPrewarm === 'skipped') return
  started = true
  state = 'loading'
  applyPrewarmDataset(root, 'loading')

  const host = document.createElement('div')
  host.dataset.testid = 'office-font-prewarm-host'
  host.style.cssText =
    'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;display:none;'
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  // 与真实文档面同一 sandbox 口径（复用后不可放宽；预热期也不给额外权限）
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.title = 'Office 字体预热'
  frame.dataset.testid = 'office-font-prewarm-frame'
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;'
  frame.src = buildFontPrewarmUrl(currentSurfaceUrl())
  host.appendChild(frame)
  document.body.appendChild(host)
  prewarmHost = host
  prewarmFrame = frame

  // task-101：预热面在隐藏期就由壳完成 hello→init 握手（面 bootState 到 ready，字体开始注册）；
  // 升格时 OfficeSurface 直接沿用这里的 nonce，不依赖面那 5s hello 重试窗口。
  const onFrameHello = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: unknown; nonce?: unknown } | null
    if (data === null || typeof data !== 'object') return
    if (data.type !== 'surface:hello' || typeof data.nonce !== 'string') return
    prewarmNonce = data.nonce
    try {
      frame.contentWindow?.postMessage(
        {
          type: 'surface:init',
          nonce: data.nonce,
          locale: 'zh-CN',
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
        },
        '*'
      )
    } catch {
      // 面已不在：预热失败不影响主流程
    }
  }
  window.addEventListener('message', onFrameHello)

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
    if (disposeTimer !== null) {
      window.clearTimeout(disposeTimer)
      disposeTimer = null
    }
    if (prewarmAdopted) return
    host.remove()
    prewarmHost = null
    prewarmFrame = null
    prewarmNonce = null
    window.removeEventListener('message', onFrameHello)
  }

  const scheduleDispose = (delayMs: number): void => {
    if (prewarmAdopted) return
    if (disposeTimer !== null) window.clearTimeout(disposeTimer)
    disposeTimer = window.setTimeout(dispose, delayMs)
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
      // 不立即销毁：等首个文档面来「升格」复用；一直没人用的话 60s 后释放（内存有界）
      scheduleDispose(60_000)
      return
    }
    // 其它文档面已就绪（不是升格复用）：预热使命完成，释放隐藏面。
    // task-101：若预热面**曾被升格**过，不能在这里销毁 —— 归还后它还要留给下一个文档复用
    // （否则第二个文档面 ready 时把 host 删掉，后续 take 永远失败）。60s 归还窗口自行回收。
    if (prewarmEverAdopted) return
    if (state === 'loading' || state === 'ready') {
      finish('ready')
      scheduleDispose(0)
    }
  }

  window.addEventListener('message', onMessage)
  window.addEventListener('message', onFrameHello)
  timer = window.setTimeout(() => {
    if (state !== 'loading') return
    finish('error')
    dispose()
  }, PREWARM_TIMEOUT_MS)
}

/** 写观测点（dataset，探针/DOM 可查；不新增 IPC/权限） */
function writeSurfaceDataset(value: string): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.officePrewarmSurface = value
  root.dataset.officePrewarmAdoptions = String(prewarmAdoptions)
  root.dataset.officePrewarmFallbacks = String(prewarmFallbacks)
}

/** 记录一次「没有升格面可用」并给出原因（not-ready / occupied / disposed / unavailable） */
export function notePrewarmFallback(): void {
  const reason: string =
    state !== 'ready'
      ? state === 'error'
        ? 'error'
        : 'not-ready'
      : prewarmAdopted
        ? 'occupied'
        : prewarmHost === null || !prewarmHost.isConnected
          ? 'disposed'
          : prewarmNonce === null
            ? 'handshake-pending'
            : 'unavailable'
  prewarmFallbacks += 1
  writeSurfaceDataset(`fallback:${reason}`)
}

/** 可升格的预热面（启动预热已完成、未被占用） */
export interface PrewarmedSurface {
  host: HTMLDivElement
  frame: HTMLIFrameElement
  /** 预热面已握手过的 nonce（OfficeSurface 升格后直接沿用） */
  nonce: string
}

/**
 * 取走启动预热面（首个 OfficeSurface 调用）：iframe 保持原 DOM 位置，只由调用方把 host
 * 绝对定位覆盖到内容区（reparent 会重载文档，杜绝）。返回 null = 没有可用预热面（尚未 ready/
 * 已被占用/已被释放），调用方回退到自建 iframe。
 */
export function takePrewarmedSurface(): PrewarmedSurface | null {
  if (state !== 'ready' || prewarmAdopted) return null
  if (prewarmHost === null || prewarmFrame === null || !prewarmHost.isConnected) return null
  if (prewarmNonce === null) return null
  prewarmAdopted = true
  prewarmEverAdopted = true
  prewarmAdoptions += 1
  writeSurfaceDataset('adopted')
  if (disposeTimer !== null) {
    window.clearTimeout(disposeTimer)
    disposeTimer = null
  }
  return { host: prewarmHost, frame: prewarmFrame, nonce: prewarmNonce }
}

/** 归还预热面（OfficeSurface 卸载）：隐藏但保留文档（46 字体已注册，下次可继续复用）。 */
export function releasePrewarmedSurface(): void {
  if (!prewarmAdopted) return
  prewarmAdopted = false
  writeSurfaceDataset('released')
  if (prewarmHost !== null) {
    prewarmHost.style.display = 'none'
    prewarmHost.style.left = '-10000px'
    prewarmHost.style.top = '-10000px'
    prewarmHost.style.width = '1px'
    prewarmHost.style.height = '1px'
  }
  if (disposeTimer !== null) window.clearTimeout(disposeTimer)
  disposeTimer = window.setTimeout(() => {
    if (prewarmAdopted) return
    prewarmHost?.remove()
    prewarmHost = null
    prewarmFrame = null
    writeSurfaceDataset('disposed')
  }, 60_000)
}
/** 启动期调度（task-100）：**首帧画完立刻开始**，不再等 idle / 800ms 长延迟。
 *  - 先 rAF 轮询等到「浏览器已产生 paint 记录」（= splash/首屏已经上屏），再 `setTimeout(0)` 起预热，
 *    保证 27MB 字体读取/注册不跟首屏抢首次绘制；等待循环本身只是读 performance entries，成本可忽略。
 *  - 前台窗口 1-2 帧内就会拿到 paint；后台/jsdom 没有 paint 记录时 rAF 轮询有限次后退化为 setTimeout(0)
 *    （等待循环上限约 10s），不会永远不起来。
 *  - 建的是 hidden iframe，加载/注册都在后台跑；与设置读盘 / React 首屏并行。 */
export function scheduleOfficeFontPrewarm(): void {
  if (typeof window === 'undefined') return
  const run = (): void => startOfficeFontPrewarm()
  const raf =
    typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : null
  if (raf === null) {
    window.setTimeout(run, 0)
    return
  }
  const startedAt = performance.now()
  const waitPaint = (): void => {
    const painted =
      performance.getEntriesByType('paint').length > 0 || performance.now() - startedAt > 10_000
    if (painted) {
      window.setTimeout(run, 0)
      return
    }
    raf(waitPaint)
  }
  raf(waitPaint)
}

/** 只读状态（报告/调试用） */
export function officeFontPrewarmState(): PrewarmState {
  return state
}
