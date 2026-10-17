/**
 * Office 隔离面的启动组件（M3-S1 握手 → M3-S2 收文档字节）。
 *
 * 流程：生成 nonce → 向父页 postMessage `surface:hello` → 收 `surface:init`（nonce 匹配）→
 * 应用 locale/theme（写到 <html>/<body> 上）→ 回 `surface:ready` → 等 `doc:open`。
 *
 * S2 的边界：
 *   - 字节由壳 `postMessage` 结构化克隆过来（还不是 MessagePort，S3 再换）；
 *   - **先只展示字节数**（+ 文档名/sha256/只读标记），不 import @betteroffice/**、不解析 OOXML；
 *   - 主题运行中切换：壳会用同一个 nonce **再发一次** `surface:init`，这里每次都要重新应用
 *     theme（不能只认第一次），这样深色主题下隔离面不会还是白底（P2 真机问题）。
 *
 * 为什么有重发 hello：父页（React）的 message 监听是在 effect 里挂的，而 iframe 的文档加载可能先完成；
 * 这里每 250ms 重发一次 hello、最多 5s，直到收到 init —— 一次竞态也不用父页配合重试。
 */
import { useEffect, useState } from 'react'
import {
  createSurfaceNonce,
  isDocOpen,
  isSurfaceInit,
  SURFACE_PROTOCOL_VERSION,
  type SurfaceHelloMessage,
  type SurfaceReadyMessage,
  type SurfaceTheme
} from './bridge-protocol'

/** hello 重发间隔与总窗口：父页监听挂晚了也能对上 */
const HELLO_RETRY_MS = 250
const HELLO_RETRY_WINDOW_MS = 5000

/** 面的底色：与壳的窗口底色同值（main/window.ts 的 WINDOW_BACKGROUND） */
const SURFACE_COLORS = {
  light: { background: '#fbfaf9', text: '#1f1f1f' },
  dark: { background: '#181817', text: '#e8e6e3' }
} as const

/**
 * 把主题落到面的文档根上：`data-surface-theme` 给断言/截图用，`color-scheme` 让原生控件
 * （滚动条/输入框）跟着变，背景/文字色兜住"面本身没有编辑器 UI"时的整块白底。
 */
function applySurfaceTheme(theme: SurfaceTheme): void {
  const colors = SURFACE_COLORS[theme]
  const root = document.documentElement
  root.dataset.surfaceTheme = theme
  root.style.colorScheme = theme
  root.style.background = colors.background
  if (document.body !== null) {
    document.body.style.margin = '0'
    document.body.style.background = colors.background
    document.body.style.color = colors.text
  }
}

/** 面已经收到的文档（S2 只做证据展示，不保存/不解析字节） */
interface SurfaceDocument {
  documentId: string
  name: string
  sha256: string
  readOnly: boolean
  bytes: number
}

export type SurfaceBootState = 'booting' | 'ready'

export function SurfaceBoot(): React.JSX.Element {
  const [state, setState] = useState<SurfaceBootState>('booting')
  const [theme, setTheme] = useState<SurfaceTheme>('light')
  const [doc, setDoc] = useState<SurfaceDocument | null>(null)

  useEffect(() => {
    const nonce = createSurfaceNonce()
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
        // 父页已不存在（面被单独打开等）：握手失败不影响页面继续渲染
      }
    }

    const onMessage = (event: MessageEvent): void => {
      // 面的唯一可信来源是父页（父页 origin 是 opaque，nonce 是第二道）
      if (event.source !== window.parent) return
      const data: unknown = event.data

      if (isSurfaceInit(data) && data.nonce === nonce) {
        // 每次 init 都重新应用（S2：主题运行中切换会再发一次 init）
        applySurfaceTheme(data.theme)
        document.documentElement.lang = data.locale
        setTheme(data.theme)
        if (!initialized) {
          initialized = true
          window.clearInterval(retryTimer)
          window.clearTimeout(stopTimer)
          setState('ready')
        }
        // 父页可能因重发 hello / 主题切换而重复回 init：每次都给 ready（幂等）
        const ready: SurfaceReadyMessage = { type: 'surface:ready', nonce }
        try {
          window.parent.postMessage(ready, '*')
        } catch {
          // 同上：父页没了就没人收，忽略
        }
        return
      }

      // 文档消息只在握手完成后接受；nonce 不匹配的伪造消息直接丢
      if (initialized && isDocOpen(data) && data.nonce === nonce) {
        setDoc({
          documentId: data.documentId,
          name: data.name,
          sha256: data.sha256,
          readOnly: data.readOnly,
          bytes: data.bytes.byteLength
        })
      }
    }

    const retryTimer = window.setInterval(() => {
      if (!initialized) announce()
    }, HELLO_RETRY_MS)
    const stopTimer = window.setTimeout(
      () => window.clearInterval(retryTimer),
      HELLO_RETRY_WINDOW_MS
    )
    window.addEventListener('message', onMessage)
    announce()

    return () => {
      window.clearInterval(retryTimer)
      window.clearTimeout(stopTimer)
      window.removeEventListener('message', onMessage)
    }
  }, [])

  const ready = state === 'ready'
  const colors = SURFACE_COLORS[theme]

  return (
    <main
      data-testid="office-surface"
      data-state={state}
      data-theme={theme}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: '100vh',
        padding: 24,
        boxSizing: 'border-box',
        background: colors.background,
        color: colors.text,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>kyclaw office</h1>
      <p
        data-testid="surface-boot-state"
        data-state={state}
        style={{
          fontSize: 13,
          margin: 0,
          color: ready ? (theme === 'dark' ? '#7ee2a8' : '#137333') : 'inherit',
          opacity: ready ? 1 : 0.6
        }}
      >
        {ready ? 'surface ready' : '等待壳握手…'}
      </p>
      <p
        data-testid="surface-theme"
        data-theme={theme}
        style={{ fontSize: 12, margin: 0, opacity: 0.6 }}
      >
        M3-S2 隔离面（未接编辑器）· theme: {theme}
      </p>
      <p
        data-testid="surface-doc-open"
        data-state={doc === null ? 'empty' : 'loaded'}
        data-document-id={doc?.documentId ?? ''}
        data-bytes={doc?.bytes ?? 0}
        data-sha256={doc?.sha256 ?? ''}
        data-read-only={doc?.readOnly === true ? 'true' : 'false'}
        style={{ fontSize: 13, margin: 0, opacity: doc === null ? 0.6 : 1 }}
      >
        {doc === null
          ? '还没有收到文档'
          : `已收到「${doc.name}」：${doc.bytes} 字节${doc.readOnly ? '（只读）' : ''}`}
      </p>
    </main>
  )
}
