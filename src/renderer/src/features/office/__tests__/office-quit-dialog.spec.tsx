import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeQuitRequestPayload, OfficeQuitResult } from '@shared/office-editor'
import { OfficeQuitDialog } from '../OfficeQuitDialog'
import {
  isOfficeQuitInFlight,
  resetOfficeQuitFlowForTest,
  setPendingOfficeQuitRequest
} from '../office-quit-flow'
import { resetOfficeTabsStore, useOfficeTabsStore, type OfficeTab } from '../office-tabs-store'

const QUIT_REQUEST: OfficeQuitRequestPayload = { requestId: 'req-1', reason: 'quit', dirtyCount: 2 }

function tab(id: string, title: string, patch: Partial<OfficeTab> = {}): OfficeTab {
  return { id, kind: 'docx', title, dirty: true, readOnly: false, lastActiveAt: 0, ...patch }
}

const DIRTY_TABS = [tab('a', '方案.docx'), tab('b', '报告.docx')]

/** 可手动放行的 promise（保存进行中的中间态断言用） */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 等到所有微任务落地（注入的回包 spy 是异步收尾的） */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function seedTabs(tabs: OfficeTab[]): void {
  useOfficeTabsStore.setState({ tabs, activeTabId: tabs[0]?.id ?? '' })
}

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeQuitFlowForTest()
  seedTabs(DIRTY_TABS)
  // 对齐真实时序：请求在飞 = 退出流程在飞（AppShell 由 hook 写入 store 后才渲染本框）
  setPendingOfficeQuitRequest(QUIT_REQUEST)
})

afterEach(() => {
  resetOfficeTabsStore()
  resetOfficeQuitFlowForTest()
})

describe('OfficeQuitDialog：三态与 testid 契约', () => {
  it('打开即显示三态：标题按 reason、列出脏标签、testid 齐全、焦点初始在「保存全部」', async () => {
    render(<OfficeQuitDialog request={QUIT_REQUEST} />)

    expect(screen.getByTestId('office-quit-dialog')).toBeInTheDocument()
    expect(screen.getByText('退出前保存更改？')).toBeInTheDocument()
    expect(screen.getByText(/还有未保存的修改/)).toBeInTheDocument()
    expect(screen.getByText('方案.docx')).toBeInTheDocument()
    expect(screen.getByText('报告.docx')).toBeInTheDocument()
    expect(screen.getByTestId('office-quit-save-all')).toHaveTextContent('保存全部')
    expect(screen.getByTestId('office-quit-discard')).toHaveTextContent('放弃修改')
    expect(screen.getByTestId('office-quit-cancel')).toHaveTextContent('取消')
    // 进度与错误只在对应相位出现
    expect(screen.queryByTestId('office-quit-progress')).not.toBeInTheDocument()
    expect(screen.queryByTestId('office-quit-error')).not.toBeInTheDocument()
    // 首次焦点落在主按钮（用户回车就是"保存全部"）
    await waitFor(() => expect(screen.getByTestId('office-quit-save-all')).toHaveFocus())
    // 请求在飞 = 标签级脏三态避让（AppTabBar 读的就是这个）
    expect(isOfficeQuitInFlight()).toBe(true)
  })

  it('reason=close：标题用"关闭窗口"口径（与退出区分）', () => {
    render(<OfficeQuitDialog request={{ ...QUIT_REQUEST, reason: 'close' }} />)
    expect(screen.getByText('关闭窗口前保存更改？')).toBeInTheDocument()
    expect(screen.queryByText('退出前保存更改？')).not.toBeInTheDocument()
  })
})

describe('OfficeQuitDialog：保存全部', () => {
  it('成功：进度可见（0/2 → 1/2）→ 回 saved → 清待决请求（对话框关闭）', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const saves = [first, second]
    const saveTab = vi.fn(async () => saves.shift()?.promise ?? Promise.resolve(true))
    const respond = vi.fn<(result: OfficeQuitResult) => Promise<void>>(async () => undefined)

    render(<OfficeQuitDialog request={QUIT_REQUEST} saveTab={saveTab} respond={respond} />)
    fireEvent.click(screen.getByTestId('office-quit-save-all'))

    // 第一项开始：进度出现且是第一项
    expect(screen.getByTestId('office-quit-progress')).toHaveTextContent('正在保存 0/2')
    expect(screen.getByTestId('office-quit-progress')).toHaveTextContent('方案.docx')
    expect(respond).not.toHaveBeenCalled()

    first.resolve(true)
    await flush()
    expect(screen.getByTestId('office-quit-progress')).toHaveTextContent('正在保存 1/2')

    second.resolve(true)
    await flush()
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(respond).toHaveBeenCalledWith({ requestId: 'req-1', action: 'saved' })
    // 回包后清请求 → AppShell 卸载本框；标签级脏三态恢复响应
    expect(isOfficeQuitInFlight()).toBe(false)
  })

  it('失败：停在失败项、弹窗不关、role=alert；不自动回包，放弃修改才回 discarded', async () => {
    const saveTab = vi
      .fn<(entry: OfficeTab) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const respond = vi.fn<(result: OfficeQuitResult) => Promise<void>>(async () => undefined)

    render(<OfficeQuitDialog request={QUIT_REQUEST} saveTab={saveTab} respond={respond} />)
    fireEvent.click(screen.getByTestId('office-quit-save-all'))
    await flush()

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('「报告.docx」保存失败')
    expect(screen.getByTestId('office-quit-error')).toBe(alert)
    // 失败不假装成功、也不自动退出：对话框还在，回包还没发
    expect(screen.getByTestId('office-quit-dialog')).toBeInTheDocument()
    expect(respond).not.toHaveBeenCalled()
    // 可重试（保存全部仍可点）、也可放弃/取消
    expect(screen.getByTestId('office-quit-save-all')).toBeEnabled()
    expect(screen.getByTestId('office-quit-discard')).toBeEnabled()
    expect(screen.getByTestId('office-quit-cancel')).toBeEnabled()
    // 没有保存第三项（串行到失败项即停）
    expect(saveTab).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByTestId('office-quit-discard'))
    await flush()
    expect(respond).toHaveBeenCalledWith({ requestId: 'req-1', action: 'discarded' })
    expect(isOfficeQuitInFlight()).toBe(false)
  })

  it('保存中：三个按钮都禁用；Esc 不取消（不让半途中断的保存失去回收）', async () => {
    const pending = deferred<boolean>()
    const saveTab = vi.fn(async () => pending.promise)
    const respond = vi.fn<(result: OfficeQuitResult) => Promise<void>>(async () => undefined)

    render(<OfficeQuitDialog request={QUIT_REQUEST} saveTab={saveTab} respond={respond} />)
    fireEvent.click(screen.getByTestId('office-quit-save-all'))

    expect(screen.getByTestId('office-quit-save-all')).toBeDisabled()
    expect(screen.getByTestId('office-quit-discard')).toBeDisabled()
    expect(screen.getByTestId('office-quit-cancel')).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await flush()
    expect(respond).not.toHaveBeenCalled()
    expect(screen.getByTestId('office-quit-dialog')).toBeInTheDocument()

    pending.resolve(true)
    await flush()
    // 只有一项：放行后成功回 saved
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(respond).toHaveBeenCalledWith({ requestId: 'req-1', action: 'saved' })
  })
})

describe('OfficeQuitDialog：取消 / Esc', () => {
  it('取消按钮 → 回 cancelled（窗口保持打开）、清请求', async () => {
    const respond = vi.fn<(result: OfficeQuitResult) => Promise<void>>(async () => undefined)
    render(
      <OfficeQuitDialog
        request={QUIT_REQUEST}
        saveTab={vi.fn(async () => true)}
        respond={respond}
      />
    )

    fireEvent.click(screen.getByTestId('office-quit-cancel'))
    await flush()

    expect(respond).toHaveBeenCalledWith({ requestId: 'req-1', action: 'cancelled' })
    expect(isOfficeQuitInFlight()).toBe(false)
  })

  it('Esc → cancelled（Radix 的关闭路径与按钮同一条）', async () => {
    const respond = vi.fn<(result: OfficeQuitResult) => Promise<void>>(async () => undefined)
    render(
      <OfficeQuitDialog
        request={QUIT_REQUEST}
        saveTab={vi.fn(async () => true)}
        respond={respond}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await flush()

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ requestId: 'req-1', action: 'cancelled' })
    )
  })
})

describe('OfficeQuitDialog：与标签级脏三态互斥（键盘半边）', () => {
  it('本框开着时 Ctrl+W / Ctrl+S / Ctrl+Tab 被吞（AppTabBar 的 window 监听收不到）；Esc 照常透传', () => {
    render(<OfficeQuitDialog request={QUIT_REQUEST} />)
    // 模拟 AppTabBar 的快捷键监听（bubble 阶段挂在 window 上）
    const shellShortcut = vi.fn()
    window.addEventListener('keydown', shellShortcut)

    try {
      for (const event of [
        { key: 'w', ctrlKey: true },
        { key: 's', ctrlKey: true },
        { key: 'Tab', ctrlKey: true },
        { key: 'w', metaKey: true }
      ]) {
        expect(fireEvent.keyDown(document.body, event)).toBe(false) // preventDefault 过
      }
      expect(shellShortcut).not.toHaveBeenCalled()

      // Esc 不在屏蔽名单里：放行（Radix 用它关闭对话框）
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
      expect(shellShortcut).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', shellShortcut)
    }
  })
})
