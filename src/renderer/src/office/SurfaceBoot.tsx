/**
 * Office 隔离面的启动组件（M3-S1 握手 → S2 收字节 → S3 挂 DocxEditor）。
 *
 * 流程：生成 nonce → 向父页 `surface:hello` → 收 `surface:init`（nonce 匹配）→ 应用主题 →
 * 回 `surface:ready` → 等 `doc:open`。收到文档后：
 *   1. 首次先注册本地字体（`ensureSurfaceFonts()`，两条链见 ./fonts.ts）；
 *   2. 字体就绪后挂 `DocxEditorPane`（`key=documentId`，换文档=卸载重建）；
 *   3. 编辑 → `doc:changed`（revision 单调）；编辑器内部保存 → `doc:save-request`；
 *      壳要字节 → `doc:save` → flush+save → `doc:save-bytes`；
 *      冲突重载 → `doc:reload` → `loadDocumentBuffer`；关标签 → `doc:close` → 卸载。
 *
 * 主题：壳在运行中切换时**用同一个 nonce 再发一次 `surface:init`**（不重载 iframe）；这里每次
 * 都重新应用（P2 修复的延续），编辑器自身主题走 `colorMode`。
 *
 * M3-S4：焦点在面内编辑器时按 Ctrl+S / Ctrl+W / Ctrl+Tab —— 浏览器事件不跨文档，壳的
 * window 监听收不到；这里在 capture 阶段拦下并只把**动作名**（`surface:shortcut`）转给壳。
 *
 * 为什么有重发 hello：父页（React）的 message 监听是在 effect 里挂的，而 iframe 的文档加载可能
 * 先完成；这里每 250ms 重发一次 hello、最多 5s，直到收到 init —— 一次竞态也不用父页配合重试。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createSurfaceNonce,
  isSurfaceHelloRequest,
  isDocClose,
  isDocOpen,
  isDocReload,
  isDocSave,
  isDocSaveResult,
  isSurfaceInit,
  SURFACE_PROTOCOL_VERSION,
  type DocChangedMessage,
  type DocErrorMessage,
  type DocLoadedMessage,
  type DocSaveBytesMessage,
  type DocSaveRequestMessage,
  type SurfaceHelloMessage,
  type SurfaceReadyMessage,
  type SurfaceShortcutMessage,
  type SurfaceTheme
} from './bridge-protocol'
import { DocxEditorPane, type DocxEditorPaneHandle, type DocxErrorPhase } from './DocxEditorPane'
import { PptxEditorPane, type PptxEditorPaneHandle } from './PptxEditorPane'
import { XlsxEditorPane, type XlsxEditorPaneHandle } from './XlsxEditorPane'
import { SurfaceLoading, loadingStageOf } from './SurfaceLoading'
import type { OfficeSaveState } from './components/OfficeRibbonView'
import {
  ensureSurfaceFonts,
  loadPptxFonts,
  type PptxFontsStats,
  type SurfaceFontStats
} from './fonts'
import type { SurfaceFontsReadyMessage } from './font-prewarm-protocol'

/** hello 重发间隔与总窗口：父页监听挂晚了也能对上 */
const HELLO_RETRY_MS = 250
const HELLO_RETRY_WINDOW_MS = 5000

/**
 * A4.5：面发保存请求后等壳 `doc:save-result` 的上限。超时**不假装已保存**：回「未保存修改」+
 * 「保存未确认」提示（壳的写盘可能仍在进行，用户可重试；壳侧的真实结果会在之后到达并被采信）。
 */
const SAVE_RESULT_TIMEOUT_MS = 15_000

/**
 * 把主题落到面的文档根上（A1：颜色不再写字面值，全部走 token）。
 *
 * - `data-surface-theme`：S2/S3 探针与截图断言的稳定标记（保留）；
 * - `data-theme`：主界面同款主题档，token（kimi-tokens.css / semantic.css）靠它翻深色；
 * - `color-scheme`：让原生控件（滚动条/输入框）跟着变；
 * - 背景/文字由 surface.css 的 `--doc-canvas-bg` / `--text-primary` 给（画布=灰、纸=白由内核负责）。
 */
function applySurfaceTheme(theme: SurfaceTheme, motion: 'full' | 'reduced' = 'full'): void {
  const root = document.documentElement
  root.dataset.surfaceTheme = theme
  root.dataset.theme = theme
  // PB-019：应用内「减弱动效」经 surface:init 传进面；面内样式按 [data-motion='reduced'] 静态兜底
  root.dataset.motion = motion
  root.style.colorScheme = theme
}

/** 面当前打开的文档（S3：字节留在内存里给编辑器；壳不持久化内容） */
interface SurfaceDocument {
  documentId: string
  /** M4-X/P：docx / xlsx / pptx（面据此挂对应编辑器；xlsx 不需要字体，pptx 等 6 面加载） */
  kind: 'docx' | 'xlsx' | 'pptx'
  name: string
  sha256: string
  readOnly: boolean
  bytes: Uint8Array
}

/** 两种编辑器 pane 的命令式句柄形状一致（save/reload）；SurfaceBoot 只按这个用 */
type SurfaceEditorPaneHandle = DocxEditorPaneHandle | XlsxEditorPaneHandle | PptxEditorPaneHandle

export type SurfaceBootState = 'booting' | 'ready'
type FontsState = 'idle' | 'loading' | 'ready' | 'error'
/** M4-P：pptx 6 面字体加载（与 docx 的 document.fonts 注册是两条独立链） */
type PptxFontsState = 'idle' | 'loading' | 'ready' | 'error'
type EditorState = 'idle' | 'loading' | 'ready' | 'error'

export function SurfaceBoot(): React.JSX.Element {
  const [bootState, setBootState] = useState<SurfaceBootState>('booting')
  const [theme, setTheme] = useState<SurfaceTheme>('light')
  const [doc, setDoc] = useState<SurfaceDocument | null>(null)
  const [fontsState, setFontsState] = useState<FontsState>('idle')
  const [fontStats, setFontStats] = useState<SurfaceFontStats | null>(null)
  const [fontsError, setFontsError] = useState('')
  /** M4-P：pptx 字体（6 条/5 唯一/10,467,004B）加载状态与统计 */
  const [pptxFonts, setPptxFonts] = useState<PptxFontsStats | null>(null)
  const [pptxFontsState, setPptxFontsState] = useState<PptxFontsState>('idle')
  const [pptxFontsError, setPptxFontsError] = useState('')
  const [pptxFontsRetry, setPptxFontsRetry] = useState(0)
  const [editorState, setEditorState] = useState<EditorState>('idle')
  const [editorReadyMs, setEditorReadyMs] = useState<number | null>(null)
  /** E8：解析失败后「重试」用——换 key 重新挂编辑器（同一份字节重新尝试） */
  const [editorRetry, setEditorRetry] = useState(0)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [saveStats, setSaveStats] = useState<{ count: number; bytes: number }>({
    count: 0,
    bytes: 0
  })
  /**
   * A1：调试条默认不露出；只有 `?officeDebug=1`（shell 在 DEV+localStorage flag 时拼进 iframe URL）
   * 才显示。DOM 始终在（testid/data-* 供探针查）。
   */
  const [debug] = useState(() => new URLSearchParams(window.location.search).has('officeDebug'))
  /**
   * task-76：启动期 hidden 预热面（`?officePrewarm=1`）。它不等文档、挂载即注册字体，
   * 把 22 面/46 注册/27MB 的首次成本挪到产品启动后的 idle 时段；注册完向父页发
   * `surface:fonts-ready { prewarm:true }`（壳据此释放 iframe，HTTP cache 留给首个真实文档面）。
   */
  const [prewarm] = useState(() => new URLSearchParams(window.location.search).has('officePrewarm'))
  /** D17：测试探针缝（只有未打包 dev 的 shell 会拼 ?officeProbe=1） */
  const [probe, setProbe] = useState(() =>
    new URLSearchParams(window.location.search).has('officeProbe')
  )

  const nonceRef = useRef<string | null>(null)
  const docRef = useRef<SurfaceDocument | null>(null)
  const revisionRef = useRef(0)
  const editorPaneRef = useRef<SurfaceEditorPaneHandle | null>(null)
  /** 字体注册只启动一次（面内单实例；注册本身在 fonts.ts 里还做了一层幂等） */
  const fontsStartedRef = useRef(false)
  /**
   * A4.5：面发起的保存请求（QAT / 面内 Ctrl+S）。QAT 保存态不再靠计时器猜：
   *   - 请求发出 = `saving`；收到壳 `doc:save-result` 才落定（ok → saved / 失败 → dirty + 错误）；
   *   - `requestId` 只认最新一个（连点保存/多次请求时旧回执忽略）；
   *   - 15s 没回执 = 「保存未确认」回 dirty（不假装已保存）。
   */
  const pendingSaveRef = useRef<{
    requestId: string
    revisionAtRequest: number
    timer: number
  } | null>(null)
  const [saveState, setSaveState] = useState<OfficeSaveState>('saved')
  const [saveError, setSaveError] = useState('')

  /** 安全地把消息发给父页（父页没了就忽略） */
  const post = useCallback((message: Omit<DocErrorMessage, 'nonce'> | object): void => {
    const nonce = nonceRef.current
    if (nonce === null) return
    try {
      window.parent.postMessage({ ...message, nonce }, '*')
    } catch {
      // 父页已不存在（面被单独打开等）：消息丢弃，页面继续渲染
    }
  }, [])

  const postError = useCallback(
    (phase: DocxErrorPhase, message: string): void => {
      setError(message)
      const documentId = docRef.current?.documentId
      const payload: Omit<DocErrorMessage, 'nonce'> = {
        type: 'doc:error',
        phase,
        message,
        ...(documentId === undefined ? {} : { documentId })
      }
      post(payload)
    },
    [post]
  )

  /** 首次布局完成：编辑器可交互 */
  const handleLoaded = useCallback(
    (pages: number): void => {
      setEditorState('ready')
      setEditorReadyMs(Math.round(performance.now()))
      setError('')
      const current = docRef.current
      if (current === null) return
      const message: Omit<DocLoadedMessage, 'nonce'> = {
        type: 'doc:loaded',
        documentId: current.documentId,
        pages
      }
      post(message)
    },
    [post]
  )

  const handleChanged = useCallback((): void => {
    const current = docRef.current
    if (current === null) return
    revisionRef.current += 1
    setRevision(revisionRef.current)
    // A4.5：只要有编辑就绝不再显示「已保存」（在飞的保存等壳回执时按 revision 再判一次）
    setSaveState('dirty')
    const message: Omit<DocChangedMessage, 'nonce'> = {
      type: 'doc:changed',
      documentId: current.documentId,
      revision: revisionRef.current
    }
    post(message)
  }, [post])

  /** 清掉在飞的保存请求（换文档/关标签/卸载时用；不伪造结果） */
  const clearPendingSave = useCallback((): void => {
    const pending = pendingSaveRef.current
    if (pending === null) return
    window.clearTimeout(pending.timer)
    pendingSaveRef.current = null
  }, [])

  /**
   * A4.5：面内唯一的保存入口（QAT 按钮 / QAT Ctrl+S / 面内 Ctrl+S 都到这里）。
   * 发带 requestId 的 `doc:save-request`，等壳写盘结果回执；**不在这里假装已保存**。
   */
  const requestSave = useCallback((): void => {
    const current = docRef.current
    if (current === null || current.readOnly || nonceRef.current === null) return
    clearPendingSave()
    const requestId = createSurfaceNonce()
    const revisionAtRequest = revisionRef.current
    setSaveState('saving')
    setSaveError('')
    const timer = window.setTimeout(() => {
      const pending = pendingSaveRef.current
      if (pending === null || pending.requestId !== requestId) return
      pendingSaveRef.current = null
      // 超时兜底：不假装已保存（壳的写盘可能仍在进行，真实结果到达后仍会被采信）
      setSaveState('dirty')
      setSaveError('保存未确认：等待壳的写盘回执超时（修改仍在编辑器里，可重试保存）')
    }, SAVE_RESULT_TIMEOUT_MS)
    pendingSaveRef.current = { requestId, revisionAtRequest, timer }
    const message: Omit<DocSaveRequestMessage, 'nonce'> = {
      type: 'doc:save-request',
      requestId,
      documentId: current.documentId
    }
    post(message)
  }, [clearPendingSave, post])

  /** 壳的保存结果回执（A4.5）：ok → saved（期间又编辑过则仍 dirty）；失败 → dirty + 壳给的人话 */
  const handleSaveResult = useCallback(
    (result: { requestId: string; ok: boolean; code?: string; message?: string }): void => {
      const pending = pendingSaveRef.current
      // 只认最新一个：有在途请求时，旧 requestId 的回执一律忽略（连点保存/多次请求）
      if (pending !== null && pending.requestId !== result.requestId) return
      if (pending !== null) {
        window.clearTimeout(pending.timer)
        pendingSaveRef.current = null
      }
      const revisionUnchanged =
        pending !== null && revisionRef.current === pending.revisionAtRequest
      if (result.ok) {
        // 保存期间又改过 → 壳的 save-machine 也仍算脏，面这边同样显示未保存
        setSaveState(revisionUnchanged || pending === null ? 'saved' : 'dirty')
        setSaveError('')
        return
      }
      setSaveState('dirty')
      setSaveError(
        result.message ??
          (result.code === undefined ? '保存失败（壳未给原因）' : `保存失败：${result.code}`)
      )
    },
    []
  )

  /** 卸载 / 换面时清计时器（不伪造任何结果） */
  useEffect(
    () => () => {
      clearPendingSave()
    },
    [clearPendingSave]
  )

  const handleEditorError = useCallback(
    (phase: DocxErrorPhase, message: string): void => {
      setEditorState('error')
      postError(phase, message)
    },
    [postError]
  )

  // 握手 + 数据面消息
  useEffect(() => {
    const nonce = createSurfaceNonce()
    nonceRef.current = nonce
    let initialized = false

    const announce = (): void => {
      const hello: SurfaceHelloMessage = {
        type: 'surface:hello',
        nonce,
        version: SURFACE_PROTOCOL_VERSION
      }
      try {
        window.parent.postMessage(hello, '*')
      } catch {
        // 父页已不存在：握手失败不影响页面继续渲染
      }
    }

    const postReady = (): void => {
      const ready: SurfaceReadyMessage = { type: 'surface:ready', nonce }
      try {
        window.parent.postMessage(ready, '*')
      } catch {
        // 同上
      }
    }

    /** 保存三阶段的 generate：壳要字节 → flush + save() → 回 doc:save-bytes */
    const generateSaveBytes = async (requestId: string): Promise<void> => {
      const current = docRef.current
      const pane = editorPaneRef.current
      if (current === null || pane === null) {
        postError('save', '编辑器还没准备好，无法生成保存内容')
        return
      }
      const bytes = await pane.save()
      if (bytes === null) {
        // save() 内部已经把具体错误经 onError 回过一次；这里只补一条"没生成出来"
        postError('save', '没能生成保存内容')
        return
      }
      setSaveStats((previous) => ({
        count: previous.count + 1,
        bytes: bytes.byteLength
      }))
      const message: Omit<DocSaveBytesMessage, 'nonce'> = {
        type: 'doc:save-bytes',
        requestId,
        documentId: current.documentId,
        bytes
      }
      post(message)
    }

    const onMessage = (event: MessageEvent): void => {
      // 面的唯一可信来源是父页（父页 origin 是 opaque，nonce 是第二道）
      if (event.source !== window.parent) return
      const data: unknown = event.data

      // task-100：复用启动预热面时，壳在监听挂好后请求面重新 hello（重开 5s 重试窗口）
      if (isSurfaceHelloRequest(data)) {
        if (!initialized) startHelloRetry()
        announce()
        return
      }

      if (isSurfaceInit(data) && data.nonce === nonce) {
        applySurfaceTheme(data.theme, data.motion ?? 'full')
        document.documentElement.lang = data.locale
        setTheme(data.theme)
        // D17：复用的预热面 URL 不带 officeProbe，开关从 init 下发（每次 init 覆盖）
        setProbe(data.probe === true)
        if (!initialized) {
          initialized = true
          if (retryTimer !== null) window.clearInterval(retryTimer)
          if (stopTimer !== null) window.clearTimeout(stopTimer)
          retryTimer = null
          stopTimer = null
          setBootState('ready')
        }
        // 父页可能因重发 hello / 主题切换而重复回 init：每次都给 ready（幂等）
        postReady()
        return
      }

      // 数据面消息只在握手完成后接受；nonce 不匹配的伪造消息直接丢
      if (!initialized) return

      if (isDocOpen(data) && data.nonce === nonce) {
        const next: SurfaceDocument = {
          documentId: data.documentId,
          kind: data.kind,
          name: data.name,
          sha256: data.sha256,
          readOnly: data.readOnly,
          bytes: data.bytes
        }
        docRef.current = next
        setDoc(next)
        setEditorState('loading')
        setEditorReadyMs(null)
        setError('')
        // E8：换文档时重置编辑器重试计数（错误条上的「重试」用）
        setEditorRetry(0)
        revisionRef.current = 0
        setRevision(0)
        // A4.5：换文档 = 保存态归零（不继承上一篇的 saving/dirty/错误）
        clearPendingSave()
        setSaveState('saved')
        setSaveError('')
        return
      }

      if (isDocSave(data) && data.nonce === nonce) {
        void generateSaveBytes(data.requestId)
        return
      }

      // A4.5：壳的写盘回执 → QAT 保存态（事件驱动，不猜）
      if (isDocSaveResult(data) && data.nonce === nonce) {
        const current = docRef.current
        if (current === null) return
        handleSaveResult({
          requestId: data.requestId,
          ok: data.ok,
          ...(data.code === undefined ? {} : { code: data.code }),
          ...(data.message === undefined ? {} : { message: data.message })
        })
        return
      }

      if (isDocReload(data) && data.nonce === nonce) {
        const pane = editorPaneRef.current
        const current = docRef.current
        if (pane === null || current === null) return
        void pane.reload(data.bytes).then(() => {
          const next: SurfaceDocument = { ...current, bytes: data.bytes }
          docRef.current = next
          setDoc(next)
        })
        return
      }

      if (isDocClose(data) && data.nonce === nonce) {
        docRef.current = null
        setDoc(null)
        setEditorState('idle')
        setEditorReadyMs(null)
        setError('')
        revisionRef.current = 0
        setRevision(0)
        clearPendingSave()
        setSaveState('saved')
        setSaveError('')
      }
    }

    let retryTimer: number | null = null
    let stopTimer: number | null = null
    /** 开/重开 hello 重试窗口（复用预热面时壳会发 surface:hello-request 触发） */
    const startHelloRetry = (): void => {
      if (initialized) return
      if (retryTimer === null) {
        retryTimer = window.setInterval(() => {
          if (!initialized) announce()
        }, HELLO_RETRY_MS)
      }
      if (stopTimer !== null) window.clearTimeout(stopTimer)
      stopTimer = window.setTimeout(() => {
        if (retryTimer !== null) window.clearInterval(retryTimer)
        retryTimer = null
      }, HELLO_RETRY_WINDOW_MS)
    }
    startHelloRetry()
    window.addEventListener('message', onMessage)
    announce()

    return () => {
      if (retryTimer !== null) window.clearInterval(retryTimer)
      if (stopTimer !== null) window.clearTimeout(stopTimer)
      window.removeEventListener('message', onMessage)
    }
  }, [post, postError, handleSaveResult, clearPendingSave])

  // M3-S4/A4.5：面内快捷键转发（capture 阶段拦下并吞掉）。
  // Ctrl+S 不再转 `surface:shortcut`：走**面自己的保存入口**（带 requestId 的 doc:save-request），
  // 这样壳的写盘结果能回执给面内 QAT —— 与 QAT 保存按钮同一条路（A4.5 去掉了乐观窗口）。
  useEffect(() => {
    if (bootState !== 'ready' || doc === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        event.stopPropagation()
        requestSave()
        return
      }
      let action: SurfaceShortcutMessage['action'] | null = null
      if ((event.key === 'w' || event.key === 'W') && !event.shiftKey) action = 'close'
      else if (event.key === 'Tab') action = event.shiftKey ? 'prev-tab' : 'next-tab'
      if (action === null) return
      event.preventDefault()
      event.stopPropagation()
      const message: Omit<SurfaceShortcutMessage, 'nonce'> = { type: 'surface:shortcut', action }
      post(message)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [bootState, doc, post, requestSave])

  /**
   * task-76：字体注册在**面挂载时立刻开始**（不再等 `doc:open`）：
   *   - 启动期 hidden 预热面：挂载即注册，把首次成本挪到产品启动 idle 时段；
   *   - 真实文档面：shell 建面/开标签时就开始注册，与壳读字节/建 iframe 并行；
   *     首个文档到达时通常已 ready（或只差最后一点），编辑器不再串行等字体。
   * 注册完成向父页发 `surface:fonts-ready`（含 prewarm 标记与耗时），壳用于释放预热面 + 打点。
   * 失败不阻塞页面（错误照旧经 postError 回壳），不缓存失败（ensureSurfaceFonts 自己会清 pending）。
   */
  useEffect(() => {
    if (fontsStartedRef.current) return
    fontsStartedRef.current = true
    // 计时从 effect 开始（不在 render 期调用 performance.now，满足 react-hooks/purity）
    const fontsStartedAt = performance.now()
    ensureSurfaceFonts()
      .then((stats) => {
        setFontStats(stats)
        setFontsState('ready')
        setError('')
        const message: SurfaceFontsReadyMessage = {
          type: 'surface:fonts-ready',
          prewarm,
          elapsedMs: Math.round(performance.now() - fontsStartedAt),
          stats: {
            faces: stats.faces,
            registrations: stats.registrations,
            fetchedBytes: stats.fetchedBytes,
            fontSetSize: stats.fontSetSize,
            ms: stats.ms,
            cjk: stats.cjk
          }
        }
        const nonce = nonceRef.current
        try {
          // 预热面还没握手（没有 nonce）；真实面带上 nonce，壳侧按既有来源校验
          window.parent.postMessage(nonce === null ? message : { ...message, nonce }, '*')
        } catch {
          // 父页已不存在：消息丢弃，不影响面内渲染
        }
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        setFontsState('error')
        setFontsError(message)
        postError('open', `本地字体注册失败：${message}`)
      })
  }, [postError, prewarm])

  /**
   * M4-P：pptx 6 面字体只在 `doc.kind==='pptx'` 时加载；成功才挂 `PptxEditorPane`。
   * 失败/20s 超时**不空数组挂编辑器**：进错误态 + 重试按钮（重试清掉失败缓存，见 fonts.ts）。
   */
  useEffect(() => {
    if (doc?.kind !== 'pptx') {
      setPptxFonts(null)
      setPptxFontsState('idle')
      setPptxFontsError('')
      return
    }
    let alive = true
    setPptxFonts(null)
    setPptxFontsState('loading')
    setPptxFontsError('')
    loadPptxFonts()
      .then((stats) => {
        if (!alive) return
        setPptxFonts(stats)
        setPptxFontsState('ready')
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setPptxFontsState('error')
        setPptxFontsError(message)
        postError('open', `PPTX 字体加载失败：${message}`)
      })
    return () => {
      alive = false
    }
  }, [doc?.documentId, doc?.kind, pptxFontsRetry, postError])

  const ready = bootState === 'ready'
  /** M4-X/P：xlsx 不需要字体；pptx 等 6 面加载；docx 等 document.fonts 注册 */
  const needsDocxFonts = doc?.kind === 'docx'
  const needsPptxFonts = doc?.kind === 'pptx'
  const fontsReady = needsPptxFonts
    ? pptxFontsState === 'ready'
    : needsDocxFonts
      ? fontsState === 'ready'
      : true
  const showEditor = doc !== null && fontsReady

  // PB-019：加载态骨架（方案 A）。规则（Lead/Finn 复审版）：
  //  - 未就绪 **≥150ms** 才显示骨架（真正的瞬时路径 <150ms 不闪）；
  //  - 升格/预热面同样遵守（pptx 在预热面里等 6 面字体时也必须看到加载态）；
  //  - 已显示则**最短展示 150ms**（再走 150ms 淡出），阶段 4「即将显示」；
  //  - 错误态立刻撤骨架，走原错误条/重试。
  const loadingError =
    (doc?.kind === 'docx' && fontsState === 'error') ||
    (doc?.kind === 'pptx' && pptxFontsState === 'error') ||
    // E8：编辑器/解析失败（如损坏 pptx）也必须立刻撤骨架，否则骨架盖住错误条与重试
    editorState === 'error'
  const loadingStage = loadingStageOf({
    kind: doc?.kind ?? null,
    doc: doc !== null,
    fontsState,
    pptxFontsState,
    editorState
  })
  const mountedAtRef = useRef(performance.now())
  const shownAtRef = useRef<number | null>(null)
  const [skeletonShown, setSkeletonShown] = useState(false)
  const [skeletonDone, setSkeletonDone] = useState(false)
  useEffect(() => {
    if (loadingError) {
      // 错误态：立即撤（不等最短展示），错误条/重试优先可见
      setSkeletonDone(true)
      return
    }
    if (skeletonShown || skeletonDone || editorState === 'ready') return
    const remaining = Math.max(0, 150 - (performance.now() - mountedAtRef.current))
    const timer = window.setTimeout(() => {
      shownAtRef.current = performance.now()
      setSkeletonShown(true)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [editorState, loadingError, skeletonShown, skeletonDone])
  useEffect(() => {
    if (loadingError) {
      setSkeletonDone(true)
      return
    }
    if (editorState !== 'ready') return
    if (!skeletonShown) {
      // 瞬时路径：骨架从未出现，直接结束（不渲染）
      setSkeletonDone(true)
      return
    }
    const shownFor = performance.now() - (shownAtRef.current ?? performance.now())
    const wait = Math.max(0, 150 - shownFor)
    const timer = window.setTimeout(() => setSkeletonDone(true), wait + 150)
    return () => window.clearTimeout(timer)
  }, [editorState, loadingError, skeletonShown])
  const loadingVisible = skeletonShown && !skeletonDone && !loadingError



  return (
    <main
      className="office-surface-root"
      data-testid="office-surface"
      data-state={bootState}
      data-theme={theme}
    >
      <div
        className="office-surface-status"
        data-debug={debug ? 'true' : 'false'}
        data-testid="surface-status-bar"
      >
        <span
          data-testid="surface-boot-state"
          data-state={bootState}
          style={{ color: ready ? 'var(--positive)' : 'inherit' }}
        >
          {ready ? 'surface ready' : '等待壳握手…'}
        </span>
        <span data-testid="surface-theme" data-theme={theme}>
          theme: {theme}
        </span>
        <span
          data-testid="surface-doc-open"
          data-state={doc === null ? 'empty' : 'loaded'}
          data-document-id={doc?.documentId ?? ''}
          data-bytes={doc?.bytes.byteLength ?? 0}
          data-sha256={doc?.sha256 ?? ''}
          data-read-only={doc?.readOnly === true ? 'true' : 'false'}
        >
          {doc === null
            ? '还没有收到文档'
            : `已收到「${doc.name}」：${doc.bytes.byteLength} 字节${doc.readOnly ? '（只读）' : ''}`}
        </span>
        <span
          data-testid="surface-editor-state"
          data-state={editorState}
          data-ready-ms={editorReadyMs ?? ''}
          data-revision={revision}
        >
          编辑器 {editorState}
        </span>
        <span
          data-testid="surface-save-stats"
          data-save-count={saveStats.count}
          data-last-bytes={saveStats.bytes}
          data-save-state={saveState}
          data-save-error={saveError}
          data-fonts-ms={fontStats?.ms ?? ''}
          data-fonts-bytes={fontStats?.fetchedBytes ?? 0}
        >
          保存 {saveStats.count} 次
        </span>
        <span
          data-testid="surface-pptx-fonts"
          data-pptx-fonts-state={pptxFontsState}
          data-pptx-fonts-faces={pptxFonts?.faces ?? 0}
          data-pptx-fonts-unique={pptxFonts?.uniqueFaces ?? 0}
          data-pptx-fonts-bytes={pptxFonts?.bytes ?? 0}
          data-pptx-fonts-ms={pptxFonts?.ms ?? ''}
        >
          {pptxFontsState === 'ready'
            ? `pptx 字体 ${String(pptxFonts?.faces ?? 0)} 面`
            : `pptx 字体 ${pptxFontsState}`}
        </span>
        {saveError === '' ? null : (
          <span
            data-testid="surface-save-error"
            role="alert"
            style={{ color: 'var(--danger)' }}
            title={saveError}
          >
            {saveError}
          </span>
        )}
        {error === '' ? null : (
          <span data-testid="surface-error" style={{ color: 'var(--danger)' }}>
            {error}
          </span>
        )}
      </div>
      <div className="office-surface-body">
        {doc !== null && doc.kind === 'docx' && fontsState === 'error' ? (
          <div className="office-surface-loading" data-testid="surface-fonts-error">
            本地字体注册失败：{fontsError}
          </div>
        ) : doc !== null && doc.kind === 'pptx' && pptxFontsState === 'error' ? (
          <div
            className="office-surface-loading"
            data-testid="surface-pptx-fonts-error"
            role="alert"
          >
            <span>PPTX 字体加载失败：{pptxFontsError}</span>
            <button
              type="button"
              data-testid="surface-pptx-fonts-retry"
              onClick={() => setPptxFontsRetry((current) => current + 1)}
            >
              重试
            </button>
          </div>
        ) : null}
        {showEditor ? (
          // PB-019：编辑器先挂载预热，但在 doc:loaded 前保持不可见（避免真实 ribbon 从骨架里透出）；
          // 就绪后 250ms settle 淡入（--motion-open），与骨架 150ms 淡出并行。
          <div
            className="office-editor-settle"
            data-ready={editorState === 'ready' ? 'true' : 'false'}
          >
            {doc.kind === 'xlsx' ? (
            <XlsxEditorPane
              key={`${doc.documentId}:${editorRetry}`}
              ref={editorPaneRef}
              documentId={doc.documentId}
              name={doc.name}
              bytes={doc.bytes}
              readOnly={doc.readOnly}
              theme={theme}
              probe={probe}
              onChanged={handleChanged}
              onSaveRequest={requestSave}
              onLoaded={() => handleLoaded(0)}
              onError={handleEditorError}
            />
          ) : doc.kind === 'pptx' ? (
            // M4-P：PptxEditorPane 由 office-engineer 提供；字体 ready 后才走到这里
            <PptxEditorPane
              key={`${doc.documentId}:${editorRetry}`}
              ref={editorPaneRef}
              documentId={doc.documentId}
              name={doc.name}
              bytes={doc.bytes}
              readOnly={doc.readOnly}
              theme={theme}
              fonts={pptxFonts?.fonts ?? []}
              probe={probe}
              onChanged={handleChanged}
              onSaveRequest={requestSave}
              onLoaded={() => handleLoaded(0)}
              onError={handleEditorError}
            />
          ) : (
            <DocxEditorPane
              key={`${doc.documentId}:${editorRetry}`}
              ref={editorPaneRef}
              documentId={doc.documentId}
              name={doc.name}
              bytes={doc.bytes}
              readOnly={doc.readOnly}
              theme={theme}
              onChanged={handleChanged}
              onSaveRequest={requestSave}
              onLoaded={handleLoaded}
              onError={handleEditorError}
              saveState={saveState}
            />
            )}
          </div>
        ) : null}
        {/* PB-019：骨架/阶段读数（覆盖在编辑器首帧之上，就绪后 150ms 淡出）；<150ms 的瞬时路径不显示 */}
        {loadingVisible ? (
          <SurfaceLoading
            kind={doc?.kind ?? 'docx'}
            stage={loadingStage}
            docBytes={doc?.bytes.byteLength ?? 0}
            testId={doc === null ? 'surface-editor-empty' : 'surface-fonts-loading'}
            leaving={loadingStage === 4}
          />
        ) : null}
        {/* E8：解析/编辑器失败的可视错误条（调试条里的 surface-error 在非 debug 下不可见）——
            骨架已撤，错误条 + 重试必须在画布上可见 */}
        {doc !== null && editorState === 'error' && error !== '' ? (
          <div
            className="office-surface-loading office-surface-error"
            data-testid="surface-editor-error"
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              data-testid="surface-editor-error-retry"
              onClick={() => {
                setError('')
                setEditorState('loading')
                setEditorRetry((current) => current + 1)
              }}
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    </main>
  )
}
