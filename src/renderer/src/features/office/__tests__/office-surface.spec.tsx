import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
