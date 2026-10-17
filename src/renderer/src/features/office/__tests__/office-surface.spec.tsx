import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { officeDocumentFixture } from '@renderer/__tests__/kyclaw-bridge'
import { OfficeSurface, type OfficeSurfaceStatus } from '../OfficeSurface'

/**
 * OfficeSurface（M3-S1 壳侧）：iframe 属性 / sandbox 最小面 / handshake 状态机。
 *
 * jsdom 里 iframe 不会真的导航（自定义 scheme 也加载不了），contentWindow 是 about:blank 窗口；
 * 这正好能模拟"消息来自我方 iframe"：把 MessageEvent 的 source 设成 iframe.contentWindow。
 * 真机加载链路（file:// 父页嵌 kyclaw-office:// 子页）由 e2e/_r020-office-surface.spec.ts 验收。
 */

const SURFACE_URL = 'kyclaw-office://surface/'

function getIframe(): HTMLIFrameElement {
  const iframe = screen.getByTestId('office-surface-iframe')
  if (!(iframe instanceof HTMLIFrameElement)) throw new Error('office-surface-iframe 不是 iframe')
  return iframe
}

/** 以"来自面"的形态派发一条消息 */
function dispatchFromSurface(data: unknown): void {
  const frameWindow = getIframe().contentWindow
  window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
}

describe('OfficeSurface：iframe 容器与最小 sandbox', () => {
  it('data-testid / src / sandbox 只有 allow-scripts allow-same-origin（不给 allow-top-navigation）', async () => {
    render(<OfficeSurface surfaceUrl={SURFACE_URL} />)
    const iframe = getIframe()

    expect(iframe).toHaveAttribute('title', 'Office 隔离面')
    // src 在 effect 挂完监听后才设（避免 hello 落在监听之前）
    await waitFor(() => expect(iframe).toHaveAttribute('src', SURFACE_URL))
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-popups')
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'loading')
  })
})

describe('OfficeSurface：handshake 状态机', () => {
  it('忽略来源不是本 iframe 的消息（file:// 父页 origin 不可信，source 才是唯一凭据）', async () => {
    const onStatusChange = vi.fn()
    render(<OfficeSurface surfaceUrl={SURFACE_URL} onStatusChange={onStatusChange} />)
    const iframe = getIframe()
    const frameWindow = iframe.contentWindow
    expect(frameWindow).not.toBeNull()

    const postMessage = vi.spyOn(frameWindow as Window, 'postMessage')
    // 伪造来源：source 为 null 的另一条消息
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'surface:hello', nonce: 'forged', version: 1 },
        source: null
      })
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'surface:hello', nonce: 'forged', version: 1 },
        source: window
      })
    )
    await waitFor(() => expect(postMessage).not.toHaveBeenCalled())
    expect(onStatusChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'loading')
  })

  it('hello → 回 init（nonce 原样带回 + locale/theme）；ready → ready 态与回调', async () => {
    const onStatusChange = vi.fn<(status: OfficeSurfaceStatus) => void>()
    render(
      <OfficeSurface surfaceUrl={SURFACE_URL} onStatusChange={onStatusChange} locale="zh-CN" />
    )
    const frameWindow = getIframe().contentWindow as Window
    const postMessage = vi.spyOn(frameWindow, 'postMessage')

    dispatchFromSurface({ type: 'surface:hello', nonce: 'nonce-1', version: 1 })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'surface:init', nonce: 'nonce-1', locale: 'zh-CN', theme: 'light' },
      '*'
    )
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'loading')

    dispatchFromSurface({ type: 'surface:ready', nonce: 'nonce-1' })
    await waitFor(() =>
      expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'ready')
    )
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(onStatusChange).toHaveBeenCalledWith('ready')
  })

  it('surface:fatal → fatal 态 + 错误条（文案来自面）', async () => {
    const onStatusChange = vi.fn<(status: OfficeSurfaceStatus) => void>()
    render(<OfficeSurface surfaceUrl={SURFACE_URL} onStatusChange={onStatusChange} />)

    dispatchFromSurface({ type: 'surface:fatal', message: 'wasm 加载失败' })

    await waitFor(() => expect(screen.getByTestId('office-surface-fatal')).toBeInTheDocument())
    expect(screen.getByTestId('office-surface-fatal')).toHaveTextContent('wasm 加载失败')
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'fatal')
    expect(onStatusChange).toHaveBeenCalledWith('fatal')
  })

  it('握手超时 → fatal（壳不会永远停在 loading）', async () => {
    render(<OfficeSurface surfaceUrl={SURFACE_URL} readyTimeoutMs={60} />)
    await waitFor(() => expect(screen.getByTestId('office-surface-fatal')).toBeInTheDocument(), {
      timeout: 2000
    })
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'fatal')
    expect(screen.getByTestId('office-surface-fatal')).toHaveTextContent('超时')
  })

  it('畸形消息（不是对象 / type 不认识 / nonce 为空）不改变状态', async () => {
    render(<OfficeSurface surfaceUrl={SURFACE_URL} />)
    const frameWindow = getIframe().contentWindow as Window
    const postMessage = vi.spyOn(frameWindow, 'postMessage')

    for (const data of [
      null,
      'hello',
      { type: 'surface:hello' },
      { type: 'surface:hello', nonce: '', version: 1 },
      { type: 'surface:ready', nonce: '' },
      42
    ]) {
      window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
    }
    await waitFor(() => expect(postMessage).not.toHaveBeenCalled())
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'loading')
    // 顺带钉住：iframe 里的火候没影响父页交互
    expect(screen.getByTestId('office-surface-iframe')).toBeInTheDocument()
  })
})

describe('OfficeSurface：M3-S2 文档投递与主题热切换', () => {
  it('ready 后用 postMessage 把 bytes 结构化克隆成 doc:open（nonce 来自 hello）', async () => {
    const info = officeDocumentFixture({ documentId: 'doc-open', displayName: '打开.docx' })
    const bytes = new Uint8Array([1, 2, 3, 4])
    render(
      <OfficeSurface
        surfaceUrl={SURFACE_URL}
        theme="dark"
        documentInfo={info}
        documentBytes={bytes}
      />
    )
    const frameWindow = getIframe().contentWindow as Window
    const postMessage = vi.spyOn(frameWindow, 'postMessage')

    dispatchFromSurface({ type: 'surface:hello', nonce: 'nonce-doc', version: 1 })
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'surface:init', nonce: 'nonce-doc', locale: 'zh-CN', theme: 'dark' },
      '*'
    )
    // ready 之前不能发文档（面还没应用 init）
    expect(
      postMessage.mock.calls.some((call) => (call[0] as { type: string }).type === 'doc:open')
    ).toBe(false)

    dispatchFromSurface({ type: 'surface:ready', nonce: 'nonce-doc' })

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: 'doc:open',
          nonce: 'nonce-doc',
          documentId: 'doc-open',
          name: '打开.docx',
          sha256: info.sha256,
          readOnly: false,
          bytes
        },
        '*'
      )
    )
  })

  it('同一文档只发一次 doc:open；换文档（不同 documentId）会重发', async () => {
    const first = officeDocumentFixture({ documentId: 'doc-1', displayName: '一.docx' })
    const renderer = render(
      <OfficeSurface
        surfaceUrl={SURFACE_URL}
        documentInfo={first}
        documentBytes={new Uint8Array([1])}
      />
    )
    const postMessage = vi.spyOn(getIframe().contentWindow as Window, 'postMessage')
    dispatchFromSurface({ type: 'surface:hello', nonce: 'n1', version: 1 })
    dispatchFromSurface({ type: 'surface:ready', nonce: 'n1' })
    await waitFor(() =>
      expect(
        postMessage.mock.calls.filter((call) => (call[0] as { type: string }).type === 'doc:open')
      ).toHaveLength(1)
    )

    // 父组件重渲染、同一 documentId：不重发
    renderer.rerender(
      <OfficeSurface
        surfaceUrl={SURFACE_URL}
        documentInfo={{ ...first }}
        documentBytes={new Uint8Array([1])}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(
      postMessage.mock.calls.filter((call) => (call[0] as { type: string }).type === 'doc:open')
    ).toHaveLength(1)

    // 切到另一份文档：同一 iframe 内重发 doc:open
    renderer.rerender(
      <OfficeSurface
        surfaceUrl={SURFACE_URL}
        documentInfo={officeDocumentFixture({ documentId: 'doc-2', displayName: '二.docx' })}
        documentBytes={new Uint8Array([2])}
      />
    )
    await waitFor(() =>
      expect(
        postMessage.mock.calls.filter((call) => (call[0] as { type: string }).type === 'doc:open')
      ).toHaveLength(2)
    )
  })

  it('主题运行中切换：ready 后用同一 nonce 重发 init（不重载 iframe）', async () => {
    const renderer = render(<OfficeSurface surfaceUrl={SURFACE_URL} theme="light" />)
    const iframe = getIframe()
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage')
    dispatchFromSurface({ type: 'surface:hello', nonce: 'theme-nonce', version: 1 })
    dispatchFromSurface({ type: 'surface:ready', nonce: 'theme-nonce' })
    await waitFor(() =>
      expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'ready')
    )
    const srcBefore = iframe.getAttribute('src')

    renderer.rerender(<OfficeSurface surfaceUrl={SURFACE_URL} theme="dark" />)

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        { type: 'surface:init', nonce: 'theme-nonce', locale: 'zh-CN', theme: 'dark' },
        '*'
      )
    )
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-theme', 'dark')
    // 主题切换不是重载：src 不变、状态仍是 ready
    expect(iframe.getAttribute('src')).toBe(srcBefore)
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'ready')
  })
})
