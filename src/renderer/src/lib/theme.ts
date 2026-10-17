/**
 * 主题与字号机制：只写 html 属性，取值全在 CSS token 层。
 *   data-theme="light|dark"    → tokens/kimi-tokens.css 的深色档、Tailwind 的 dark: 变体
 *   data-font-size="small|default|large" → 字号整组换值
 * 默认跟随系统（matchMedia 监听）；持久化在设置层（shared/settings.ts + lib/settings-store.ts）。
 *
 * 取值词表来自 shared/settings 的 schema：落盘校验、IPC 入参、这里的属性写入共用一个来源。
 */
import type { FontTier, ThemeMode } from '@shared/settings'

export type { FontTier, ThemeMode }
export type ResolvedTheme = 'light' | 'dark'

export const DARK_QUERY = '(prefers-color-scheme: dark)'

const THEME_ATTR = 'data-theme'
const FONT_SIZE_ATTR = 'data-font-size'

let mode: ThemeMode = 'system'
let systemListenerAttached = false
/** 主进程解析后的明暗（system 模式下优先于 matchMedia；运行时切 themeSource 后 media query 会滞后） */
let resolvedNativeTheme: ResolvedTheme | null = null
let nativeThemeListenerAttached = false

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

/** 应用启动时调用一次：写当前主题、补默认字号档、跟随系统时挂上监听。 */
export function initTheme(): void {
  applyTheme()
  attachSystemListener()
  attachNativeThemeListener()
  void syncNativeTheme()
  if (!root().hasAttribute(FONT_SIZE_ATTR)) {
    root().setAttribute(FONT_SIZE_ATTR, 'default')
  }
}

/** 切主题模式：system 跟随主进程解析的 OS 主题（含后续变化），light / dark 是显式档。 */
export function setTheme(next: ThemeMode): void {
  mode = next
  if (next === 'system') attachNativeThemeListener()
  applyTheme()
  if (next === 'system') attachSystemListener()
}

/** 切字号档：整组换值由 CSS 的 :root[data-font-size='…'] 承担，这里只写属性。 */
export function setFontTier(tier: FontTier): void {
  root().setAttribute(FONT_SIZE_ATTR, tier)
}
