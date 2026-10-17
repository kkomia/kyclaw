import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { OfficePage } from '../OfficePage'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import { resetOfficeUiStore, useOfficeUiStore } from '../office-ui-store'

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeUiStore()
  useSessionsStore.setState({ activeId: null })
})

describe('OfficePage：workspace 占位与空态（标签条已上移到顶栏）', () => {
  it('空态：标题 + 说明 + 「打开文件」入口；没有聊天、会话列表或标签', () => {
    render(<OfficePage />)

    expect(screen.getByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-page-title')).toHaveTextContent('Office')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('还没有打开的文档')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('切换会话不会关掉这里')
    expect(screen.getByTestId('office-open')).toHaveAccessibleName('打开文件')
    expect(screen.queryByTestId('office-tabs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('office-workspace')).not.toBeInTheDocument()
    // Office 是独立模块：这里不能出现主对话或会话列表
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(screen.queryByTestId('module-chat')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument()
  })

  it('「打开文件」先走示例对话框：选中后空态让位，workspace 占位出现（标签在顶栏，不在这里）', async () => {
    render(<OfficePage />)

    fireEvent.click(screen.getByTestId('office-open'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('打开文件（示例）')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByTestId('office-mock-open-docx'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.queryByTestId('office-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('项目计划')
    // M3-S1：DOCX 标签挂的是隔离面（iframe + 握手状态条），不再是纯占位
    expect(screen.getByTestId('office-surface-iframe')).toBeInTheDocument()
    expect(screen.getByTestId('office-surface-status')).toHaveAttribute('data-state', 'loading')
    expect(screen.queryByTestId('office-editor-placeholder')).not.toBeInTheDocument()
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
    // v2（用户 2026-10-17）：编辑器没接之前不许写「已保存」，改中性占位
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未接编辑器')
    expect(screen.queryByText('已保存')).not.toBeInTheDocument()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    // 标签条已上移到 TitleBar：页面里不再有第二个标签条 / 重复的「打开文件」按钮行
    expect(screen.queryByTestId('office-tabs')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByTestId('office-open')).not.toBeInTheDocument()
  })

  it('有标签态：workspace 跟当前激活标签走（dirty 状态也跟着变）', () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\方案.docx' })
    useOfficeTabsStore.getState().markDirty(docx)
    const pptx = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'D:\\汇报.pptx' })

    render(<OfficePage />)

    // 当前是后开的 pptx（未修改）
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('D:\\汇报.pptx')
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
    // 中性占位：不进编辑器前这里不谎报「已保存」，也没有绿点
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未接编辑器')
    expect(screen.getByTestId('office-dirty-status').querySelector('.rounded-full')).toBeNull()

    act(() => useOfficeTabsStore.getState().activate(docx))

    expect(screen.getByTestId('office-workspace')).toHaveTextContent('D:\\方案.docx')
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未保存修改')
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(useOfficeTabsStore.getState().activeTabId).not.toBe(pptx)
  })

  it('顶栏「＋」把 office-ui-store 的 pickerOpen 置位后，页面里的示例弹窗跟着打开', async () => {
    render(<OfficePage />)

    act(() => useOfficeUiStore.getState().openPicker())

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('打开文件（示例）')).toBeInTheDocument()
  })

  it('切换会话不改 Office 标签（标签不绑当前会话）', () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\方案.docx' })
    render(<OfficePage />)

    useSessionsStore.setState({ activeId: 'thread-2' })

    expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([docx])
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('方案.docx')
  })

  it('关掉最后一个标签回到空态', async () => {
    const pdf = useOfficeTabsStore.getState().open({ kind: 'pdf', path: 'D:\\产品说明.pdf' })
    render(<OfficePage />)

    act(() => {
      useOfficeTabsStore.getState().close(pdf)
    })

    await waitFor(() => expect(screen.getByTestId('office-empty')).toBeInTheDocument())
    expect(screen.queryByTestId('office-workspace')).not.toBeInTheDocument()
  })
})
