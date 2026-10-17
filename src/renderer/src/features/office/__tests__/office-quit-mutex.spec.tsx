import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OfficeQuitRequestPayload } from '@shared/office-editor'
import { AppTabBar } from '@renderer/components/shell/AppTabBar'
import { resetOfficeActionsForTest } from '../office-actions'
import { resetOfficeQuitFlowForTest, setPendingOfficeQuitRequest } from '../office-quit-flow'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import { resetOfficeUiStore } from '../office-ui-store'

const QUIT_REQUEST: OfficeQuitRequestPayload = { requestId: 'req-1', reason: 'quit', dirtyCount: 1 }

const TAB_CONFIRM_TITLE = '关闭未保存的标签？'

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeActionsForTest()
  resetOfficeQuitFlowForTest()
  resetOfficeUiStore()
})

afterEach(() => {
  resetOfficeTabsStore()
  resetOfficeActionsForTest()
  resetOfficeQuitFlowForTest()
  resetOfficeUiStore()
})

function renderTabBar(): void {
  render(
    <MemoryRouter initialEntries={['/office']}>
      <AppTabBar />
    </MemoryRouter>
  )
}

/** 开一个脏 docx 标签（点关闭会拉起标签级三态） */
function seedDirtyTab(): void {
  act(() => {
    const id = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\方案.docx' })
    useOfficeTabsStore.getState().markDirty(id, true)
  })
}

describe('AppTabBar × 退出确认：两个对话框互斥（M3-S5-2）', () => {
  it('退出确认在飞时点标签关闭：不拉起标签级脏三态，标签原样留着', () => {
    seedDirtyTab()
    setPendingOfficeQuitRequest(QUIT_REQUEST)
    renderTabBar()

    fireEvent.click(screen.getByTestId('app-tab-close'))

    expect(screen.queryByText(TAB_CONFIRM_TITLE)).not.toBeInTheDocument()
    expect(screen.getByTestId('app-tab')).toBeInTheDocument()

    // 中键关闭同样被挡（它走同一个 requestClose）
    fireEvent.click(screen.getByTestId('app-tab'), { button: 1 })
    expect(screen.queryByText(TAB_CONFIRM_TITLE)).not.toBeInTheDocument()
  })

  it('反向：标签级脏三态已打开时退出请求到达 → 旧框收掉；退出请求清掉后关闭恢复正常', () => {
    seedDirtyTab()
    renderTabBar()

    // ① 正常路径：脏标签点关闭 → 弹标签级三态
    fireEvent.click(screen.getByTestId('app-tab-close'))
    expect(screen.getByText(TAB_CONFIRM_TITLE)).toBeInTheDocument()

    // ② 退出确认开始：标签级三态让位（两个 modal 不叠）
    act(() => setPendingOfficeQuitRequest(QUIT_REQUEST))
    expect(screen.queryByText(TAB_CONFIRM_TITLE)).not.toBeInTheDocument()

    // ③ 用户在退出框里取消（请求被清）→ 标签关闭恢复可用
    act(() => setPendingOfficeQuitRequest(null))
    fireEvent.click(screen.getByTestId('app-tab-close'))
    expect(screen.getByText(TAB_CONFIRM_TITLE)).toBeInTheDocument()
  })

  it('退出请求在飞时快捷键 no-op：Ctrl+W 不关标签、不再拉标签级三态', () => {
    seedDirtyTab()
    setPendingOfficeQuitRequest(QUIT_REQUEST)
    renderTabBar()

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })

    expect(screen.queryByText(TAB_CONFIRM_TITLE)).not.toBeInTheDocument()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
  })
})
