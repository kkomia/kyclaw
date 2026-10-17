import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetNewTabStore, useNewTabStore } from '@renderer/features/newtab/new-tab-store'
import { OfficePage } from '../OfficePage'
import { resetOfficeActionsForTest } from '../office-actions'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import { resetOfficeUiStore } from '../office-ui-store'

/**
 * task-80：OfficePage 接线——空白伪标签在前台时渲染 NewTabPage，文档区 `hidden + inert`
 * 但**保持挂载**（iframe / wasm / 未保存内容不卸载）；文档被激活（外部入口）时空白退出前台。
 */
beforeEach(() => {
  installKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeUiStore()
  resetOfficeActionsForTest()
  resetNewTabStore()
})

afterEach(() => {
  clearKyclawBridge()
  resetOfficeTabsStore()
  resetNewTabStore()
})

describe('OfficePage · task-80 空白伪标签接线', () => {
  it('没有空白：空态/文档区照旧，不渲染 NewTabPage', () => {
    render(
      <MemoryRouter>
        <OfficePage />
      </MemoryRouter>
    )

    expect(screen.getByTestId('office-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('newtab-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('office-documents')).not.toHaveAttribute('hidden')
  })

  it('空白前台：NewTabPage 出现；文档区 hidden+inert 但 DOM 不卸载（切回文档是同一个节点）', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    act(() => useNewTabStore.getState().open())
    render(
      <MemoryRouter>
        <OfficePage />
      </MemoryRouter>
    )

    expect(screen.getByTestId('newtab-page')).toBeInTheDocument()
    const documents = screen.getByTestId('office-documents')
    expect(documents).toHaveAttribute('hidden')
    expect(documents).toHaveAttribute('inert')

    // workspace 仍在 DOM（hidden 而已），记下节点身份
    const workspaces = screen.getByTestId('office-workspaces')
    expect(documents).toContainElement(workspaces)

    // 切回文档：同一 DOM 节点还在（没有卸载重建）
    act(() => useNewTabStore.getState().deactivate())
    expect(screen.queryByTestId('newtab-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('office-documents')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('office-workspaces')).toBe(workspaces)
  })

  it('无标签时空白前台：旧空态保留在 DOM（hidden），空白关闭后回来', () => {
    act(() => useNewTabStore.getState().open())
    render(
      <MemoryRouter>
        <OfficePage />
      </MemoryRouter>
    )

    const empty = screen.getByTestId('office-empty')
    expect(screen.getByTestId('office-documents')).toHaveAttribute('hidden')
    expect(empty).toBeInTheDocument()

    act(() => useNewTabStore.getState().close())
    expect(screen.getByTestId('office-empty')).toBe(empty)
    expect(screen.getByTestId('office-documents')).not.toHaveAttribute('hidden')
  })

  it('外部入口激活文档（activeTabId 变化）：空白退出前台但标签保留（不自动关）', () => {
    const first = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    const second = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    // 起点：前台是 a（first 已不是 active），空白在前台
    act(() => useOfficeTabsStore.getState().activate(first))
    act(() => useNewTabStore.getState().open())
    render(
      <MemoryRouter>
        <OfficePage />
      </MemoryRouter>
    )
    expect(screen.getByTestId('newtab-page')).toBeInTheDocument()

    // 模拟聊天卡/其他入口直接激活另一文档
    act(() => useOfficeTabsStore.getState().activate(second))

    expect(useNewTabStore.getState()).toMatchObject({ isOpen: true, isActive: false })
    expect(screen.queryByTestId('newtab-page')).not.toBeInTheDocument()
  })
})
