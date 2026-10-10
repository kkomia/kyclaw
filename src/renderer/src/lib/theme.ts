/**
 * 主题与字号机制：只写 html 属性，取值全在 CSS token 层。
 *   data-theme="light|dark"    → tokens/kimi-tokens.css 的深色档、Tailwind 的 dark: 变体
 *   data-font-size="small|default|large" → 字号整组换值
 * 默认跟随系统（matchMedia 监听）；偏好持久化不在这里（T5 的设置存储负责）。
 */

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type FontTier = 'small' | 'default' | 'large'

export const DARK_QUERY = '(prefers-color-scheme: dark)'

const THEME_ATTR = 'data-theme'
const FONT_SIZE_ATTR = 'data-font-size'

let mode: ThemeMode = 'system'
let systemListenerAttached = false

function root(): HTMLElement {
  return document.documentElement
}

function darkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_QUERY)
}

function resolveTheme(): ResolvedTheme {
  if (mode !== 'system') return mode
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

/** 应用启动时调用一次：写当前主题、补默认字号档、跟随系统时挂上 change 监听。 */
export function initTheme(): void {
  applyTheme()
  attachSystemListener()
  if (!root().hasAttribute(FONT_SIZE_ATTR)) {
    root().setAttribute(FONT_SIZE_ATTR, 'default')
  }
}

/** 切主题模式：system 跟随系统（含后续系统变化），light / dark 是显式档。 */
export function setTheme(next: ThemeMode): void {
  mode = next
  applyTheme()
  if (next === 'system') attachSystemListener()
}

/** 切字号档：整组换值由 CSS 的 :root[data-font-size='…'] 承担，这里只写属性。 */
export function setFontTier(tier: FontTier): void {
  root().setAttribute(FONT_SIZE_ATTR, tier)
}
