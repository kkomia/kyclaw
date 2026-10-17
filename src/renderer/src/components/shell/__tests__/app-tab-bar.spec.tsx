import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture
} from '@renderer/__tests__/kyclaw-bridge'
import {
  handleOfficeShortcut,
  resetOfficeActionsForTest
} from '@renderer/features/office/office-actions'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import { resetOfficeUiStore, useOfficeUiStore } from '@renderer/features/office/office-ui-store'
import { AppTabBar, type AppTabBarProps } from '../AppTabBar'

beforeEach(() => {
  installKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeUiStore()
  resetOfficeActionsForTest()
})

afterEach(() => {
  clearKyclawBridge()
  resetOfficeActionsForTest()
})

/** 路由落点探针：点标签 / 按「＋」之后要能断言真的去了目标路由 */
function LocationProbe(): React.JSX.Element {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

/** 默认从 /chat 进（主对话标签激活）；office 相关用例显式传 '/office' */
function renderTabBar(props: AppTabBarProps = {}, path = '/chat'): () => void {
  const { unmount } = render(
    <MemoryRouter initialEntries={[path]}>
      <AppTabBar {...props} />
      <LocationProbe />
    </MemoryRouter>
  )
  return unmount
}

/** 文档标签（不含固定的「主对话」标签） */
function documentTabs(): HTMLElement[] {
  return screen.getAllByTestId('app-tab')
}

describe('AppTabBar：顶栏浏览器式标签栏', () => {
  it('固定「主对话」标签：永远最靠左、图标+文案、没有关闭钮；文档标签排在它右侧', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    renderTabBar({}, '/office')

    const scroll = screen.getByTestId('app-tabbar-scroll')
    const chatTab = screen.getByTestId('app-tab-chat')
    expect(chatTab).toHaveTextContent('主对话')
    // 固定位在最左：滚动容器的第一个子节点就是「主对话」
    expect(scroll.firstElementChild).toContainElement(chatTab)
    expect(chatTab.querySelector('svg')?.getAttribute('class')).toContain('lucide-message-square')
    // 不可关闭：固定标签里没有关闭钮
    expect(within(chatTab.parentElement as HTMLElement).queryByTestId('app-tab-close')).toBeNull()

    // 文档标签在它右侧、仍是可关闭的普通标签
    expect(documentTabs()).toHaveLength(2)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '关闭 a.docx' })).toBeInTheDocument()
  })

  it('文档标签：类型图标 + 标题 + 关闭钮 + dirty 圆点；/office 下激活白底 pill、未激活纯文字', () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\方案.docx' })
    useOfficeTabsStore.getState().markDirty(docx)
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'D:\\汇报.pptx' })
    renderTabBar({}, '/office')

    const tabs = documentTabs()
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveTextContent('方案.docx')
    expect(tabs[0]?.querySelector('svg')?.getAttribute('class')).toContain('lucide-file-text')
    expect(tabs[1]?.querySelector('svg')?.getAttribute('class')).toContain('lucide-presentation')
    // 激活 = 白底（bg-surface → --bg-primary）圆角 pill；未激活不铺底
    expect(tabs[1]).toHaveClass('bg-surface', 'rounded-control')
    expect(tabs[0]).not.toHaveClass('bg-surface')
    // 宽度区间 100~150（宽窄由内容决定，溢出不再压缩）
    expect(tabs[0]?.parentElement).toHaveClass('min-w-[100px]', 'max-w-[150px]')
    expect(within(tabs[0] as HTMLElement).getByTestId('app-tab-dirty')).toBeInTheDocument()
    expect(within(tabs[1] as HTMLElement).queryByTestId('app-tab-dirty')).toBeNull()
    expect(screen.getByRole('button', { name: '关闭 方案.docx' })).toBeInTheDocument()
  })

  it('激活态按路由收敛：/chat 下文档标签不高亮（activeTabId 保留）、主对话高亮；点标签回 /office 恢复', () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    const pptx = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    renderTabBar({}, '/chat')

    const chatTab = screen.getByTestId('app-tab-chat')
    expect(chatTab).toHaveAttribute('aria-selected', 'true')
    expect(chatTab).toHaveClass('bg-surface')
    for (const tab of documentTabs()) {
      expect(tab, 'chat 路由下文档标签不该高亮').toHaveAttribute('aria-selected', 'false')
      expect(tab).not.toHaveClass('bg-surface')
    }
    // activeTabId 不因路由变化丢掉
    expect(useOfficeTabsStore.getState().activeTabId).toBe(pptx)

    // 点文档标签：激活 + 回 /office → 高亮恢复、主对话让位
    fireEvent.click(screen.getByRole('tab', { name: /a\.docx/ }))
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
    expect(screen.getByTestId('location')).toHaveTextContent('/office')
    expect(screen.getByRole('tab', { name: /a\.docx/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('app-tab-chat')).toHaveAttribute('aria-selected', 'false')

    // 再点主对话：回 /chat，文档标签全部让出激活态，但 activeTabId 仍是 docx
    fireEvent.click(screen.getByTestId('app-tab-chat'))
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
    for (const tab of documentTabs()) expect(tab).toHaveAttribute('aria-selected', 'false')
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
  })

  it('既不是 chat 也不是 office 的路由（如 /notes）：主对话与文档标签都不高亮', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    renderTabBar({}, '/notes')

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('aria-selected', 'false')
    }
  })

  it('点击主对话标签：navigate /chat（固定标签不激活文档标签）', () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    renderTabBar({}, '/office')

    fireEvent.click(screen.getByTestId('app-tab-chat'))

    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
  })

  it('主对话标签不可关：无关闭钮、中键无效、没有文档标签时 Ctrl+W 不拦也不关它', () => {
    renderTabBar()

    const chatTab = screen.getByTestId('app-tab-chat')
    expect(within(chatTab.parentElement as HTMLElement).queryByTestId('app-tab-close')).toBeNull()

    // 中键：固定标签没有关闭路径，也不该导航或起默认动作
    fireEvent(chatTab, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
    expect(screen.getByTestId('app-tab-chat')).toBeInTheDocument()

    // 没有文档标签：Ctrl+W 不归我们管（不 preventDefault），固定标签也永远关不到
    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(true)
    expect(screen.getByTestId('app-tab-chat')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('标签间 1px 分隔线：active 两侧隐藏（含主对话与第一个文档标签之间）', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    useOfficeTabsStore.getState().open({ kind: 'xlsx', path: 'c.xlsx' })

    // /office：active = 第 3 个文档标签 → 它左侧那条隐藏，其余可见
    const { unmount } = render(
      <MemoryRouter initialEntries={['/office']}>
        <AppTabBar />
      </MemoryRouter>
    )
    let dividers = screen.getAllByTestId('app-tab-divider')
    expect(dividers).toHaveLength(3)
    expect(dividers[0]).not.toHaveClass('opacity-0')
    expect(dividers[1]).not.toHaveClass('opacity-0')
    expect(dividers[2]).toHaveClass('opacity-0')

    // 点第 1 个文档标签：它自身 + 右侧那条都隐藏，最右那条可见
    fireEvent.click(documentTabs()[0] as HTMLElement)
    dividers = screen.getAllByTestId('app-tab-divider')
    expect(dividers[0]).toHaveClass('opacity-0')
    expect(dividers[1]).toHaveClass('opacity-0')
    expect(dividers[2]).not.toHaveClass('opacity-0')
    unmount()

    // /chat：主对话激活 → 与第一个文档标签之间那条隐藏，文档之间照常显示
    renderTabBar()
    dividers = screen.getAllByTestId('app-tab-divider')
    expect(dividers).toHaveLength(3)
    expect(dividers[0]).toHaveClass('opacity-0')
    expect(dividers[1]).not.toHaveClass('opacity-0')
    expect(dividers[2]).not.toHaveClass('opacity-0')
  })

  it('关闭非脏标签：默认走 closeOfficeTab（先释放主进程注册表再关）；中键能关；dirty 时先确认', async () => {
    const bridge = installKyclawBridge()
    useOfficeTabsStore.getState().openDocument(officeDocumentFixture({ documentId: 'doc-rel' }))
    const pptx = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    renderTabBar()

    fireEvent.click(screen.getByRole('button', { name: '关闭 方案.docx' }))
    await waitFor(() =>
      expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([pptx])
    )
    expect(bridge.office.release).toHaveBeenCalledWith('doc-rel')
    expect(screen.queryByRole('button', { name: '关闭 方案.docx' })).not.toBeInTheDocument()

    fireEvent(
      documentTabs()[0] as HTMLElement,
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    )
    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(0))
    expect(screen.getByTestId('app-tab-chat')).toBeInTheDocument()

    // dirty 时中键同样先弹确认，标签不先没
    let dirty = ''
    act(() => {
      dirty = useOfficeTabsStore.getState().open({ kind: 'xlsx', path: 'c.xlsx' })
      useOfficeTabsStore.getState().markDirty(dirty)
    })
    fireEvent(
      documentTabs()[0] as HTMLElement,
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([dirty])
  })

  it('关脏标签三态：取消保留、放弃才关；没有运行时「保存」仍显示但失败停弹窗；弹窗态 Ctrl+W no-op 但仍拦默认', async () => {
    const bridge = installKyclawBridge()
    const docx = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-dirty' }))
    useOfficeTabsStore.getState().markDirty(docx)
    renderTabBar()

    fireEvent.click(screen.getByRole('button', { name: '关闭 方案.docx' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('关闭未保存的标签？')).toBeInTheDocument()
    // 三态齐全：保存 / 放弃 / 取消（保存档不再因"没接编辑器"而消失）
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '放弃修改' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeInTheDocument()

    // 确认弹窗打开时 Ctrl+W：no-op（标签还在），但必须拦住 Electron 的默认关窗
    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(false)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)

    // 点「保存」但注册表里没有运行时：保存返回 false → 停在弹窗、标签不丢
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' })).toBeEnabled()
    )
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(bridge.office.save).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /方案\.docx/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭 方案.docx' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(0))
    expect(bridge.office.release).toHaveBeenCalledWith('doc-dirty')
    expect(screen.queryAllByTestId('app-tab')).toHaveLength(0)
    expect(screen.getByTestId('app-tab-chat')).toBeInTheDocument()
  })

  it('接口留了三态：注入 onSave 时出现「保存」，保存成功才关标签', async () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\方案.docx' })
    useOfficeTabsStore.getState().markDirty(docx)
    const onSave = vi.fn(async () => true)
    renderTabBar({ onSave })

    fireEvent.click(screen.getByRole('button', { name: '关闭 方案.docx' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(0))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: docx, dirty: true }))
  })

  it('Ctrl+Tab / Ctrl+Shift+Tab 只在 /office 轮换；命中即 preventDefault', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    const xlsx = useOfficeTabsStore.getState().open({ kind: 'xlsx', path: 'c.xlsx' })
    renderTabBar({}, '/office')

    // 从最后一个往前走 → 回到第一个
    expect(fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })).toBe(false)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(
      useOfficeTabsStore.getState().tabs[0]?.id
    )
    expect(screen.getByTestId('location')).toHaveTextContent('/office')

    // Shift 反向 → 回到最后一个
    expect(fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(xlsx)
  })

  it('Ctrl+Tab 在其他路由完全不抢键（/chat、/notes 都返回未拦）', () => {
    const xlsx = useOfficeTabsStore.getState().open({ kind: 'xlsx', path: 'c.xlsx' })
    const unmount = renderTabBar({}, '/chat')

    expect(fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })).toBe(true)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(xlsx)
    unmount()

    // 换一个非 chat 路由再验一次
    renderTabBar({}, '/notes')
    expect(fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(xlsx)
  })

  it('Ctrl+W（D14）：/office 关当前文档标签；非 /office 只拦默认、绝不误关标签', async () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    useOfficeTabsStore.getState().open({ kind: 'xlsx', path: 'c.xlsx' })
    const before = useOfficeTabsStore.getState().activeTabId
    const unmountChat = renderTabBar({}, '/chat')

    // 非 Office：仍然拦住 Electron 默认关窗（preventDefault），但标签一个不关
    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(false)
    expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.path)).toEqual([
      'a.docx',
      'b.pptx',
      'c.xlsx'
    ])
    expect(useOfficeTabsStore.getState().activeTabId).toBe(before)
    // 没按 Ctrl：不是我们的快捷键，不拦；Ctrl+Shift+W 也不归我们管
    expect(fireEvent.keyDown(window, { key: 'w' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'W', ctrlKey: true, shiftKey: true })).toBe(true)
    unmountChat()

    // /office：关掉当前（第三个）标签
    renderTabBar({}, '/office')
    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(false)
    await waitFor(() =>
      expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.path)).toEqual([
        'a.docx',
        'b.pptx'
      ])
    )
    expect(useOfficeTabsStore.getState().activeTabId).toBe(
      useOfficeTabsStore.getState().tabs[1]?.id
    )
    expect(screen.getByTestId('app-tab-chat')).toBeInTheDocument()
  })

  it('Ctrl+S：只在 /office 且有标签时把 active 标签交给保存服务；非 /office 不抢键', async () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    const onSave = vi.fn(async () => false)
    const unmountChat = renderTabBar({ onSave }, '/chat')

    expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
    unmountChat()

    renderTabBar({ onSave }, '/office')
    expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ kind: 'docx', path: 'a.docx' }))

    // 打开文件弹窗开着时：只吞键，不触发保存
    act(() => useOfficeUiStore.getState().openPicker())
    expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('面内快捷键（surface:shortcut 转到 handleOfficeShortcut）与壳侧走同一条分发', async () => {
    const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    const onSave = vi.fn(async () => true)
    renderTabBar({ onSave }, '/office')

    expect(handleOfficeShortcut('save')).toBe(true)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: docx }))

    // 面内 Ctrl+W 也走 requestClose：脏标签仍弹三态，不直接吞掉
    useOfficeTabsStore.getState().markDirty(docx)
    expect(handleOfficeShortcut('close')).toBe(true)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
  })

  it('注入 onClose：干净关闭走同一编排（测试里由注入实现负责 store 收尾，等价 closeOfficeTab）', async () => {
    const onClose = vi.fn(async (tab: { id: string }) => {
      useOfficeTabsStore.getState().close(tab.id)
    })
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
    renderTabBar({ onClose })

    fireEvent.click(screen.getByRole('button', { name: '关闭 b.pptx' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(0))
  })

  it('没有文档标签时不拦截 Ctrl+W / Ctrl+Tab（不抢窗口的默认动作）', () => {
    renderTabBar()

    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('弹窗（打开文件示例）开着时快捷键 no-op，但 Ctrl+W 仍被拦下', () => {
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    renderTabBar()

    act(() => useOfficeUiStore.getState().openPicker())

    expect(fireEvent.keyDown(window, { key: 'w', ctrlKey: true })).toBe(false)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
  })

  it('「＋」：跳 /office 并打开「打开文件（示例）」弹窗（office-ui-store 标志）', () => {
    renderTabBar()

    fireEvent.click(screen.getByTestId('app-tab-add'))

    expect(screen.getByTestId('location')).toHaveTextContent('/office')
    expect(useOfficeUiStore.getState().pickerOpen).toBe(true)
  })

  it('活动标签变化 / 窗口 resize 后 scrollIntoView；滚轮横向滚（拦默认）', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    try {
      const docx = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
      useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'b.pptx' })
      renderTabBar({}, '/office')

      // 初次挂载就把当前（第二个）标签带进视野
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

      scrollIntoView.mockClear()
      fireEvent.click(screen.getByRole('tab', { name: /a\.docx/ }))
      expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })

      // resize 之后活动标签可能被挤出可视区：再滚一次
      scrollIntoView.mockClear()
      fireEvent(window, new Event('resize'))
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }

    const scroll = screen.getByTestId('app-tabbar-scroll')
    // jsdom 没有布局：给元素装一个可写 scrollLeft，验证原生 wheel 监听真的横向挪了它
    Object.defineProperty(scroll, 'scrollLeft', { configurable: true, writable: true, value: 0 })
    expect(fireEvent.wheel(scroll, { deltaY: 120 })).toBe(false)
    expect(scroll.scrollLeft).toBe(120)
  })
})
