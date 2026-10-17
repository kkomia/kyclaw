/**
 * Office 隔离面的启动组件（M3-S1）：握手 + 最小调试展示。
 *
 * 流程：生成 nonce → 向父页 postMessage `surface:hello` → 收 `surface:init`（nonce 匹配）→
 * 应用 locale/theme（写到 <html> 上）→ 回 `surface:ready` → 显示 "surface ready"。
 *
 * 为什么有重发：父页（React）的 message 监听是在 effect 里挂的，而 iframe 的文档加载可能先完成；
 * 这里每 250ms 重发一次 hello、最多 5s，直到收到 init —— 一次竞态也不用父页配合重试。
 * 独立打开本页（window.parent === window）时永远收不到 init，最多多打十几次 hello，无副作用。
 *
 * S1 不接编辑器内核：这里只证明"面能起、能握手、CSP/wasm 生效"，S2 起在 ready 后挂编辑器。
 */
import { useEffect, useState } from 'react'
import {
  createSurfaceNonce,
  isSurfaceInit,
  SURFACE_PROTOCOL_VERSION,
  type SurfaceHelloMessage,
  type SurfaceReadyMessage,
  type SurfaceTheme
} from './bridge-protocol'

/** hello 重发间隔与总窗口：父页监听挂晚了也能对上 */
const HELLO_RETRY_MS = 250
const HELLO_RETRY_WINDOW_MS = 5000

export type SurfaceBootState = 'booting' | 'ready'

export function SurfaceBoot(): React.JSX.Element {
  const [state, setState] = useState<SurfaceBootState>('booting')
  const [theme, setTheme] = useState<SurfaceTheme>('light')

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
      const data: unknown = event.data
      if (!isSurfaceInit(data) || data.nonce !== nonce) return
      if (!initialized) {
        initialized = true
        window.clearInterval(retryTimer)
        window.clearTimeout(stopTimer)
        document.documentElement.lang = data.locale
        document.documentElement.dataset.surfaceTheme = data.theme
        setTheme(data.theme)
        setState('ready')
      }
      // 父页可能因重发 hello 而重复回 init：每次都给 ready（幂等）
      const ready: SurfaceReadyMessage = { type: 'surface:ready', nonce }
      try {
        window.parent.postMessage(ready, '*')
      } catch {
        // 同上：父页没了就没人收，忽略
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

  return (
    <main
      data-testid="office-surface"
      data-state={state}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 24,
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
          color: ready ? '#137333' : 'rgba(0, 0, 0, 0.6)'
        }}
      >
        {ready ? 'surface ready' : '等待壳握手…'}
      </p>
      <p style={{ fontSize: 12, margin: 0, opacity: 0.6 }}>
        M3-S1 隔离面（未接编辑器）· theme: {theme}
      </p>
    </main>
  )
}
