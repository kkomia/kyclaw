/**
 * 启动画面：**阶段百分比**、退场与失败态。
 *
 * 百分比口径（012 返工）：只由**真实启动阶段完成**推进固定档位，
 * 不按时间随机补数，也没有任何“看起来在动”的定时器。它是**阶段百分比**，
 * 不是耗时、不是预计剩余时间；卡在某一阶段（例如设置 IPC 不回来）时停在最近完成值。
 *
 * 阶段不是严格串行：设置读盘与 React 提交互不等待。更早 / 未知阶段不会让进度倒退；
 * 晚到的阶段仍会记进 `data-startup-completed-stages`，如果启动壳还在，就在
 * `.app-splash__detail` 里明确写出“设置已就绪”，百分比停在已经到达的最高档。
 * 壳已经退场后晚到的阶段也会被记录，但不会把启动壳重新盖回来。
 *
 * 阶段完成事件（与 index.html 的静态初值共用同一份阶段表）：
 *   - shell-visible   HTML/CSS 壳已解析并绘制（index.html 静态初值）
 *   - renderer-entry  main.tsx 开始执行（渲染端 bundle 已加载）
 *   - settings-loaded 设置 IPC 有结果（成功，或失败后回默认值）
 *   - react-committed React 首屏 DOM 已提交（App 的 useLayoutEffect）
 *   - splash-exit     启动壳开始退场（dismissStartupSplash 调度）
 *
 * 80 → 100 不在同一个 task 里写：React 首屏 layout effect 只写 80；100 与退场
 * 由 dismissStartupSplash 排到**下一绘制之后**，再等进度条宽度的真实 transition
 * 走完才加 `is-leaving` 淡出。这样 80 与 100 都有机会被绘制出来，等待的是 rAF /
 * CSS transition，不是“等一会儿再假装完成”的假进度。React 首屏本身不等待退场。
 *
 * 失败态优先于完成态：failStartupSplash 会取消尚未执行的退场计划；失败之后到达的
 * 阶段事件不再改可见进度，也不会把错误文案换成“启动完成”。
 */
import { startupMark } from './startup-timing'

const SPLASH_ID = 'app-splash'
const LEAVING_CLASS = 'is-leaving'
const FAILED_CLASS = 'is-failed'
const TRACK_SELECTOR = '.app-splash__track'
const FILL_SELECTOR = '.app-splash__fill'
const STATUS_SELECTOR = '.app-splash__status'
const PERCENT_SELECTOR = '.app-splash__percent'
const PERCENT_VALUE_SELECTOR = '.app-splash__percent-value'
const DETAIL_SELECTOR = '.app-splash__detail'
const STAGE_ATTR = 'data-startup-stage'
const PERCENT_ATTR = 'data-startup-percent'
const COMPLETED_STAGES_ATTR = 'data-startup-completed-stages'
const LATE_STAGE_ATTR = 'data-startup-late-stage'

export type StartupStageId =
  'shell-visible' | 'renderer-entry' | 'settings-loaded' | 'react-committed' | 'splash-exit'

export interface StartupStage {
  /** 固定档位；只增不减 */
  percent: number
  /** 这一阶段完成后的状态文案 */
  status: string
  /** 晚到（更高阶段之后才完成）时显示的短状态；不改百分比 */
  done: string
}

/** 阶段的真实先后顺序；归档已完成阶段时也按这个顺序写，便于测试与排障 */
export const STARTUP_STAGE_ORDER: readonly StartupStageId[] = [
  'shell-visible',
  'renderer-entry',
  'settings-loaded',
  'react-committed',
  'splash-exit'
]

const STAGE_IDS = new Set<string>([...STARTUP_STAGE_ORDER])

/**
 * 固定档位是“事件里程碑”的权重：五个里程碑等权（20 / 40 / 60 / 80 / 100），
 * 不是按耗时测出来的。调权重只改这里；index.html 的初始档位必须与
 * `INITIAL_STARTUP_PERCENT` 一致（单测会核对）。
 * 阶段不是严格串行：设置读盘与 React 提交互不等待，晚到的阶段不会让进度倒退。
 */
export const STARTUP_STAGES: Readonly<Record<StartupStageId, StartupStage>> = {
  'shell-visible': { percent: 20, status: '正在启动…', done: '启动壳已显示' },
  'renderer-entry': { percent: 40, status: '正在加载界面…', done: '界面已加载' },
  'settings-loaded': { percent: 60, status: '正在准备界面…', done: '设置已就绪' },
  'react-committed': { percent: 80, status: '正在进入工作区…', done: '首屏已就绪' },
  'splash-exit': { percent: 100, status: '启动完成', done: '启动完成' }
}

export const INITIAL_STARTUP_STAGE: StartupStageId = 'shell-visible'
export const INITIAL_STARTUP_PERCENT = STARTUP_STAGES[INITIAL_STARTUP_STAGE].percent

/** 与 index.html 的进度条宽度过渡同值；过渡事件没来时按它兜底（减少动效时只看下一帧） */
export const SPLASH_FILL_MS = 180
/** 与 index.html 的 opacity 过渡时长同值；过渡事件没来时按它兜底（减少动效时下一帧移除） */
export const SPLASH_FADE_MS = 180
const FILL_FALLBACK_MS = SPLASH_FILL_MS + 80
const REMOVE_FALLBACK_MS = SPLASH_FADE_MS + 80

/** 退场计划的取消入口；每次阶段切换只保留最新一份，失败时能整体取消 */
interface ExitPlan {
  cancel: () => void
}

const exitPlans = new WeakMap<HTMLElement, ExitPlan>()

function splashElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(SPLASH_ID)
}

function stageEntry(stageId: string | null): StartupStage | undefined {
  if (stageId === null || !STAGE_IDS.has(stageId)) return undefined
  return STARTUP_STAGES[stageId as StartupStageId]
}

/** 当前进度以 HTML 上的 data 属性为准；旧壳没有 data 时回落到进度条的 aria-valuenow */
function currentPercent(splash: HTMLElement): number {
  const fromData = Number(splash.getAttribute(PERCENT_ATTR) ?? NaN)
  if (Number.isFinite(fromData)) return fromData

  const track = splash.querySelector<HTMLElement>(TRACK_SELECTOR)
  const fromAria = Number(track?.getAttribute('aria-valuenow') ?? NaN)
  return Number.isFinite(fromAria) ? fromAria : 0
}

/** 已完成阶段按阶段顺序去重；存在 documentElement 上，壳移除后晚到阶段也能记录 */
function completedStageIds(): StartupStageId[] {
  if (typeof document === 'undefined') return []
  const raw = document.documentElement.getAttribute(COMPLETED_STAGES_ATTR)
  if (raw === null) return []
  const present = new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  )
  return STARTUP_STAGE_ORDER.filter((stageId) => present.has(stageId))
}

function recordStageCompletion(stageId: StartupStageId): void {
  if (typeof document === 'undefined') return
  const completed = new Set(completedStageIds())
  completed.add(stageId)
  const next = STARTUP_STAGE_ORDER.filter((entry) => completed.has(entry)).join(',')
  if (document.documentElement.getAttribute(COMPLETED_STAGES_ATTR) !== next) {
    document.documentElement.setAttribute(COMPLETED_STAGES_ATTR, next)
  }
}

/** 已完成阶段（按阶段顺序；晚到阶段也包含在内）——排障 / 单测读取 */
export function completedStartupStages(): StartupStageId[] {
  return completedStageIds()
}

function lateStageOf(splash: HTMLElement): StartupStage | undefined {
  return stageEntry(splash.getAttribute(LATE_STAGE_ATTR))
}

/** 读屏文案明确说“启动阶段百分比”，并在有晚到阶段时补一句完成状态 */
function ariaValueText(splash: HTMLElement, stage: StartupStage): string {
  const late = lateStageOf(splash)
  return `启动阶段 ${stage.percent}%，${stage.status}${late === undefined ? '' : `；${late.done}`}`
}

function syncTrackAria(splash: HTMLElement, stage: StartupStage): void {
  const track = splash.querySelector<HTMLElement>(TRACK_SELECTOR)
  if (track === null) return
  track.setAttribute('aria-valuenow', String(stage.percent))
  track.setAttribute('aria-valuetext', ariaValueText(splash, stage))
}

function setPercentLabel(splash: HTMLElement, percent: number): void {
  const label = splash.querySelector<HTMLElement>(PERCENT_SELECTOR)
  if (label === null) return
  const value = label.querySelector<HTMLElement>(PERCENT_VALUE_SELECTOR)
  if (value !== null) value.textContent = `${percent}%`
  else label.textContent = `${percent}%`
}

/**
 * 把阶段的固定百分比写进 DOM：aria-valuenow / aria-valuetext / 可见百分比 / 进度条宽度
 * 共用同一个值，避免读屏、视觉与内部状态三份数字打架。
 */
function applyStage(splash: HTMLElement, stageId: StartupStageId, stage: StartupStage): void {
  splash.setAttribute(STAGE_ATTR, stageId)
  splash.setAttribute(PERCENT_ATTR, String(stage.percent))
  syncTrackAria(splash, stage)

  const fill = splash.querySelector<HTMLElement>(FILL_SELECTOR)
  if (fill !== null) fill.style.width = `${stage.percent}%`

  const status = splash.querySelector<HTMLElement>(STATUS_SELECTOR)
  if (status !== null) status.textContent = stage.status

  setPercentLabel(splash, stage.percent)
}

/**
 * 晚到阶段（百分比已越过它）的可见交代：百分比不动，详情行写明已完成什么。
 * 这样既满足“不能倒退”，也不会把 settings-loaded 静默吞掉。
 */
function showLateCompletion(
  splash: HTMLElement,
  stageId: StartupStageId,
  stage: StartupStage
): void {
  splash.setAttribute(LATE_STAGE_ATTR, stageId)
  const detail = splash.querySelector<HTMLElement>(DETAIL_SELECTOR)
  if (detail !== null) {
    detail.textContent = stage.done
    detail.hidden = false
  }
  const currentStage = stageEntry(splash.getAttribute(STAGE_ATTR))
  if (currentStage !== undefined) syncTrackAria(splash, currentStage)
}

/**
 * 完成一个真实启动阶段，返回推进后的百分比。
 * 未知阶段 = 保持当前值；更早阶段 = 保持当前值并记录 / 显示完成状态；
 * 失败或已开始退场后只记录，不再改可见进度。
 */
export function advanceStartupSplash(stageId: StartupStageId): number {
  const stage = stageEntry(stageId)
  if (stage === undefined) {
    const splash = splashElement()
    return splash === null ? 0 : currentPercent(splash)
  }

  // 先看这一阶段是不是第一次完成：重复上报不算“晚到”，不能把旧阶段写成详情。
  const completedBefore = completedStageIds().includes(stageId)
  // 再记录完成：即使壳已经退场，阶段完成事件也不丢（单调集合，不倒退）。
  recordStageCompletion(stageId)

  const splash = splashElement()
  if (splash === null) return 0

  const current = currentPercent(splash)
  const currentStageId = splash.getAttribute(STAGE_ATTR)
  if (currentStageId !== null && currentStageId !== stageId) {
    const currentStage = stageEntry(currentStageId)
    if (currentStage !== undefined) recordStageCompletion(currentStageId as StartupStageId)
  }

  if (splash.classList.contains(LEAVING_CLASS) || splash.classList.contains(FAILED_CLASS)) {
    return current
  }

  if (stage.percent > current) {
    applyStage(splash, stageId, stage)
    return stage.percent
  }

  // 第一次完成、但百分比已被更高阶段越过：这才算“晚到”，写详情但不动百分比。
  // 同一个阶段重复上报（StrictMode / 重试）不算晚到，不再重复写详情。
  if (stageId !== currentStageId && !completedBefore) {
    showLateCompletion(splash, stageId, stage)
  }
  return current
}

/** 取消尚未走到“开始淡出”的退场计划（失败时用） */
function cancelExitPlan(splash: HTMLElement): void {
  const plan = exitPlans.get(splash)
  if (plan === undefined) return
  exitPlans.delete(splash)
  plan.cancel()
}

function isActiveSplash(splash: HTMLElement): boolean {
  return (
    splash.isConnected &&
    !splash.classList.contains(LEAVING_CLASS) &&
    !splash.classList.contains(FAILED_CLASS)
  )
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 排到下一次绘制之后：rAF 回调在绘制前执行，所以连续两帧才等于
 * “当前 DOM（80%）已经真的画过一次”。第二帧里才允许写 100。
 */
function afterNextPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const id = setTimeout(callback, 0)
    return () => clearTimeout(id)
  }

  let cancelled = false
  let first = 0
  let second = 0
  first = requestAnimationFrame(() => {
    if (cancelled) return
    second = requestAnimationFrame(() => {
      if (cancelled) return
      callback()
    })
  })
  return () => {
    cancelled = true
    if (first !== 0) cancelAnimationFrame(first)
    if (second !== 0) cancelAnimationFrame(second)
  }
}

function afterFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const id = setTimeout(callback, 0)
    return () => clearTimeout(id)
  }
  let cancelled = false
  const id = requestAnimationFrame(() => {
    if (cancelled) return
    callback()
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(id)
  }
}

/** 等进度条宽度的真实 transition 走完；减少动效时只看下一帧 */
function waitForFillTransition(splash: HTMLElement): void {
  if (prefersReducedMotion()) {
    const cancel = afterFrame(() => {
      exitPlans.delete(splash)
      if (isActiveSplash(splash)) beginLeave(splash)
    })
    exitPlans.set(splash, { cancel })
    return
  }

  const fill = splash.querySelector<HTMLElement>(FILL_SELECTOR)
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (fill !== null) fill.removeEventListener('transitionend', onTransitionEnd)
    exitPlans.delete(splash)
    if (isActiveSplash(splash)) beginLeave(splash)
  }

  const onTransitionEnd = (event: Event): void => {
    if (event.target !== fill || (event as TransitionEvent).propertyName !== 'width') return
    finish()
  }

  if (fill !== null) {
    fill.addEventListener('transitionend', onTransitionEnd)
    timer = setTimeout(finish, FILL_FALLBACK_MS)
  } else {
    // 旧壳没有进度条：没有宽度过渡可等，下一轮任务直接进入淡出。
    timer = setTimeout(finish, 0)
  }

  exitPlans.set(splash, {
    cancel: () => {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (fill !== null) fill.removeEventListener('transitionend', onTransitionEnd)
    }
  })
}

/** 真正开始淡出 + 移除；只认启动壳自己的 opacity 过渡 */
function beginLeave(splash: HTMLElement): void {
  if (!isActiveSplash(splash)) return

  splash.classList.add(LEAVING_CLASS)
  splash.setAttribute('aria-hidden', 'true')
  startupMark('启动画面退场')

  if (prefersReducedMotion()) {
    const cancel = afterFrame(() => {
      exitPlans.delete(splash)
      splash.remove()
    })
    exitPlans.set(splash, { cancel })
    return
  }

  let removed = false

  const remove = (): void => {
    if (removed) return
    removed = true
    if (timer !== undefined) clearTimeout(timer)
    splash.removeEventListener('transitionend', onTransitionEnd)
    exitPlans.delete(splash)
    splash.remove()
  }

  const onTransitionEnd = (event: Event): void => {
    if (event.target !== splash || (event as TransitionEvent).propertyName !== 'opacity') return
    remove()
  }

  splash.addEventListener('transitionend', onTransitionEnd)
  const timer = setTimeout(remove, REMOVE_FALLBACK_MS)

  exitPlans.set(splash, {
    cancel: () => {
      removed = true
      if (timer !== undefined) clearTimeout(timer)
      splash.removeEventListener('transitionend', onTransitionEnd)
    }
  })
}

/**
 * React 首屏提交后调用：把 100% 与退场排到下一次绘制之后。
 * 调用本身不写 100、不淡出；同一壳重复调用是空操作。
 */
export function dismissStartupSplash(): void {
  const splash = splashElement()
  if (splash === null || splash.classList.contains(LEAVING_CLASS)) return
  // 失败态是终点：不用“启动完成”盖掉错误文案，也不自动退场。
  if (splash.classList.contains(FAILED_CLASS)) return
  if (exitPlans.has(splash)) return

  const cancel = afterNextPaint(() => {
    exitPlans.delete(splash)
    if (!isActiveSplash(splash)) return

    // 80% 已经在上一次绘制里露出；现在写 100% 这个真实终态。
    advanceStartupSplash('splash-exit')
    waitForFillTransition(splash)
  })
  exitPlans.set(splash, { cancel })
}

/**
 * 首屏在提交前失败：停在明确错误文案上（不再转进度条，也不淡出）。
 * 尚未执行的退场计划会在这里取消；失败之后到达的阶段事件不会再改可见进度。
 * 已经退场 / 正在退场 / 没有壳 = 空操作，避免运行期错误把已经交给 React 的界面重新盖住。
 */
export function failStartupSplash(message = '启动失败，请重启 kyclaw'): void {
  const splash = splashElement()
  if (splash === null || splash.classList.contains(LEAVING_CLASS)) return

  cancelExitPlan(splash)
  splash.classList.add(FAILED_CLASS)
  splash.setAttribute('role', 'alert')
  splash.setAttribute('aria-live', 'assertive')
  // 视觉文案与读屏标签一起改；否则 aria-label 仍是“kyclaw 正在启动”
  splash.setAttribute('aria-label', 'kyclaw 启动失败')

  const status = splash.querySelector<HTMLElement>(STATUS_SELECTOR)
  if (status !== null) status.textContent = message

  const detail = splash.querySelector<HTMLElement>(DETAIL_SELECTOR)
  if (detail !== null) {
    detail.hidden = true
    detail.textContent = ''
  }

  const percentLabel = splash.querySelector<HTMLElement>(PERCENT_SELECTOR)
  if (percentLabel !== null) percentLabel.textContent = ''

  // 失败后不再有“进度”可言：aria-valuenow 停在最近完成值，valuetext 明确说失败；
  // 视觉上由 .is-failed 隐藏进度条与百分比。
  const track = splash.querySelector<HTMLElement>(TRACK_SELECTOR)
  if (track !== null) {
    if (track.getAttribute('aria-valuenow') === null) {
      track.setAttribute('aria-valuenow', String(currentPercent(splash)))
    }
    track.setAttribute('aria-valuetext', '启动失败')
    track.setAttribute('aria-hidden', 'true')
  }
}
