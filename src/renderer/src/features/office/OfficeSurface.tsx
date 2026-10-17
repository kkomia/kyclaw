/**
 * Office 隔离面宿主（M3-S1）：一个常驻 `<iframe>` + handshake 状态机。
 *
 * 为什么是 iframe（而不是直接挂主 renderer）：隔离面必须跑在**另一个 origin**
 * （preview/打包态是 `kyclaw-office://surface`）上，才能拿独立 CSP（`'wasm-unsafe-eval'` 只在面里）
 * 且没有 preload —— 面拿不到 `window.kyclaw`、拿不到任何 IPC。选型与代价见
 * `.superpowers/handover/office-docx-plan.md` §2。
 *
 * 本步（S1）只做：iframe 容器 + `surface:hello` / `surface:init` / `surface:ready` 握手 +
 * loading/ready/fatal 状态外露（OfficePage 临时调试展示用）；**不接编辑器、不传字节**。
 *
 * 安全要点：
 *   - `sandbox="allow-scripts allow-same-origin"` 就这两项；跨源下**不给** allow-top-navigation
 *     之类的越权项（给了面就能改父页地址）；
 *   - 父页是 `file://`（origin 为 opaque），所以**不靠 event.origin 判来源**，只认
 *     `event.source === iframe.contentWindow`；init 里原样回带面生成的 nonce；
 *   - 不新增 preload / IPC 通道：面的 URL 由渲染端纯函数算（surface-url.ts）。
 */
import { useEffect, useRef, useState } from 'react'
import {
  isSurfaceFatal,
  isSurfaceHello,
  isSurfaceReady,
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
  theme?: SurfaceTheme
  /** 握手超时：超过就当 fatal（壳可以重载 iframe；S1 只展示错误） */
  readyTimeoutMs?: number
  /** 覆盖 surface URL（单测用；默认按 surface-url.ts 从 location 现算） */
  surfaceUrl?: string
}

export function OfficeSurface({
  onStatusChange,
  locale = 'zh-CN',
  theme = 'light',
  readyTimeoutMs = 15_000,
  surfaceUrl
}: OfficeSurfaceProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const onStatusChangeRef = useRef(onStatusChange)
  const statusRef = useRef<OfficeSurfaceStatus>('loading')
  const [status, setStatus] = useState<OfficeSurfaceStatus>('loading')
  const [fatalMessage, setFatalMessage] = useState('')
  const [url] = useState(() => surfaceUrl ?? currentSurfaceUrl())

  // 回调放 ref：父组件传内联函数也不会让下面那个握手 effect 反复重挂
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  useEffect(() => {
    let disposed = false

    const update = (next: OfficeSurfaceStatus, message = ''): void => {
      if (disposed || statusRef.current === next) return
      statusRef.current = next
      setStatus(next)
      setFatalMessage(message)
      onStatusChangeRef.current?.(next)
    }

    const onMessage = (event: MessageEvent): void => {
      const frameWindow = iframeRef.current?.contentWindow
      // 唯一可信来源：我方 iframe 的 contentWindow（file:// 父页的 origin 是 opaque，不能靠 origin）
      if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return
      const data: unknown = event.data
      if (isSurfaceHello(data)) {
        const init: ShellToSurfaceMessage = {
          type: 'surface:init',
          nonce: data.nonce,
          locale,
          theme
        }
        // targetOrigin 只能 '*'：父页无法可靠构造自定义 scheme 的 origin 串（file:// 侧 origin 为 opaque）；
        // 来源已由上面的 event.source 校验兜住，nonce 再兜一层
        frameWindow.postMessage(init, '*')
        return
      }
      if (isSurfaceReady(data)) {
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
  }, [locale, theme, readyTimeoutMs, url])

  return (
    <div
      data-testid="office-surface"
      data-state={status}
      className="relative flex min-h-0 flex-1 flex-col bg-white"
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
