import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { resetNotesStore, useNotesStore } from '@renderer/features/notes/notes-store'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore,
  type OfficeTab
} from '@renderer/features/office/office-tabs-store'
import { resetOfficeActionsForTest } from '@renderer/features/office/office-actions'
import { NewTabPage } from '../NewTabPage'
import { resetNewTabStore, useNewTabStore } from '../new-tab-store'

/**
 * task-80：新增标签页（「一张今天的纸」）v1 行为：
 *   结构/文案（开始+继续、v1 隐藏 xlsx/pptx/web）、键盘 1/2/3 与 Esc、容量禁用、
 *   CTA 新建空白 Word（create-blank）、打开 Word（open-dialog：取消/失败/成功）、
 *   写笔记（init→create：成功导航/失败留页）、继续项（激活+消费空白/竞态）。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

let bridge: KyclawBridgeStubs

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/office']}>
      <NewTabPage />
      <LocationProbe />
    </MemoryRouter>
  )
}

/** 开空白页（NewTabPage 在前台的前提） */
function openBlank(): void {
  act(() => useNewTabStore.getState().open())
}

function tab(id: string, title: string, lastActiveAt: number, dirty = false): OfficeTab {
  return {
    id,
    kind: 'docx' as const,
    title,
    path: `D:\\${title}`,
    dirty,
    readOnly: false,
    lastActiveAt
  }
}

beforeEach(() => {
  bridge = installKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeActionsForTest()
  resetNotesStore()
  resetNewTabStore()
  openBlank()
})

afterEach(() => {
  clearKyclawBridge()
  resetNewTabStore()
  resetOfficeTabsStore()
  resetNotesStore()
})

describe('NewTabPage · 结构与文案（v1 能力边界）', () => {
  it('报头：字标 + 新标签页 + 真实日期 + 两条栏目「开始」「继续」；页脚 Esc 提示', () => {
    renderPage()

    const page = screen.getByTestId('newtab-page')
    expect(page).toHaveAttribute('aria-label', '新标签页')
    expect(page).toHaveTextContent('kyclaw')
    expect(screen.getByTestId('npw-date')).toHaveAttribute(
      'datetime',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    )
    expect(screen.getByTestId('npw-date')).toHaveTextContent(/\d{4} 年 \d{1,2} 月 \d{1,2} 日 · 周/)
    expect(screen.getByRole('heading', { name: '开始' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByText('关闭新标签页')).toBeInTheDocument()
  })

  it('六格：3 个亮格真可用 + 3 个灰格 v2 未来位（不可点、不进 Tab）', () => {
    renderPage()

    const cta = screen.getByTestId('npw-create-docx')
    expect(cta).toHaveTextContent('新建 Word 文档')
    expect(cta).toHaveAccessibleDescription(/空白 \.docx/)
    expect(cta).toHaveAttribute('data-npw-item')
    expect(screen.getByTestId('npw-note')).toHaveTextContent('写笔记')
    expect(screen.getByTestId('npw-open-docx')).toHaveTextContent('打开 Word 文档…')

    // 灰格：明确标 v2、aria-disabled、div 不可点/不可聚焦（不是假按钮）
    const start = screen.getByTestId('npw-start')
    for (const id of ['xlsx', 'pptx', 'web'] as const) {
      const cell = screen.getByTestId(`npw-future-${id}`)
      expect(cell.tagName).toBe('DIV')
      expect(cell).toHaveAttribute('aria-disabled', 'true')
      expect(cell).toHaveAttribute('title', 'v2 未接入')
      expect(cell).toHaveTextContent('v2')
      expect(cell).not.toHaveAttribute('data-npw-item')
      expect(cell).not.toHaveAttribute('tabindex')
    }
    expect(start).toHaveTextContent('新建表格')
    expect(start).toHaveTextContent('新建演示文稿')
    expect(start).toHaveTextContent('打开网页')
  })

  it('灰格可一键收起：按钮切换 data-future；收起后 CSS 隐藏三格并露出 v2 说明', () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')
    const toggle = screen.getByTestId('npw-future-toggle')
    expect(page).toHaveAttribute('data-future', 'on')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(toggle)
    expect(page).toHaveAttribute('data-future', 'off')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('显示未来位')
    // DOM 仍在（CSS 隐藏，便于窄窗/可访问性语义一致）
    expect(screen.getByTestId('npw-future-xlsx')).toBeInTheDocument()
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/features/newtab/newtab.css'),
      'utf8'
    )
    expect(css).toContain("[data-future='off'] .lt-cell--future")
    expect(css).toMatch(/\.lt-cell--future \{[^}]*border-style: dashed/)
  })

  it('继续为空：一句陈述 + 一行邀请，不画假条目', () => {
    renderPage()

    const empty = screen.getByTestId('npw-recent-empty')
    expect(empty).toHaveTextContent('还没有打开的文档')
    expect(empty).toHaveTextContent('新建或打开一份，它会占一格。')
    expect(screen.queryAllByTestId(/^npw-recent-(?!empty)/)).toHaveLength(0)
  })

  it('继续：真实标签按 lastActiveAt 倒序、最多 5 条；未保存点 + 相对时间', () => {
    const now = Date.now()
    act(() => {
      useOfficeTabsStore.setState({
        tabs: [
          tab('a', '旧文档.docx', now - 3 * 24 * 60 * 60_000),
          tab('b', '刚写的.docx', now - 60_000, true),
          tab('c', '昨天.docx', now - 26 * 60 * 60_000),
          tab('d', '四.docx', now - 4 * 24 * 60 * 60_000),
          tab('e', '五.docx', now - 5 * 24 * 60 * 60_000),
          tab('f', '六.docx', now - 6 * 24 * 60 * 60_000)
        ],
        activeTabId: 'b'
      })
    })
    renderPage()

    const rows = screen.getAllByTestId(/^npw-recent-(?!empty)/)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveTextContent('刚写的.docx')
    expect(rows[0]).toHaveTextContent('1 分钟前')
    expect(rows[1]).toHaveTextContent('昨天.docx')
    // 第 6 条（最旧）不出现
    expect(screen.queryByTestId('npw-recent-f')).not.toBeInTheDocument()
    // 未保存点：aria-label 带「未保存」，视觉点 aria-hidden
    expect(rows[0]).toHaveAttribute('aria-label', expect.stringContaining('未保存'))
  })

  it('容量满（5 标签）：提示 + 只禁会新增文档的动作；写笔记与继续仍可用', () => {
    const now = Date.now()
    act(() => {
      useOfficeTabsStore.setState({
        tabs: ['a', 'b', 'c', 'd', 'e'].map((id, index) => tab(id, `${id}.docx`, now - index)),
        activeTabId: 'a'
      })
    })
    renderPage()

    expect(screen.getByTestId('npw-capacity')).toHaveTextContent('最多同时打开 5 个标签')
    expect(screen.getByTestId('npw-create-docx')).toBeDisabled()
    expect(screen.getByTestId('npw-open-docx')).toBeDisabled()
    expect(screen.getByTestId('npw-note')).toBeEnabled()
    expect(screen.getAllByTestId(/^npw-recent-(?!empty)/)).toHaveLength(5)
  })
})

describe('NewTabPage · 主 CTA：新建空白 Word（create-blank）', () => {
  it('成功：调 create-blank → 标签落地且 dirty → 空白消费 → /office', async () => {
    bridge.office.createBlank.mockResolvedValue({
      ok: true,
      alreadyOpen: false,
      document: officeDocumentFixture({ documentId: 'blank-1', displayName: '未命名文档' })
    })
    renderPage()

    fireEvent.click(screen.getByTestId('npw-create-docx'))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/office'))
    expect(bridge.office.createBlank).toHaveBeenCalledWith({ kind: 'docx' })
    const state = useOfficeTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ title: '未命名文档', dirty: true, documentId: 'blank-1' })
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('失败：主进程人话留在本页 CTA 下（role=alert），空白不关、不建标签', async () => {
    bridge.office.createBlank.mockResolvedValue({
      ok: false,
      code: 'write-failed',
      message: '保存失败，修改仍然留在编辑器里'
    })
    renderPage()

    fireEvent.click(screen.getByTestId('npw-create-docx'))

    const alert = await screen.findByTestId('npw-error')
    expect(alert).toHaveTextContent('保存失败')
    expect(useNewTabStore.getState().isOpen).toBe(true)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })
})

describe('NewTabPage · 打开 Word 文档…（open-dialog）', () => {
  it('取消：静默回本页（不报错、空白不关）', async () => {
    renderPage()

    fireEvent.click(screen.getByTestId('npw-open-docx'))

    await waitFor(() => expect(bridge.office.openDialog).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('npw-error')).not.toBeInTheDocument()
    expect(useNewTabStore.getState().isOpen).toBe(true)
  })

  it('成功：打开真实文档 → 标签激活 + 空白消费 + /office', async () => {
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      alreadyOpen: false,
      document: officeDocumentFixture({ documentId: 'doc-open' })
    })
    renderPage()

    fireEvent.click(screen.getByTestId('npw-open-docx'))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/office'))
    expect(useOfficeTabsStore.getState().tabs[0]?.documentId).toBe('doc-open')
    expect(useNewTabStore.getState().isOpen).toBe(false)
  })

  it('失败：显示主进程人话；容量拒绝时不装标签', async () => {
    bridge.office.openDialog.mockResolvedValue({
      ok: false,
      code: 'unreadable',
      message: '读不了这个文件：它可能已损坏、无权限，或不是普通文件'
    })
    renderPage()

    fireEvent.click(screen.getByTestId('npw-open-docx'))

    const alert = await screen.findByTestId('npw-error')
    expect(alert).toHaveTextContent('读不了这个文件')
    expect(useNewTabStore.getState().isOpen).toBe(true)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })
})

describe('NewTabPage · 写笔记（notes init→create）', () => {
  it('成功：init（幂等）→ create → 关空白 → /notes，新笔记被选中', async () => {
    renderPage()

    fireEvent.click(screen.getByTestId('npw-note'))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/notes'))
    expect(bridge.notes.create).toHaveBeenCalledTimes(1)
    const notes = useNotesStore.getState()
    expect(notes.selectedId).not.toBeNull()
    // task-89：新建后请求把焦点放进标题（由 NoteEditor 消费；这里钉请求已发出）
    expect(notes.titleFocusSeq).toBeGreaterThan(0)
    expect(useNewTabStore.getState().isOpen).toBe(false)
  })

  it('失败：留在本页给行下错误行，不导航、不关标签', async () => {
    bridge.notes.create.mockRejectedValueOnce(new Error('笔记目录不可写'))
    renderPage()

    fireEvent.click(screen.getByTestId('npw-note'))

    const alert = await screen.findByTestId('npw-error')
    expect(alert).toHaveTextContent('笔记目录不可写')
    expect(screen.getByTestId('location')).toHaveTextContent('/office')
    expect(useNewTabStore.getState().isOpen).toBe(true)
  })
})

describe('NewTabPage · 继续项与键盘', () => {
  it('点继续项：激活已有标签 + 消费空白 + /office，不新建', () => {
    act(() => {
      useOfficeTabsStore.setState({
        tabs: [tab('doc-a', '甲.docx', Date.now() - 60_000)],
        activeTabId: 'doc-a'
      })
    })
    renderPage()

    fireEvent.click(screen.getByTestId('npw-recent-doc-a'))

    expect(useOfficeTabsStore.getState().activeTabId).toBe('doc-a')
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(useNewTabStore.getState().isOpen).toBe(false)
    expect(screen.getByTestId('location')).toHaveTextContent('/office')
  })

  it('数字键直达 + Esc 关闭空白', async () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')

    fireEvent.keyDown(page, { key: '2' })
    await waitFor(() => expect(bridge.notes.create).toHaveBeenCalledTimes(1))
    // 写笔记成功会消费空白并导航：重新开一次空白再验 Esc
    act(() => useNewTabStore.getState().open())
    expect(useNewTabStore.getState().isOpen).toBe(true)
    fireEvent.keyDown(page, { key: 'Escape' })
    expect(useNewTabStore.getState()).toMatchObject({ isOpen: false, isActive: false })
  })

  it('↑↓/Home/End 在当前组内循环焦点', () => {
    renderPage()

    const cta = screen.getByTestId('npw-create-docx')
    act(() => cta.focus())
    fireEvent.keyDown(cta, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('npw-note'))

    fireEvent.keyDown(screen.getByTestId('npw-note'), { key: 'End' })
    expect(document.activeElement).toBe(screen.getByTestId('npw-open-docx'))

    fireEvent.keyDown(screen.getByTestId('npw-open-docx'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cta)

    fireEvent.keyDown(cta, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByTestId('npw-open-docx'))
  })

  it('数字键在 input/textarea 里不抢（未来行内输入的规则先立住）', () => {
    renderPage()
    const input = document.createElement('input')
    screen.getByTestId('newtab-page').appendChild(input)
    fireEvent.keyDown(input, { key: '1' })
    expect(bridge.office.createBlank).not.toHaveBeenCalled()
  })
})

/**
 * task-80 · 行为边界补充（2026-10-18 用户口径：视觉要重做，行为测试先钉稳）：
 * 容量 dirty 档、关闭后的焦点归还、pending 期间不重复触发。
 */
describe('NewTabPage · 行为边界（容量 / 焦点 / pending）', () => {
  it('未保存文档满 3：容量提示走 max-dirty 文案；CTA 与打开禁用、写笔记仍可用', () => {
    const now = Date.now()
    act(() => {
      useOfficeTabsStore.setState({
        tabs: ['d1', 'd2', 'd3'].map((id, index) => tab(id, `${id}.docx`, now - index, true)),
        activeTabId: 'd1'
      })
    })
    renderPage()

    expect(screen.getByTestId('npw-capacity')).toHaveTextContent('最多同时保留 3 个未保存的文档')
    expect(screen.getByTestId('npw-create-docx')).toBeDisabled()
    expect(screen.getByTestId('npw-open-docx')).toBeDisabled()
    expect(screen.getByTestId('npw-note')).toBeEnabled()
  })

  it('Esc 关闭后焦点回到「主对话」标签（不丢到 body）', async () => {
    const chatTab = document.createElement('button')
    chatTab.id = 'app-tab-chat'
    chatTab.setAttribute('data-testid', 'fake-chat-tab')
    document.body.appendChild(chatTab)
    try {
      renderPage()
      fireEvent.keyDown(screen.getByTestId('newtab-page'), { key: 'Escape' })
      expect(useNewTabStore.getState().isOpen).toBe(false)
      await waitFor(() => expect(document.activeElement).toBe(chatTab))
    } finally {
      chatTab.remove()
    }
  })

  it('pending 期间：其余「会新增文档」的动作禁用（键盘 1 不会重复触发）', async () => {
    bridge.office.createBlank.mockReturnValue(new Promise(() => undefined))
    renderPage()

    fireEvent.keyDown(screen.getByTestId('newtab-page'), { key: '1' })
    await waitFor(() => expect(screen.getByTestId('npw-note')).toBeDisabled())
    expect(screen.getByTestId('npw-open-docx')).toBeDisabled()
    expect(bridge.office.createBlank).toHaveBeenCalledTimes(1)

    // 再按 1：busy 下直接 no-op，不会再发一次 IPC
    fireEvent.keyDown(screen.getByTestId('newtab-page'), { key: '1' })
    expect(bridge.office.createBlank).toHaveBeenCalledTimes(1)
  })
})
