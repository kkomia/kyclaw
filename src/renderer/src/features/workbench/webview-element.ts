/**
 * `<webview>` 的最小类型面。
 *
 * Electron 的 `<webview>` 标签在 JSX 里没有内建类型，`electron` 包的 `WebviewTag` 又厚又带
 * 一堆我们用不到的成员；这里只手写用到的那些 —— 渲染端因此不依赖主进程侧的 d.ts
 * （`env.d.ts` 把它挂进 `React.JSX.IntrinsicElements`）。
 *
 * 事件与成员名照 Electron 文档（webview 的 DOM 事件 / 方法）；属性在 env.d.ts 里声明。
 */
export interface WebviewElement extends HTMLElement {
  src: string
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
}

/** `did-navigate` / `did-navigate-in-page` 的事件体 */
export interface WebviewNavigateEvent extends Event {
  url: string
  isMainFrame?: boolean
}

/** `page-title-updated` 的事件体 */
export interface WebviewTitleEvent extends Event {
  title: string
}

/** `did-fail-load` 的事件体（-3 = ERR_ABORTED，用户主动停下时也会来，界面不报它） */
export interface WebviewFailLoadEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

export type WebviewNavigateListener = (event: WebviewNavigateEvent) => void
export type WebviewTitleListener = (event: WebviewTitleEvent) => void
export type WebviewFailLoadListener = (event: WebviewFailLoadEvent) => void
export type WebviewSimpleListener = (event: Event) => void

/** 用户主动停止导航时 Chromium 给的错误码（不当成加载失败显示） */
export const ERR_ABORTED = -3

/**
 * 把输入框里的原文变成一个能用的 URL：
 *   - 已带 `http://` / `https://` 就用原样；
 *   - `localhost:3000` 这种本机写法补 `http://`（补 https 一定连不上）；
 *   - 其余（`example.com`、`example.com/a?b=1`）补 `https://`。
 * 空串回 null（调用方不导航）。
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^localhost(:\d+)?([/?#]|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

/** 常见加载错误码 → 人话（认不出就原样给 Chromium 的描述，不编） */
export function describeLoadError(event: { errorCode: number; errorDescription: string }): string {
  switch (event.errorCode) {
    case -105:
      return '域名解析不了：网址可能写错了'
    case -106:
      return '网络好像断了'
    case -102:
      return '连不上这个地址'
    case -104:
      return '连接被中断了'
    case -7:
      return '连接超时'
    case -201:
    case -200:
    case -202:
      return '这个网站的证书不被信任'
    case -324:
      return '这个地址没有返回内容'
    default:
      return `打不开这个地址：${event.errorDescription}`
  }
}
