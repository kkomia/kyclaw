import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SurfaceBoot } from '../SurfaceBoot'
import { createSurfaceNonce, SURFACE_PROTOCOL_VERSION } from '../bridge-protocol'

/**
 * 面侧启动组件（M3-S1）：nonce → hello → init（nonce 校验）→ ready。
 * jsdom 里 window.parent === window，parent.postMessage 会被 window.postMessage 接住，
 * 这里用 spy 抓 hello、再手动回 init，验握手两端的协议形状。
 */
afterEach(() => {
  vi.restoreAllMocks()
  delete document.documentElement.dataset.surfaceTheme
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
})

/** 以"来自父页"的形态派发一条消息（jsdom 顶层页的 parent 就是自己） */
function dispatchFromParent(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}

/** 取面发出的 hello（第一帧） */
function helloOf(postMessage: ReturnType<typeof vi.spyOn>): {
  type: string
  nonce: string
  version: number
} {
  const call = postMessage.mock.calls[0]
  if (call === undefined) throw new Error('还没有发 hello')
  return call[0] as { type: string; nonce: string; version: number }
}

describe('SurfaceBoot：握手状态机', () => {
  it('先发 surface:hello（带版本与非空 nonce），收到匹配 nonce 的 init 后显示 surface ready', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)

    // ① 首帧 hello：攒到 nonce
    await waitFor(() => expect(postMessage).toHaveBeenCalled())
    const hello = helloOf(postMessage)
    expect(hello.type).toBe('surface:hello')
    expect(hello.version).toBe(SURFACE_PROTOCOL_VERSION)
    expect(hello.nonce.length).toBeGreaterThan(0)
    expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'booting')

    // ② 父页回 init（nonce 原样带回）
    act(() => {
      dispatchFromParent({
        type: 'surface:init',
        nonce: hello.nonce,
        locale: 'zh-CN',
        theme: 'dark'
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'ready')
    )
    expect(screen.getByTestId('surface-boot-state')).toHaveTextContent('surface ready')
    expect(document.documentElement.dataset.surfaceTheme).toBe('dark')
    // ③ 面回 ready（父页据此切 ready 态）
    const ready = postMessage.mock.calls
      .map((call) => call[0] as { type: string; nonce: string })
      .find((message) => message.type === 'surface:ready')
    expect(ready?.nonce).toBe(hello.nonce)
  })

  it('nonce 不匹配的 init 被忽略（防伪造 init）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())

    act(() => {
      dispatchFromParent({
        type: 'surface:init',
        nonce: 'forged-nonce',
        locale: 'zh-CN',
        theme: 'light'
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'booting')
    expect(
      postMessage.mock.calls.some((call) => (call[0] as { type: string }).type === 'surface:ready')
    ).toBe(false)
  })

  it('createSurfaceNonce 每次都不同且非空', () => {
    const a = createSurfaceNonce()
    const b = createSurfaceNonce()
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})
