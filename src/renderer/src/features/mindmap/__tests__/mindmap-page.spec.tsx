import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PB-024 导图模块：最小可用形态（左 Mermaid 文本 / 右 Pele 渲染 / AI 诚实占位）。
 * Pele 在这里 mock 掉（真机渲染由 Nia/打包态截图覆盖）；本 spec 钉：
 *   1. 默认给示例（非空态），「新建」给最小模板；
 *   2. mount/update 调用与文本变化同步（渲染层被调用）；
 *   3. 渲染错误可见（错误条 + 状态栏）；
 *   4. localStorage 自动保存（debounce 500ms）；
 *   5. AI 占位文案与 Office 同一口径。
 */
const mountMock = vi.hoisted(() => ({
  mount: vi.fn(),
  register: vi.fn(),
  lastHandle: null as null | {
    update: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    zoom: { reset: ReturnType<typeof vi.fn> }
  },
  lastOptions: undefined as undefined | Record<string, unknown>,
  lastText: ''
}))

vi.mock('pele/core', () => ({
  mount: (el: HTMLElement, text: string, options?: Record<string, unknown>) => {
    const handle = {
      update: vi.fn((next: string, opts?: Record<string, unknown>) => {
        mountMock.lastOptions = opts
        mountMock.lastText = next
      }),
      destroy: vi.fn(),
      zoom: { reset: vi.fn() },
      result: undefined,
      source: text,
      error: undefined
    }
    mountMock.lastHandle = handle
    mountMock.lastOptions = options
    mountMock.lastText = text
    mountMock.mount(el, text, options)
    return handle
  },
  register: (diagram: unknown) => mountMock.register(diagram)
}))

vi.mock('pele/diagrams/mindmap', () => ({ default: { type: 'mindmap' } }))

import { MindmapPage } from '../MindmapPage'
import { DEFAULT_MINDMAP_TEXT, MINDMAP_STORAGE_KEY, NEW_MINDMAP_TEXT } from '../mindmap-text'

const mountSpy = mountMock.mount as unknown as ReturnType<typeof vi.fn>
const lastOptions = (): {
  onError?: (e: unknown) => void
  onRender?: () => void
} => mountMock.lastOptions as { onError?: (e: unknown) => void; onRender?: () => void }

beforeEach(() => {
  window.localStorage.clear()
  mountSpy.mockClear()
  mountMock.lastHandle = null
  mountMock.lastOptions = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MindmapPage：文本 + 预览最小形态', () => {
  it('默认示例（非空态）；Pele mount 被调用一次；AI 占位文案可见', async () => {
    render(<MindmapPage />)
    const editor = screen.getByTestId('mindmap-editor') as HTMLTextAreaElement
    expect(editor.value).toContain('mindmap')
    expect(editor.value).toBe(DEFAULT_MINDMAP_TEXT)
    expect(mountSpy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(mountMock.register).toHaveBeenCalledWith({ type: 'mindmap' }))
    expect(await screen.findByTestId('mindmap-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-ai-placeholder')).toHaveTextContent('AI 编辑能力尚未接入')
  })

  it('编辑文本 → update 被调用；字符数实时更新', () => {
    render(<MindmapPage />)
    const editor = screen.getByTestId('mindmap-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'mindmap\n  root((a))' } })
    expect(mountMock.lastText).toBe('mindmap\n  root((a))')
    expect(screen.getByTestId('mindmap-chars')).toHaveTextContent('19 字符')
  })

  it('渲染错误可见（错误条 + 状态栏提示），成功后恢复', async () => {
    render(<MindmapPage />)
    act(() => lastOptions().onError?.(new Error('Parse error: bad mindmap')))
    expect(await screen.findByTestId('mindmap-error')).toHaveTextContent('Parse error: bad mindmap')
    expect(screen.getByTestId('mindmap-status')).toHaveTextContent('语法错误')
    act(() => lastOptions().onRender?.())
    expect(screen.queryByTestId('mindmap-error')).not.toBeInTheDocument()
  })

  it('自动保存：debounce 500ms 写入 localStorage；新建/示例按钮改文本', () => {
    vi.useFakeTimers()
    render(<MindmapPage />)
    const editor = screen.getByTestId('mindmap-editor') as HTMLTextAreaElement

    fireEvent.change(editor, { target: { value: 'mindmap\n  root((saved))' } })
    act(() => vi.advanceTimersByTime(600))
    expect(window.localStorage.getItem(MINDMAP_STORAGE_KEY)).toBe('mindmap\n  root((saved))')

    fireEvent.click(screen.getByTestId('mindmap-new'))
    expect(editor.value).toBe(NEW_MINDMAP_TEXT)
    fireEvent.click(screen.getByTestId('mindmap-example'))
    expect(editor.value).toBe(DEFAULT_MINDMAP_TEXT)
  })

  it('适配按钮调用 zoom.reset（Pele 自带缩放）', () => {
    render(<MindmapPage />)
    fireEvent.click(screen.getByTestId('mindmap-reset-zoom'))
    expect(mountMock.lastHandle?.zoom.reset).toHaveBeenCalledTimes(1)
  })

  it('侧边栏入口 + 路由可达：/mindmap 渲染导图页，入口按路径选中', async () => {
    const { installKyclawBridge, clearKyclawBridge } =
      await import('@renderer/__tests__/kyclaw-bridge')
    installKyclawBridge()
    try {
      const { AppRoutes } = await import('@renderer/App')
      render(
        <MemoryRouter initialEntries={['/mindmap']}>
          <AppRoutes />
        </MemoryRouter>
      )
      expect(
        await screen.findByTestId('mindmap-page', undefined, { timeout: 15_000 })
      ).toBeInTheDocument()
      expect(screen.getByTestId('primary-nav-mindmap')).toHaveAttribute('aria-current', 'page')
    } finally {
      clearKyclawBridge()
    }
  })
})
