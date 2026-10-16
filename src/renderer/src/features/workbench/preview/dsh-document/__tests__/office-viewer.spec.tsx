import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshOfficeViewer } from '../DshOfficeViewer'
import { fontNoticeText } from '../office'

/* ── 替身：Office 这一层只关心"转换态"，PDF 那侧给最小替身让阅读器能起来 ─── */

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mocks.getDocument(...args)
}))

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  TextLayerBuilder: class {
    readonly div = document.createElement('div')
    render(): Promise<void> {
      return Promise.resolve()
    }
    cancel(): void {
      this.div.replaceChildren()
    }
  }
}))

/** 一份"能打开"的 PDF 替身（转换后的字节长什么样不重要，这里只验证接线）。 */
function usableDocument(): Record<string, unknown> {
  return {
    numPages: 1,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 800 * scale,
        height: 1000 * scale,
        scale,
        userUnit: 1
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
      cleanup: () => undefined
    })
  }
}

beforeEach(() => {
  mocks.getDocument.mockReset()
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve(usableDocument()),
    destroy: async () => undefined
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DshOfficeViewer：转换 → 复用 PDF 阅读器', () => {
  it('转换成功：置 ready 并挂上同一个 PDF 阅读器', async () => {
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]))

    render(<DshOfficeViewer load={load} />)

    // 转换中：先给一句"正在转"，不空着
    expect(screen.getByTestId('dsh-office-loading')).toHaveTextContent('正在把这份文档转成')

    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(screen.getByTestId('dsh-pdf-viewer')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('缺字体：如实提示一句（含字体名），一种都不缺就不提示', async () => {
    const load = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      missingFonts: ['方正兰亭黑', '  ', '思源宋体', '方正兰亭黑']
    }))

    const { rerender } = render(<DshOfficeViewer load={load} />)

    const notice = await screen.findByTestId('dsh-office-font-notice')
    expect(notice).toHaveTextContent('这份文档用到的字体本机没有：方正兰亭黑、思源宋体')
    expect(notice).toHaveTextContent('版式可能和原稿不一样')

    const clean = vi.fn(async () => ({ bytes: new Uint8Array([2]), missingFonts: [] }))
    rerender(<DshOfficeViewer load={clean} revision={2} />)
    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(screen.queryByTestId('dsh-office-font-notice')).toBeNull()
  })

  it('转换失败：给人话（宿主可以自己换一套），重试再转一次', async () => {
    let attempts = 0
    const load = async (): Promise<Uint8Array> => {
      attempts += 1
      if (attempts === 1) throw new Error('这份 PPT 转不出来')
      return new Uint8Array([1])
    }
    const describeFailure = vi.fn(() => '转换引擎正忙，稍后再试')

    render(<DshOfficeViewer load={load} describeFailure={describeFailure} />)

    const error = await screen.findByTestId('dsh-office-error')
    expect(error).toHaveTextContent('转换引擎正忙，稍后再试')

    fireEvent.click(screen.getByTestId('dsh-office-retry'))

    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(attempts).toBe(2)
  })

  it('卸载即取消：转换口收到的 signal 被中止（别让主进程继续白转）', async () => {
    let captured: AbortSignal | undefined
    const load = vi.fn((signal: AbortSignal) => {
      captured = signal
      return new Promise<Uint8Array>(() => undefined)
    })

    const { unmount } = render(<DshOfficeViewer load={load} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    expect(captured?.aborted).toBe(false)

    unmount()

    expect(captured?.aborted).toBe(true)
  })

  it('取消（AbortError）不落错误态：那是换文件 / 卸载，不是失败', async () => {
    const cancelled = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const load = vi.fn(async () => {
      throw cancelled
    })

    render(<DshOfficeViewer load={load} />)

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('dsh-office-error')).toBeNull()
    expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'loading')
  })

  it('revision 变了才重新转：load 每次渲染新建也不会把 effect 顶成死循环', async () => {
    const load = vi.fn(async () => new Uint8Array([1]))

    const { rerender } = render(<DshOfficeViewer load={load} revision={1} />)
    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(load).toHaveBeenCalledTimes(1)

    // 同一令牌 + 新的 load 身份：不重转
    rerender(<DshOfficeViewer load={() => Promise.resolve(new Uint8Array([1]))} revision={1} />)
    await waitFor(() =>
      expect(screen.getByTestId('dsh-office-viewer')).toHaveAttribute('data-state', 'ready')
    )
    expect(load).toHaveBeenCalledTimes(1)

    // 令牌变了：转一次新的
    rerender(<DshOfficeViewer load={load} revision={2} />)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })
})

describe('fontNoticeText：缺字体的人话', () => {
  it('去重去空白；一种都没有给 null', () => {
    expect(fontNoticeText(undefined)).toBeNull()
    expect(fontNoticeText([])).toBeNull()
    expect(fontNoticeText(['  ', ''])).toBeNull()
    expect(fontNoticeText(['A', ' A ', 'B'])).toBe(
      '这份文档用到的字体本机没有：A、B；版式可能和原稿不一样'
    )
  })

  it('超过三种只列三种，其余报个数', () => {
    expect(fontNoticeText(['A', 'B', 'C', 'D', 'E'])).toBe(
      '这份文档用到的字体本机没有：A、B、C 等 5 种；版式可能和原稿不一样'
    )
  })
})
