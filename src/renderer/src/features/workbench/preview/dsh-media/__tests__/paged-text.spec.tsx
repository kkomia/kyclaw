import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextPage, TextPageResult, TextVersionResult } from '@shared/workbench-text'
import { PagedTextBody, POLL_INTERVAL_MS } from '../paged-text'
import type { TextPager } from '../text-pager'

/**
 * 分页文本体：加载更多 / 版本变了只提示不拼 / 重读回到原位置 / 隐藏标签不轮询。
 * 只喂一个假取数口（`TextPager`）就能把四条链路走完 —— 不起 IPC、不碰主进程。
 */

/** 造一页（缺省字段按"这一页就是全部"补） */
function pageOf(partial: Partial<TextPage> & { text: string }): TextPage {
  const size = partial.size ?? Buffer.byteLength(partial.text, 'utf8')
  return {
    kind: 'page',
    text: partial.text,
    offset: partial.offset ?? 0,
    nextOffset: partial.nextOffset ?? size,
    size,
    version: partial.version ?? 'v1',
    eof: partial.eof ?? true,
    overlongLine: partial.overlongLine ?? false
  }
}

/** 假取数口：`push` 决定续读按次序回什么；`version` 由 `probe` 闭包决定（用例中途改它） */
function fakePager(
  probe: () => TextVersionResult = () => ({ kind: 'version', version: 'v1', size: 0 })
): TextPager & {
  readPage: ReturnType<typeof vi.fn>
  version: ReturnType<typeof vi.fn>
  push: (...results: TextPageResult[]) => void
} {
  const queue: TextPageResult[] = []
  return {
    readPage: vi.fn(async (): Promise<TextPageResult> => queue.shift() ?? { kind: 'missing' }),
    version: vi.fn(async (): Promise<TextVersionResult> => probe()),
    push: (...results: TextPageResult[]) => {
      queue.push(...results)
    }
  }
}

/** 推进一个轮询节拍并把微任务放干净（假定时器下 React 的更新要在 act 里落；自动刷新还要等 readPage） */
async function tickPoll(times = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * times)
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PagedTextBody：加载更多', () => {
  it('还有下一页：显示"只显示前面一部分"与加载按钮；读完按钮消失（两页直接拼接）', async () => {
    const first = pageOf({ text: '第一段\n', nextOffset: 4, size: 8, eof: false })
    const pager = fakePager()
    pager.push(pageOf({ text: '第二段\n', offset: 4, nextOffset: 8, size: 8, eof: true }))

    render(<PagedTextBody mode="text" language={null} first={first} pager={pager} />)
    expect(screen.getByTestId('file-preview-text')).toHaveTextContent('第一段')
    expect(screen.getByTestId('paged-text-more-row')).toHaveTextContent('只显示前面一部分')

    fireEvent.click(screen.getByTestId('paged-text-more'))
    await act(async () => {})

    expect(screen.getByTestId('file-preview-text').textContent).toBe('第一段\n第二段\n')
    expect(screen.queryByTestId('paged-text-more-row')).toBeNull()
    expect(screen.getByTestId('paged-text')).toHaveAttribute('data-complete', 'true')
  })

  it('续读遇到 changed：**不拼接**、给提示与重读按钮', async () => {
    const first = pageOf({ text: '旧内容\n', nextOffset: 4, size: 8, eof: false })
    const pager = fakePager()
    pager.push({ kind: 'changed' })

    render(<PagedTextBody mode="text" language={null} first={first} pager={pager} />)
    fireEvent.click(screen.getByTestId('paged-text-more'))
    await act(async () => {})

    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'changed')
    expect(screen.getByTestId('paged-text-reload')).toBeInTheDocument()
    // 已经显示的内容一个字符都没变（这就是"不混版本"）
    expect(screen.getByTestId('file-preview-text').textContent).toBe('旧内容\n')
  })

  it('超长行：如实说明被切开过', () => {
    const first = pageOf({
      text: 'x'.repeat(100),
      nextOffset: 100,
      size: 200,
      eof: false,
      overlongLine: true
    })
    render(<PagedTextBody mode="text" language={null} first={first} pager={fakePager()} />)
    expect(screen.getByTestId('paged-text-overlong')).toHaveTextContent('超长行')
  })
})

describe('PagedTextBody：版本轮询（受控）与自动刷新语义', () => {
  it('没上翻 + 范围不大：版本变了**自动刷新**（内容换新、无按钮）', async () => {
    vi.useFakeTimers()
    let current: TextVersionResult = { kind: 'version', version: 'v1', size: 8 }
    const pager = fakePager(() => current)
    // 第二版的第一页（重读时会被取走）
    pager.push(pageOf({ text: '新内容\n', version: 'v2', size: 9, eof: true }))

    let scrollTop = 0
    render(
      <div data-testid="scroll-host" style={{ overflowY: 'auto' }}>
        <PagedTextBody
          mode="text"
          language={null}
          first={pageOf({ text: '旧内容\n', version: 'v1', size: 8 })}
          pager={pager}
        />
      </div>
    )
    const host = screen.getByTestId('scroll-host')
    Object.defineProperty(host, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
      configurable: true
    })

    current = { kind: 'version', version: 'v2', size: 9 }
    await tickPoll(1)
    await act(async () => {})

    // 正文换成新版（不是"只提示"），且没有要用户点的按钮
    expect(screen.getByTestId('file-preview-text').textContent).toBe('新内容\n')
    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'refreshed')
    expect(screen.queryByTestId('paged-text-reload')).toBeNull()
    expect(scrollTop).toBe(0)
  })

  it('已上翻（读者在旧内容里）：**只提示**，不换内容、不抢位置', async () => {
    vi.useFakeTimers()
    let current: TextVersionResult = { kind: 'version', version: 'v1', size: 8 }
    const pager = fakePager(() => current)

    let scrollTop = 120
    render(
      <div data-testid="scroll-host" style={{ overflowY: 'auto' }}>
        <PagedTextBody
          mode="text"
          language={null}
          first={pageOf({ text: '旧内容\n', version: 'v1', nextOffset: 4, size: 8, eof: false })}
          pager={pager}
        />
      </div>
    )
    const host = screen.getByTestId('scroll-host')
    Object.defineProperty(host, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
      configurable: true
    })

    current = { kind: 'version', version: 'v2', size: 9 }
    await tickPoll(1)
    await act(async () => {})

    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'changed')
    expect(screen.getByTestId('paged-text-reload')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-text').textContent).toBe('旧内容\n')
    expect(scrollTop).toBe(120)
    // 自动这条路**一次正文都不读**（只有 stat）
    expect(pager.readPage).not.toHaveBeenCalled()
  })

  it('范围太大（已加载 > 自动上限）：也只提示，不静默拉一份大的', async () => {
    vi.useFakeTimers()
    let current: TextVersionResult = { kind: 'version', version: 'v1', size: 9_000_000 }
    const pager = fakePager(() => current)

    render(
      <PagedTextBody
        mode="text"
        language={null}
        first={pageOf({
          text: '开头\n',
          version: 'v1',
          nextOffset: 3_000_000,
          size: 9_000_000,
          eof: false
        })}
        pager={pager}
      />
    )

    current = { kind: 'version', version: 'v2', size: 9_000_000 }
    await tickPoll(1)
    await act(async () => {})

    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'changed')
    expect(pager.readPage).not.toHaveBeenCalled()
  })

  it('版本回到原值 → 提示收回', async () => {
    vi.useFakeTimers()
    let current: TextVersionResult = { kind: 'version', version: 'v1', size: 8 }
    const pager = fakePager(() => current)

    let scrollTop = 200
    render(
      <div data-testid="scroll-host" style={{ overflowY: 'auto' }}>
        <PagedTextBody
          mode="text"
          language={null}
          first={pageOf({ text: '内容\n', nextOffset: 4, size: 8, eof: false })}
          pager={pager}
        />
      </div>
    )
    const host = screen.getByTestId('scroll-host')
    Object.defineProperty(host, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
      configurable: true
    })

    current = { kind: 'version', version: 'v2', size: 9 }
    await tickPoll(1)
    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'changed')

    current = { kind: 'version', version: 'v1', size: 8 }
    await tickPoll(1)
    expect(screen.queryByTestId('paged-text-notice')).toBeNull()
  })

  it('文件没了 → 提示；卸载后不再轮询（定时器清掉）', async () => {
    vi.useFakeTimers()
    const pager = fakePager(() => ({ kind: 'missing' }))
    const view = render(
      <PagedTextBody mode="text" language={null} first={pageOf({ text: '内容\n' })} pager={pager} />
    )

    await tickPoll()
    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'missing')

    // 卸载把定时器清掉：再推进几拍也不该再有请求（不需要真等 4 秒）
    const calls = pager.version.mock.calls.length
    view.unmount()
    await tickPoll(3)
    expect(pager.version.mock.calls.length).toBe(calls)
  })

  it('窗口不可见时不轮询（不对隐藏窗口无限轮询）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const pager = fakePager()
    render(
      <PagedTextBody mode="text" language={null} first={pageOf({ text: 'x\n' })} pager={pager} />
    )

    await tickPoll(3)
    expect(pager.version).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('所在预览标签不在前台（标签全挂着的那半边）也不轮询', async () => {
    vi.useFakeTimers()
    const pager = fakePager()
    render(
      <section data-testid="workbench-panel" data-active="false">
        <PagedTextBody mode="text" language={null} first={pageOf({ text: 'x\n' })} pager={pager} />
      </section>
    )
    await tickPoll(3)
    expect(pager.version).not.toHaveBeenCalled()
  })

  it('标签在前台就轮询（同一条判据的正向）', async () => {
    vi.useFakeTimers()
    const pager = fakePager()
    render(
      <section data-testid="workbench-panel" data-active="true">
        <PagedTextBody mode="text" language={null} first={pageOf({ text: 'x\n' })} pager={pager} />
      </section>
    )
    await tickPoll()
    expect(pager.version).toHaveBeenCalledTimes(1)
  })
})

describe('PagedTextBody：重读回位（不混版本、不甩回开头）', () => {
  it('点"重新读取"从 0 重读覆盖原来的位置，并把滚动位置放回去', async () => {
    const first = pageOf({ text: '旧一\n', version: 'v1', nextOffset: 12, size: 24, eof: false })
    const pager = fakePager()
    // 先制造一次"版本已变"：加载更多拿到 changed
    pager.push({ kind: 'changed' })

    render(
      <div data-testid="scroll-host" style={{ overflowY: 'auto' }}>
        <PagedTextBody mode="text" language={null} first={first} pager={pager} />
      </div>
    )
    // jsdom 不做布局：显式给滚动位置一个能读写的实现
    const host = screen.getByTestId('scroll-host')
    let scrollTop = 42
    Object.defineProperty(host, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
      configurable: true
    })

    fireEvent.click(screen.getByTestId('paged-text-more'))
    await act(async () => {})
    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'changed')

    // 重读：从 0 开始，补到覆盖原来的位置（原来到 offset 12 → 读两页）
    pager.push(
      pageOf({ text: '新一\n', version: 'v2', nextOffset: 6, size: 24, eof: false }),
      pageOf({ text: '新二\n', version: 'v2', offset: 6, nextOffset: 12, size: 24, eof: false })
    )
    fireEvent.click(screen.getByTestId('paged-text-reload'))
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    expect(screen.getByTestId('file-preview-text').textContent).toBe('新一\n新二\n')
    expect(scrollTop).toBe(42)
    // 换到了新版本：提示从"要你点"变成"已刷新"（不再是 changed 那个按钮态）
    expect(screen.getByTestId('paged-text-notice')).toHaveAttribute('data-kind', 'refreshed')
    expect(screen.queryByTestId('paged-text-reload')).toBeNull()
    expect(screen.getByTestId('paged-text')).toHaveAttribute('data-version', 'v2')
  })
})
