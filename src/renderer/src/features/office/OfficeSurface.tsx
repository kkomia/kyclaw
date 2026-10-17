/**
 * Office 隔离面宿主（M3-S1 握手 → M3-S2 投递文档字节）。
 *
 * 为什么是 iframe（而不是直接挂主 renderer）：隔离面必须跑在**另一个 origin**
 * （preview/打包态是 `kyclaw-office://surface`）上，才能拿独立 CSP（`'wasm-unsafe-eval'` 只在面里）
 * 且没有 preload —— 面拿不到 `window.kyclaw`、拿不到任何 IPC。选型与代价见
 * `.superpowers/handover/office-docx-plan.md` §2。
 *
 * S2 新增：
 *   - `documentInfo` + `documentBytes`：ready 之后用 `postMessage`（结构化克隆）发 `doc:open`；
 *     同一文档只发一次，换文档（切标签）重新发。MessagePort 留到 S3；
 *   - `theme` 运行中切换：用同一个 nonce 重发 `surface:init`（面每次 init 都重新应用主题），
 *     **不重载 iframe**（P2：深色主题下隔离面仍是白底的修复）。
 *
 * 安全要点：
 *   - `sandbox="allow-scripts allow-same-origin"` 就这两项；跨源下**不给** allow-top-navigation
 *     之类的越权项（给了面就能改父页地址）；
 *   - 父页是 `file://`（origin 为 opaque），所以**不靠 event.origin 判来源**，只认
 *     `event.source === iframe.contentWindow`；init/doc:open 都带面生成的 nonce；
 *   - 不新增 preload / IPC 通道：面的 URL 由 `office:config`（主进程）或 surface-url.ts（兜底）给。
 */
import { useEffect, useRef, useState } from 'react'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import {
  isSurfaceFatal,
  isSurfaceHello,
  isSurfaceReady,
  type DocOpenMessage,
  type ShellToSurfaceMessage,
  type SurfaceTheme
} from '@renderer/office/bridge-protocol'
import { currentSurfaceUrl } from './surface-url'

/** 面状态：loading = 已建 iframe 等握手；ready = 面已应用 init；fatal = 等了超时/面自报崩溃 */
export type OfficeSurfaceStatus = 'loading' | 'ready' | 'fatal'

export interface OfficeSurfaceProps {
  /** 状态变化回调（loading 初始态不回调；OfficePage 用来做临时调试展示） */
  onStatusChange?: (status: OfficeSurfaceStatus) => void
  locale?: string
  /** 当前解析后的明暗（P2：由 office 页从 `<html data-theme>` 观察后传进来） */
  theme?: SurfaceTheme
  /** 要投递给面的文档（documentId + 版本信息）；没有 = 面只显示握手态 */
  documentInfo?: OfficeDocumentInfo
  /** 文档字节（office:read 的回包）；与 documentInfo 同时给才会发 doc:open */
  documentBytes?: Uint8Array
  /** 握手超时：超过就当 fatal（壳可以重载 iframe；S2 只展示错误） */
  readyTimeoutMs?: number
  /** 覆盖 surface URL（单测用；默认按 surface-url.ts 从 location 现算） */
  surfaceUrl?: string
}

export function OfficeSurface({
  onStatusChange,
  locale = 'zh-CN',
  theme = 'light',
  documentInfo,
  documentBytes,
  readyTimeoutMs = 15_000,
  surfaceUrl
}: OfficeSurfaceProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const onStatusChangeRef = useRef(onStatusChange)
  const statusRef = useRef<OfficeSurfaceStatus>('loading')
  const [status, setStatus] = useState<OfficeSurfaceStatus>('loading')
  const [fatalMessage, setFatalMessage] = useState('')
  const url = surfaceUrl ?? currentSurfaceUrl()

  /** 面生成的握手 nonce（hello 时记下；init/doc:open 都带它） */
  const nonceRef = useRef<string | null>(null)
  /** 最近一次发出去的 init 指纹（避免 ready 状态变化时重复发同一份 init） */
  const sentInitRef = useRef<string | null>(null)
  /** 最近一次发出去的文档指纹（同一文档不重发；换标签/重读不同版本才重发） */
  const sentDocRef = useRef<string | null>(null)
  // 回调/最新 props 放 ref：父组件传内联函数或切主题不会让下面那个握手 effect 反复重挂
  const localeRef = useRef(locale)
  const themeRef = useRef(theme)

  // 在 effect 里同步 ref（render 期改 ref 违反 React 19 的 refs 规则）
  useEffect(() => {
    localeRef.current = locale
    themeRef.current = theme
  }, [locale, theme])

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  // 握手 effect：只随 URL / 超时重挂（主题、locale 走 ref + 独立 effect）
  useEffect(() => {
    let disposed = false

    const update = (next: OfficeSurfaceStatus, message = ''): void => {
      if (disposed || statusRef.current === next) return
      statusRef.current = next
      setStatus(next)
      setFatalMessage(message)
      onStatusChangeRef.current?.(next)
    }

    /** 发 init（同一 nonce + 同一 locale/theme 不重发；hello 首次强制发） */
    const postInit = (nonce: string, force: boolean): void => {
      const frameWindow = iframeRef.current?.contentWindow
      if (frameWindow === null || frameWindow === undefined) return
      const key = `${nonce}:${localeRef.current}:${themeRef.current}`
      if (!force && sentInitRef.current === key) return
      sentInitRef.current = key
      const init: ShellToSurfaceMessage = {
        type: 'surface:init',
        nonce,
        locale: localeRef.current,
        theme: themeRef.current
      }
      // targetOrigin 只能 '*'：父页无法可靠构造自定义 scheme 的 origin 串（file:// 侧 origin 为 opaque）；
      // 来源已由上面的 event.source 校验兜住，nonce 再兜一层
      frameWindow.postMessage(init, '*')
    }

    const onMessage = (event: MessageEvent): void => {
      const frameWindow = iframeRef.current?.contentWindow
      // 唯一可信来源：我方 iframe 的 contentWindow（file:// 父页的 origin 是 opaque，不能靠 origin）
      if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return
      const data: unknown = event.data
      if (isSurfaceHello(data)) {
        nonceRef.current = data.nonce
        // 面重载 = 新 nonce：之前发过的 init/文档标记全部作废（新面要重新收）
        sentInitRef.current = null
        sentDocRef.current = null
        update('loading')
        postInit(data.nonce, true)
        return
      }
      if (isSurfaceReady(data) && data.nonce === nonceRef.current) {
        update('ready')
        return
      }
      if (isSurfaceFatal(data)) {
        update('fatal', data.message)
      }
    }

    window.addEventListener('message', onMessage)
    // 监听挂上之后再设 src（JSX 里不写 src）：避免面先加载完、hello 落在监听之前。
    // 面侧另有 250ms 重发兜底，两道保险都只为把竞态窗口压到 0。
    if (iframeRef.current !== null) iframeRef.current.src = url
    const timeout = window.setTimeout(() => {
      update(
        'fatal',
        'surface 初始化超时（若为 dev 形态，确认 Vite 已起来且 CSP 的 localhost:5173 与端口一致）'
      )
    }, readyTimeoutMs)

    return () => {
      disposed = true
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
    }
  }, [url, readyTimeoutMs])

  // 主题 / locale 运行中变化：ready 后重发一次 init（面每次 init 都重新应用主题，不重载 iframe）
  useEffect(() => {
    if (status !== 'ready') return
    const nonce = nonceRef.current
    const frameWindow = iframeRef.current?.contentWindow
    if (nonce === null || frameWindow === null || frameWindow === undefined) return
    const key = `${nonce}:${locale}:${theme}`
    if (sentInitRef.current === key) return
    sentInitRef.current = key
    const init: ShellToSurfaceMessage = { type: 'surface:init', nonce, locale, theme }
    frameWindow.postMessage(init, '*')
  }, [locale, theme, status])

  // 文档投递：ready 之后、同一文档只发一次；切标签/重读不同版本（sha/长度变化）会重发
  useEffect(() => {
    if (status !== 'ready' || documentInfo === undefined || documentBytes === undefined) return
    const nonce = nonceRef.current
    const frameWindow = iframeRef.current?.contentWindow
    if (nonce === null || frameWindow === null || frameWindow === undefined) return
    const key = `${documentInfo.documentId}:${documentInfo.sha256}:${documentBytes.byteLength}`
    if (sentDocRef.current === key) return
    sentDocRef.current = key
    const message: DocOpenMessage = {
      type: 'doc:open',
      nonce,
      documentId: documentInfo.documentId,
      name: documentInfo.displayName,
      sha256: documentInfo.sha256,
      readOnly: documentInfo.readOnly,
      bytes: documentBytes
    }
    frameWindow.postMessage(message, '*')
  }, [documentInfo, documentBytes, status])

  return (
    <div
      data-testid="office-surface"
      data-state={status}
      data-theme={theme}
      data-document-id={documentInfo?.documentId ?? ''}
      className="relative flex min-h-0 flex-1 flex-col bg-surface"
    >
      {/*
        src 不写在 JSX 里：由上面的 effect 在 message 监听挂好之后赋值（避免竞态）。
        React 不会替我们清掉命令式设置的 src —— 后续重渲染时该属性不在 props diff 里。
      */}
      <iframe
        ref={iframeRef}
        data-testid="office-surface-iframe"
        data-status={status}
        title="Office 隔离面"
        className="h-full min-h-0 w-full flex-1 border-0"
        sandbox="allow-scripts allow-same-origin"
      />
      {status === 'fatal' ? (
        <div
          data-testid="office-surface-fatal"
          role="alert"
          className="absolute inset-x-0 bottom-0 border-t border-hairline bg-secondary px-4 py-2 text-c1 text-warning"
        >
          隔离面启动失败：{fatalMessage === '' ? '未知原因' : fatalMessage}
        </div>
      ) : null}
    </div>
  )
}
