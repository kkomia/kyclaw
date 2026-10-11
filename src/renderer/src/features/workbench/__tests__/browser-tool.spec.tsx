import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserTool } from '../BrowserTool'
import { setupWorkbench, teardownWorkbench } from './bed'

/**
 * 浏览器工具：自绘工具条 + 内嵌 `<webview>`。
 * jsdom 里没有真的 webview 实现，所以用例在渲染后**给元素补上方法**，再用真实的事件
 * （did-navigate / did-start-loading / did-fail-load）驱动状态 —— 验的是渲染端接线与口径。
 */
function webviewOf(container: HTMLElement): HTMLElement & Record<string, unknown> {
  const node = container.querySelector('webview')
  if (node === null) throw new Error('没有渲染出 webview')
  const fake = node as HTMLElement & Record<string, unknown>
  fake.loadURL = vi.fn(async () => undefined)
  fake.canGoBack = () => true
  fake.canGoForward = () => false
  fake.goBack = vi.fn()
  fake.goForward = vi.fn()
  fake.reload = vi.fn()
  fake.stop = vi.fn()
  return fake
}

function navigate(node: HTMLElement, type: string, detail: Record<string, unknown>): void {
  const event = new Event(type)
  Object.assign(event, detail)
  node.dispatchEvent(event)
}

beforeEach(() => {
  setupWorkbench()
})

afterEach(() => {
  teardownWorkbench()
})

describe('BrowserTool', () => {
  it('工具条与空白页：后退/前进不可走、外部打开不可用，给空态提示', () => {
    const { container } = render(<BrowserTool />)

    expect(screen.getByTestId('browser-webview')).toBeInTheDocument()
    expect(screen.getByLabelText('后退')).toBeDisabled()
    expect(screen.getByLabelText('前进')).toBeDisabled()
    expect(screen.getByLabelText('在系统浏览器中打开')).toBeDisabled()
    expect(screen.getByTestId('browser-empty')).toHaveTextContent('输入网址开始浏览')
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'persist:kyclaw-browser'
    )
  })

  it('输入网址回车：补协议后 loadURL；导航事件回来后地址栏与空态跟上', async () => {
    const { container } = render(<BrowserTool />)
    const node = webviewOf(container)

    fireEvent.change(screen.getByTestId('browser-url'), { target: { value: 'example.com' } })
    fireEvent.submit(screen.getByTestId('browser-url').closest('form') as HTMLFormElement)

    await waitFor(() => expect(node.loadURL).toHaveBeenCalledWith('https://example.com'))

    navigate(node, 'did-navigate', { url: 'https://example.com/' })
    navigate(node, 'page-title-updated', { title: '示例站点' })

    await waitFor(() =>
      expect(screen.getByTestId('browser-url')).toHaveValue('https://example.com/')
    )
    expect(screen.getByTestId('browser-title')).toHaveTextContent('示例站点')
    expect(screen.queryByTestId('browser-empty')).not.toBeInTheDocument()
    // 历史可走性同步过来了
    expect(screen.getByLabelText('后退')).not.toBeDisabled()
    expect(screen.getByLabelText('前进')).toBeDisabled()
  })

  it('加载中刷新按钮变停止，点了调 stop', async () => {
    const { container } = render(<BrowserTool />)
    const node = webviewOf(container)

    navigate(node, 'did-start-loading', {})
    await waitFor(() => expect(screen.getByLabelText('停止加载')).toBeInTheDocument())
    expect(screen.queryByLabelText('重新加载')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('停止加载'))
    expect(node.stop).toHaveBeenCalled()

    navigate(node, 'did-stop-loading', {})
    await waitFor(() => expect(screen.getByLabelText('重新加载')).toBeInTheDocument())
  })

  it('加载失败翻人话；用户自己停下（-3）不报错', async () => {
    const { container } = render(<BrowserTool />)
    const node = webviewOf(container)

    navigate(node, 'did-fail-load', {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://nope.invalid',
      isMainFrame: true
    })
    await waitFor(() =>
      expect(screen.getByTestId('browser-error')).toHaveTextContent('域名解析不了')
    )

    navigate(node, 'did-navigate', { url: 'https://example.com/' })
    await waitFor(() => expect(screen.queryByTestId('browser-error')).not.toBeInTheDocument())

    navigate(node, 'did-fail-load', {
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://example.com/',
      isMainFrame: true
    })
    expect(screen.queryByTestId('browser-error')).not.toBeInTheDocument()
  })

  it('外部打开：调 window.open（主进程收口到系统浏览器）', async () => {
    const { container } = render(<BrowserTool />)
    const node = webviewOf(container)
    const open = vi.fn()
    vi.stubGlobal('open', open)

    navigate(node, 'did-navigate', { url: 'https://example.com/' })
    await waitFor(() => expect(screen.getByLabelText('在系统浏览器中打开')).not.toBeDisabled())

    fireEvent.click(screen.getByLabelText('在系统浏览器中打开'))
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank')
    vi.unstubAllGlobals()
  })
})
