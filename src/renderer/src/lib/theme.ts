/**
 * 主题与字号机制：只写 html 属性/变量，取值全在 CSS token 层。
 *   data-theme="light|dark"  → tokens/kimi-tokens.css 的深色档、Tailwind 的 dark: 变体
 *   --ui-scale="<n>"        → 六档字号/行高按 uiFontSize / 14 缩放（semantic.css 的 calc）
 * 默认跟随系统（matchMedia 监听）；持久化在设置层（shared/settings.ts + lib/settings-store.ts）。
 *
 * task-69：字号设置从三档（small/default/large，整组换值）改成**连续数值**（12–18px，默认 14）。
 * 应用不再是 `html[data-font-size]`，而是 html 上的 `--ui-scale`；默认 14 → scale=1.000，
 * 六档字号/行高与改造前逐字一致（computed 不变）。
 */
import { UI_FONT_SIZE_DEFAULT, type ThemeMode } from '@shared/settings'

export type { ThemeMode }
export type ResolvedTheme = 'light' | 'dark'

export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 基准字号：scale = uiFontSize / 这一档；改它等于改全站基准，别轻易动 */
export const UI_FONT_SIZE_BASE = UI_FONT_SIZE_DEFAULT

const THEME_ATTR = 'data-theme'
const UI_SCALE_PROP = '--ui-scale'

let mode: ThemeMode = 'system'
let systemListenerAttached = false
/** 主进程解析后的明暗（system 模式下优先于 matchMedia；运行时切 themeSource 后 media query 会滞后） */
let resolvedNativeTheme: ResolvedTheme | null = null
let nativeThemeListenerAttached = false
/** 当前字号（px）：只在这里记，供 theme.spec / settings-store 读回；CSS 侧看 --ui-scale */
let currentFontSize = UI_FONT_SIZE_BASE

function root(): HTMLElement {
  return document.documentElement
}

function darkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_QUERY)
}

function resolveTheme(): ResolvedTheme {
  if (mode !== 'system') return mode
  if (resolvedNativeTheme !== null) return resolvedNativeTheme
  return darkQuery()?.matches ? 'dark' : 'light'
}

function applyTheme(): void {
  root().setAttribute(THEME_ATTR, resolveTheme())
}

/** 字号 → `--ui-scale`（保留 3 位；14 → "1.000"，12 → "0.857"，18 → "1.286"） */
function applyUiScale(fontSize: number): void {
  const scale = fontSize / UI_FONT_SIZE_BASE
  root().style.setProperty(UI_SCALE_PROP, scale.toFixed(3))
}

function handleSystemChange(): void {
  if (mode === 'system') applyTheme()
}

function attachSystemListener(): void {
  if (systemListenerAttached) return
  const query = darkQuery()
  if (!query) return
  query.addEventListener('change', handleSystemChange)
  systemListenerAttached = true
}

/** 主进程推送 / 查询到的解析主题：system 模式下立即应用；显式档只记录，切回 system 时使用。 */
export function setResolvedNativeTheme(theme: ResolvedTheme | null): void {
  resolvedNativeTheme = theme
  if (mode === 'system') applyTheme()
}

function attachNativeThemeListener(): void {
  if (nativeThemeListenerAttached) return
  const onChanged = window.kyclaw?.settings?.onThemeChanged
  if (typeof onChanged !== 'function') return
  onChanged((theme) => setResolvedNativeTheme(theme))
  nativeThemeListenerAttached = true
}

async function syncNativeTheme(): Promise<void> {
  const effectiveTheme = window.kyclaw?.settings?.effectiveTheme
  if (typeof effectiveTheme !== 'function') return
  try {
    setResolvedNativeTheme(await effectiveTheme())
  } catch {
    // 读不到就继续用 matchMedia / 当前值；主题不应拦住启动
  }
}

/** 应用启动时调用一次：写当前主题、写默认字号 scale、跟随系统时挂上监听。 */
export function initTheme(): void {
  applyTheme()
  attachSystemListener()
  attachNativeThemeListener()
  void syncNativeTheme()
  // 首帧默认（设置读盘完成前）：与改造前一样使用"默认字号"；14px → scale=1
  applyUiScale(currentFontSize)
}

/** 切主题模式：system 跟随主进程解析的 OS 主题（含后续变化），light / dark 是显式档。 */
export function setTheme(next: ThemeMode): void {
  mode = next
  if (next === 'system') attachNativeThemeListener()
  applyTheme()
  if (next === 'system') attachSystemListener()
}

/**
 * 切字号（px）：把 `--ui-scale` 写到 html 上，六档字号/行高由 semantic.css 的 calc 消费。
 * 越界/非整数在 shared schema 与 settings-store 已挡；这里按最近整数夹取一次，属性永远合法。
 */
export function setUiFontSize(fontSize: number): void {
  currentFontSize = Math.min(18, Math.max(12, Math.round(fontSize)))
  applyUiScale(currentFontSize)
}

/** 当前字号（px）——设置页控件/测试读回用；不读 CSS 计算值（避免依赖布局） */
export function getUiFontSize(): number {
  return currentFontSize
}
