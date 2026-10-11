/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { WebviewElement } from './features/workbench/webview-element'

/**
 * `<webview>` 标签的属性（Electron 的内嵌浏览器）：只有这几种属性是 Electron 认的，
 * 行为面（方法/事件）在 features/workbench/webview-element.ts。
 * 分区与安全口径**不由渲染端决定**：主进程在 will-attach-webview 里钉死
 * （见 main/webview.ts），这里写什么 partition 都进不去。
 */
export interface WebviewAttributes extends HTMLAttributes<WebviewElement> {
  src?: string
  partition?: string
  allowpopups?: string
  useragent?: string
  webpreferences?: string
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<WebviewAttributes, WebviewElement>
    }
  }
}
