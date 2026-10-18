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
 * A4.5：面发起保存时带 requestId（`doc:save-request`），壳写盘落定后用 `resolveSaveResult()`
 *     回 `doc:save-result` —— 面内 QAT 的保存态因此是事件驱动的（没有乐观计时器）。
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
  type DocSaveResultMessage,
  type ShellToSurfaceMessage,
  type SurfaceShortcutAction,
  type SurfaceTheme
} from '@renderer/office/bridge-protocol'
import {
  notePrewarmFallback,
  releasePrewarmedSurface,
  takePrewarmedSurface
} from './office-font-prewarm'
import { officeDebugEnabled } from './office-ui-store'
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
  /** 面内触发保存（A4.5：QAT 按钮 / 面内 Ctrl+S，带 requestId）→ 壳保存状态机；结果用 resolveSaveResult 回执 */
  onDocSaveRequest?: (request: { requestId: string; documentId: string }) => void
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
  /** D17：测试探针缝（仅未打包 + KYCLAW_OFFICE_PROBE=1；拼进面 URL 的 ?officeProbe=1） */
  probe?: boolean
}

/** 壳持着这个句柄驱动面内编辑器（S3 保存/重载/关闭） */
export interface OfficeSurfaceHandle {
  /** 保存三阶段的 generate：doc:save → 等 doc:save-bytes；失败/超时回 null */
  requestSaveBytes(): Promise<Uint8Array | null>
  /**
   * A4.5：把壳的写盘结果回执给面（`doc:save-result`）→ 面内 QAT 从「保存中」落到 已保存/错误。
   * 只有当前这个 iframe 会收到（每个 workspace 一份 surface，多 iframe 天然隔离）。
   */
  resolveSaveResult(result: {
    requestId: string
    ok: boolean
    code?: string
    message?: string
  }): void
  /** 冲突后从磁盘字节重载（会丢内存修改；调用方负责确认） */
  reloadDocument(bytes: Uint8Array): void
  /** 卸载面内编辑器（关标签/整面重载前） */
  closeDocument(): void
}

/** 一次保存请求的等待上限（generate 含 64MB 文档 flush+save，给足余量） */
const SAVE_REQUEST_TIMEOUT_MS = 60_000

/**
 * A1：DEV + localStorage 调试开关打开时，给隔离面 URL 拼 `?officeDebug=1` —— 面内那条
 * 「surface ready / theme / 已收到…」调试条才会显示（默认隐藏，交付态干净）。
 * 非 dev / 开关关：URL 原样（单测与 preview 探针断言的 src 不变）。
 */
function surfaceUrlWithDebugFlag(url: string, probe: boolean): string {
  if (!officeDebugEnabled() && !probe) return url
  try {
    const parsed = new URL(url)
    if (officeDebugEnabled()) parsed.searchParams.set('officeDebug', '1')
    if (probe) parsed.searchParams.set('officeProbe', '1')
    return parsed.toString()
  } catch {
    return url
  }
}

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
      surfaceUrl,
      probe = false
    },
    ref
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null)
    /** JSX 里自建 iframe 的 ref（React 卸载时只会清它，不会误清升格面的 iframeRef） */
    const ownIframeRef = useRef<HTMLIFrameElement | null>(null)
    /** task-101：升格复用的启动预热面（iframe 在 body 里绝对定位覆盖本组件内容区） */
    const containerRef = useRef<HTMLDivElement | null>(null)
    const adoptedHostRef = useRef<HTMLDivElement | null>(null)
    const [adopted, setAdopted] = useState(false)
    const statusRef = useRef<OfficeSurfaceStatus>('loading')
    const [status, setStatus] = useState<OfficeSurfaceStatus>('loading')
    const [fatalMessage, setFatalMessage] = useState('')
    const [url] = useState(() => surfaceUrlWithDebugFlag(surfaceUrl ?? currentSurfaceUrl(), probe))

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
    /** D17：探针开关也要能随 init 下发给复用的预热面（该面 URL 里没有 officeProbe） */
    const probeRef = useRef(probe)
    const onDocLoadedRef = useRef(onDocLoaded)
    const onDocChangedRef = useRef(onDocChanged)
    const onDocSaveRequestRef = useRef(onDocSaveRequest)
    const onDocErrorRef = useRef(onDocError)
    const onStatusChangeRef = useRef(onStatusChange)
    const onShortcutRef = useRef(onShortcut)
    useEffect(() => {
      localeRef.current = locale
      themeRef.current = theme
      probeRef.current = probe
      onDocLoadedRef.current = onDocLoaded
      onDocChangedRef.current = onDocChanged
      onDocSaveRequestRef.current = onDocSaveRequest
      onDocErrorRef.current = onDocError
      onStatusChangeRef.current = onStatusChange
      onShortcutRef.current = onShortcut
    }, [
      locale,
      theme,
      probe,
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
        resolveSaveResult(result): void {
          const message: Omit<DocSaveResultMessage, 'nonce'> = {
            type: 'doc:save-result',
            requestId: result.requestId,
            ok: result.ok,
            ...(result.code === undefined ? {} : { code: result.code }),
            ...(result.message === undefined ? {} : { message: result.message })
          }
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

      // task-101（用户反馈：启动预注册必须真的省掉首开注册）：
      // 若启动预热面已 ready，直接「升格」复用同一文档——iframe 留在原 DOM 位置（reparent 会重载），
      // 由独立 effect 把 host 绝对定位覆盖到本组件内容区；字体已在面内注册好（0 次重复注册）。
      // 预热面已 boot 很久、hello 重试窗口（5s）早结束，这里主动请求它重新 hello 完成握手。
      const prewarmed = takePrewarmedSurface()
      if (prewarmed === null) notePrewarmFallback()
      if (prewarmed !== null) {
        iframeRef.current = prewarmed.frame
        adoptedHostRef.current = prewarmed.host
        prewarmed.frame.dataset.testid = 'office-surface-iframe'
        prewarmed.frame.removeAttribute('aria-hidden')
        prewarmed.frame.removeAttribute('tabindex')
        prewarmed.frame.title = 'Office 隔离面'
        setAdopted(true)
      }

      /**
       * 就绪超时定时器（A5 真机验收 P1 bug）：收到 surface:ready 后必须清掉它，否则
       * 15s 后必然误报「隔离面启动失败」（文档其实早已 ready、可编辑）。
       * 只有 hello/ready 之前超时才是真的 fatal。
       */
      let readyTimer: number | null = null
      const clearReadyTimer = (): void => {
        if (readyTimer === null) return
        window.clearTimeout(readyTimer)
        readyTimer = null
      }

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
          theme: themeRef.current,
          probe: probeRef.current
        }
        frameWindow.postMessage(init, '*')
      }

      // 升格面在隐藏期已由预热模块完成 hello→init（见 office-font-prewarm.ts），这里直接沿用
      // nonce 进入 ready：事件监听仍挂上（doc:loaded/changed/save 等都还走同一套），
      // 并再发一次 init 让 locale/theme 与当前 workspace 对齐（面侧 init 幂等）。
      if (prewarmed !== null) {
        nonceRef.current = prewarmed.nonce
        update('ready')
        postInit(prewarmed.nonce, true)
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
          // A5 P1 bug：ready 后清就绪超时，否则 15s 后误报 fatal（文档正常却弹「启动失败」）
          clearReadyTimer()
          update('ready')
          return
        }
        if (isSurfaceFatal(data)) {
          clearReadyTimer()
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
          onDocSaveRequestRef.current?.({
            requestId: data.requestId,
            documentId: data.documentId
          })
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
      if (prewarmed === null) {
        iframeRef.current = ownIframeRef.current
        if (iframeRef.current !== null) iframeRef.current.src = url
      }
      if (prewarmed === null)
        readyTimer = window.setTimeout(() => {
          readyTimer = null
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
        clearReadyTimer()
        window.removeEventListener('message', onMessage)
        if (prewarmed !== null) {
          // 归还预热面：隐藏保留（下个文档面可继续复用，字体注册仍为 0 次）
          iframeRef.current = null
          adoptedHostRef.current = null
          releasePrewarmedSurface()
        }
      }
    }, [url, readyTimeoutMs])

    // 主题 / locale 运行中变化：ready 后重发一次 init（面每次 init 都重新应用主题，不重载 iframe）
    useEffect(() => {
      if (status !== 'ready') return
      const nonce = nonceRef.current
      const frameWindow = iframeRef.current?.contentWindow
      if (nonce === null || frameWindow === null || frameWindow === undefined) return
      const key = `${nonce}:${locale}:${theme}:${String(probe)}`
      if (sentInitRef.current === key) return
      sentInitRef.current = key
      const init: ShellToSurfaceMessage = {
        type: 'surface:init',
        nonce,
        locale,
        theme,
        probe
      }
      frameWindow.postMessage(init, '*')
    }, [locale, theme, probe, status])

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
        kind: documentInfo.kind,
        name: documentInfo.displayName,
        sha256: documentInfo.sha256,
        readOnly: documentInfo.readOnly,
        bytes: documentBytes
      }
      frameWindow.postMessage(message, '*')
    }, [documentInfo, documentBytes, status])

    // task-101 / P0-2：升格面常驻 body，用绝对定位覆盖本组件内容区。
    // P0-2（shell-auditor 审计）：**不再用永不暂停的 rAF 循环**（隐藏/切走仍 60fps 写 style）；
    // 改为事件驱动：ResizeObserver（尺寸/显隐变化）+ IntersectionObserver（进出视口）+
    // window resize / scroll / document.visibilitychange（页面 hidden 停、visible 时立即同步一次）。
    // 无事件时 0 次 getBoundingClientRect / 0 次 style 写入。
    useEffect(() => {
      if (!adopted) return
      const host = adoptedHostRef.current
      const container = containerRef.current
      if (host === null || container === null) return

      let lastVisible: boolean | null = null
      const sync = (): void => {
        const rect = container.getBoundingClientRect()
        const visible = document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1
        if (!visible) {
          if (lastVisible !== false) {
            host.style.display = 'none'
            lastVisible = false
          }
          return
        }
        host.style.display = 'block'
        host.style.position = 'fixed'
        host.style.left = `${Math.round(rect.left)}px`
        host.style.top = `${Math.round(rect.top)}px`
        host.style.width = `${Math.round(rect.width)}px`
        host.style.height = `${Math.round(rect.height)}px`
        host.style.opacity = '1'
        host.style.pointerEvents = 'auto'
        lastVisible = true
      }

      const resizeObserver = new ResizeObserver(sync)
      resizeObserver.observe(container)
      // 显隐可能不改变 box（visibility/opacity）：IntersectionObserver 负责进出视口唤醒
      const intersectionObserver = new IntersectionObserver(sync, { threshold: 0 })
      intersectionObserver.observe(container)
      const onVisibilityChange = (): void => {
        sync()
      }
      const onWindowChange = (): void => {
        sync()
      }
      window.addEventListener('resize', onWindowChange)
      window.addEventListener('scroll', onWindowChange, true)
      document.addEventListener('visibilitychange', onVisibilityChange)
      // 首次挂载立即同步一次（此后只在事件发生时同步）
      sync()

      return () => {
        resizeObserver.disconnect()
        intersectionObserver.disconnect()
        window.removeEventListener('resize', onWindowChange)
        window.removeEventListener('scroll', onWindowChange, true)
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }, [adopted])

    return (
      <div
        ref={containerRef}
        data-testid="office-surface"
        data-state={status}
        data-theme={theme}
        data-document-id={documentInfo?.documentId ?? ''}
        className="relative flex min-h-0 flex-1 flex-col bg-(--doc-canvas-bg)"
      >
        {/*
          src 不写在 JSX 里：由上面的 effect 在 message 监听挂好之后赋值（避免竞态）。
          React 不会替我们清掉命令式设置的 src —— 后续重渲染时该属性不在 props diff 里。
        */}
        {adopted ? (
          // 升格复用：iframe 在 body 里由定位 effect 覆盖这块占位，这里只保留几何
          <div
            data-testid="office-surface-adopted"
            className="block h-full min-h-0 w-full flex-1"
          />
        ) : (
          <iframe
            ref={ownIframeRef}
            data-testid="office-surface-iframe"
            data-status={status}
            title="Office 隔离面"
            className="block h-full min-h-0 w-full flex-1 border-0"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
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
