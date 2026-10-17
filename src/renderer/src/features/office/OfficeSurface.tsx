/**
 * Office 隔离面宿主（M3-S1 握手 → S2 投递文档字节 → S3 保存链路）。
 *
 * 为什么是 iframe（而不是直接挂主 renderer）：隔离面必须跑在**另一个 origin**
 * （preview/打包态是 `kyclaw-office://surface`）上，才能拿独立 CSP（`'wasm-unsafe-eval'` 只在面里）
 * 且没有 preload —— 面拿不到 `window.kyclaw`、拿不到任何 IPC。选型与代价见
 * `.superpowers/handover/office-docx-plan.md` §2。
 *
 * S2：`documentInfo` + `documentBytes` → ready 后用 `postMessage`（结构化克隆）发 `doc:open`；
 *     同一文档只发一次，换文档（切标签）重新发；`theme` 运行中切换用同一个 nonce 重发
 *     `surface:init`（面每次 init 都重新应用主题，**不重载 iframe**）。
 * S3：消息面扩成保存链路 —— 面 `doc:changed` / `doc:save-request` / `doc:error` 回调给壳；
 *     壳经命令式句柄 `requestSaveBytes()`（`doc:save` → 等 `doc:save-bytes`）、
 *     `reloadDocument()`（`doc:reload`）、`closeDocument()`（`doc:close`）驱动面。
 *
 * 安全要点：
 *   - `sandbox="allow-scripts allow-same-origin"` 就这两项；跨源下**不给** allow-top-navigation；
 *   - 父页是 `file://`（origin 为 opaque），所以**不靠 event.origin 判来源**，只认
 *     `event.source === iframe.contentWindow`；所有消息都带面生成的 nonce；
 *   - 不新增 preload / IPC 通道：面的 URL 由 `office:config`（主进程）或 surface-url.ts（兜底）给。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import {
  isDocChanged,
  isDocError,
  isDocLoaded,
  isDocSaveBytes,
  isDocSaveRequest,
  isSurfaceFatal,
  isSurfaceShortcut,
  isSurfaceHello,
  isSurfaceReady,
  type DocCloseMessage,
  type DocOpenMessage,
  type DocReloadMessage,
  type DocSaveMessage,
  type ShellToSurfaceMessage,
  type SurfaceShortcutAction,
  type SurfaceTheme
} from '@renderer/office/bridge-protocol'
import { currentSurfaceUrl } from './surface-url'

/** 面状态：loading = 已建 iframe 等握手；ready = 面已应用 init；fatal = 等了超时/面自报崩溃 */
export type OfficeSurfaceStatus = 'loading' | 'ready' | 'fatal'

/** 面内错误阶段（与 bridge-protocol 的 DocErrorPhase 一致） */
export type OfficeSurfaceErrorPhase = 'open' | 'layout' | 'save' | 'runtime'

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
  /** 面文档挂载 + 首次布局完成（页数） */
  onDocLoaded?: (pages: number) => void
  /** 面报告用户编辑（revision 单调；壳的 editSeq 只信这条） */
  onDocChanged?: (revision: number) => void
  /** 面内触发保存（编辑器自己的 Ctrl+S / File > Save）→ 壳保存状态机 */
  onDocSaveRequest?: () => void
  /** 面内错误（打开/布局/保存/运行时） */
  onDocError?: (phase: OfficeSurfaceErrorPhase, message: string) => void
  /**
   * M3-S4：焦点在 iframe 内时的快捷键（Ctrl+S/W/Tab）由面转发过来。
   * 壳侧不关心键值，只按动作走 `office-actions` 的同一条分发。
   */
  onShortcut?: (action: SurfaceShortcutAction) => void
  /** 握手超时：超过就当 fatal（壳可以重载 iframe；S2 只展示错误） */
  readyTimeoutMs?: number
  /** 覆盖 surface URL（单测用；默认按 surface-url.ts 从 location 现算） */
  surfaceUrl?: string
}

/** 壳持着这个句柄驱动面内编辑器（S3 保存/重载/关闭） */
export interface OfficeSurfaceHandle {
  /** 保存三阶段的 generate：doc:save → 等 doc:save-bytes；失败/超时回 null */
  requestSaveBytes(): Promise<Uint8Array | null>
  /** 冲突后从磁盘字节重载（会丢内存修改；调用方负责确认） */
  reloadDocument(bytes: Uint8Array): void
  /** 卸载面内编辑器（关标签/整面重载前） */
  closeDocument(): void
}

/** 一次保存请求的等待上限（generate 含 64MB 文档 flush+save，给足余量） */
const SAVE_REQUEST_TIMEOUT_MS = 60_000

export const OfficeSurface = forwardRef<OfficeSurfaceHandle, OfficeSurfaceProps>(
  function OfficeSurface(
    {
      onStatusChange,
      locale = 'zh-CN',
      theme = 'light',
      documentInfo,
      documentBytes,
      onDocLoaded,
      onDocChanged,
      onDocSaveRequest,
      onDocError,
      onShortcut,
      readyTimeoutMs = 15_000,
      surfaceUrl
    },
    ref
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null)
    const statusRef = useRef<OfficeSurfaceStatus>('loading')
    const [status, setStatus] = useState<OfficeSurfaceStatus>('loading')
    const [fatalMessage, setFatalMessage] = useState('')
    const [url] = useState(() => surfaceUrl ?? currentSurfaceUrl())

    /** 面生成的握手 nonce（hello 时记下；所有壳→面消息都带它） */
    const nonceRef = useRef<string | null>(null)
    /** 最近一次发出去的 init 指纹（避免 ready 状态变化时重复发同一份 init） */
    const sentInitRef = useRef<string | null>(null)
    /** 最近一次发出去的文档指纹（同一文档不重发；换标签/重读不同版本才重发） */
    const sentDocRef = useRef<string | null>(null)
    /** 在途的 generate 请求：requestId → resolve（超时/关闭时以 null 兑现） */
    const pendingSavesRef = useRef(new Map<string, (bytes: Uint8Array | null) => void>())

    // documentInfo 放 ref（命令式 close 需要最新 documentId；不参与渲染依赖）
    const documentInfoRef = useRef(documentInfo)
    useEffect(() => {
      documentInfoRef.current = documentInfo
    }, [documentInfo])

    // 回调/最新 props 放 ref：父组件传内联函数或切主题不会让下面那个握手 effect 反复重挂
    const localeRef = useRef(locale)
    const themeRef = useRef(theme)
    const onDocLoadedRef = useRef(onDocLoaded)
    const onDocChangedRef = useRef(onDocChanged)
    const onDocSaveRequestRef = useRef(onDocSaveRequest)
    const onDocErrorRef = useRef(onDocError)
    const onStatusChangeRef = useRef(onStatusChange)
    const onShortcutRef = useRef(onShortcut)
    useEffect(() => {
      localeRef.current = locale
      themeRef.current = theme
      onDocLoadedRef.current = onDocLoaded
      onDocChangedRef.current = onDocChanged
      onDocSaveRequestRef.current = onDocSaveRequest
      onDocErrorRef.current = onDocError
      onStatusChangeRef.current = onStatusChange
      onShortcutRef.current = onShortcut
    }, [
      locale,
      theme,
      onDocLoaded,
      onDocChanged,
      onDocSaveRequest,
      onDocError,
      onStatusChange,
      onShortcut
    ])

    /** 把消息发给面（非 ready / 没有 nonce 时不发） */
    const postToSurface = useCallback((message: Omit<ShellToSurfaceMessage, 'nonce'>): boolean => {
      const frameWindow = iframeRef.current?.contentWindow
      const nonce = nonceRef.current
      if (frameWindow === null || frameWindow === undefined || nonce === null) return false
      // targetOrigin 只能 '*'：父页无法可靠构造自定义 scheme 的 origin 串（file:// 侧 origin 为 opaque）；
      // 来源由面侧 `event.source === window.parent` + nonce 双重校验兜住
      frameWindow.postMessage({ ...message, nonce }, '*')
      return true
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        requestSaveBytes(): Promise<Uint8Array | null> {
          if (statusRef.current !== 'ready' || nonceRef.current === null) {
            return Promise.resolve(null)
          }
          const requestId = crypto.randomUUID()
          return new Promise<Uint8Array | null>((resolve) => {
            const settle = (bytes: Uint8Array | null): void => {
              if (!pendingSavesRef.current.has(requestId)) return
              pendingSavesRef.current.delete(requestId)
              resolve(bytes)
            }
            pendingSavesRef.current.set(requestId, settle)
            const message: DocSaveMessage = {
              type: 'doc:save',
              nonce: nonceRef.current ?? '',
              requestId
            }
            const sent = postToSurface({ ...message })
            if (!sent) settle(null)
            window.setTimeout(() => settle(null), SAVE_REQUEST_TIMEOUT_MS)
          })
        },
        reloadDocument(bytes: Uint8Array): void {
          const message: Omit<DocReloadMessage, 'nonce'> = { type: 'doc:reload', bytes }
          postToSurface(message)
        },
        closeDocument(): void {
          const info = documentInfoRef.current
          if (info === undefined) return
          sentDocRef.current = null
          const message: Omit<DocCloseMessage, 'nonce'> = {
            type: 'doc:close',
            documentId: info.documentId
          }
          postToSurface(message)
        }
      }),
      [postToSurface]
    )

    // 握手 effect：只随 URL / 超时重挂（主题、locale 走 ref + 独立 effect）
    useEffect(() => {
      let disposed = false
      // 清理时按"挂载那一刻"的 Map 兑现在途 generate（effect 期内不会换 Map 实例）
      const pendingSaves = pendingSavesRef.current

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
        frameWindow.postMessage(init, '*')
      }

      const onMessage = (event: MessageEvent): void => {
        const frameWindow = iframeRef.current?.contentWindow
        // 唯一可信来源：我方 iframe 的 contentWindow（file:// 父页的 origin 是 opaque，不能靠 origin）
        if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow)
          return
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
          return
        }
        if (data === null || typeof data !== 'object') return
        if (isDocLoaded(data) && data.nonce === nonceRef.current) {
          onDocLoadedRef.current?.(data.pages)
          return
        }
        if (isDocChanged(data) && data.nonce === nonceRef.current) {
          onDocChangedRef.current?.(data.revision)
          return
        }
        if (isDocSaveRequest(data) && data.nonce === nonceRef.current) {
          onDocSaveRequestRef.current?.()
          return
        }
        if (isDocSaveBytes(data) && data.nonce === nonceRef.current) {
          const settle = pendingSavesRef.current.get(data.requestId)
          if (settle !== undefined) settle(data.bytes)
          return
        }
        if (isDocError(data) && data.nonce === nonceRef.current) {
          onDocErrorRef.current?.(data.phase, data.message)
          return
        }
        if (isSurfaceShortcut(data) && data.nonce === nonceRef.current) {
          // 只信 nonce 也白搭不了：来源已在上面按 `event.source === iframe.contentWindow` 验过
          onShortcutRef.current?.(data.action)
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
        // 在途的 generate 一律以 null 兑现（避免壳的保存状态机永远等）
        for (const settle of [...pendingSaves.values()]) settle(null)
        pendingSaves.clear()
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
)
