import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import { resetWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import {
  closeableTopTabId,
  isFocusInWorkPanel,
  isSamePreviewPath,
  isWorkbenchVisible,
  normalizeTabPath,
  resolveCtrlW,
  type TabShortcutSnapshot
} from '../tab-model'
import { dispatchTabShortcut, type TabShortcutHandlers } from '../use-tab-shortcuts'

/**
 * T1（2026-10-18）：标签生态互通的行为契约 —— 纯判定 + 键盘分发。
 * 上下文口径见 .superpowers/handover/tabs-ecosystem-report.md。
 */

function snapshot(over: Partial<TabShortcutSnapshot> = {}): TabShortcutSnapshot {
  return {
    pathname: '/chat',
    workPanelOpen: true,
    focusInWorkPanel: false,
    workbenchTabCount: 0,
    blankTabOpen: false,
    blankTabActive: false,
    topTabCount: 0,
    ...over
  }
}

function handlers(over: Partial<TabShortcutHandlers> = {}): TabShortcutHandlers {
  return {
    closeTopTab: vi.fn(),
    closeBlankTab: vi.fn(),
    cycleTopTabs: vi.fn(),
    openTopNewTab: vi.fn(),
    saveTopTab: vi.fn(),
    isDialogOpen: () => false,
    ...over
  }
}

describe('isWorkbenchVisible：右栏只在 /chat + 面板打开时可见', () => {
  it('面板打开 + /chat = 可见；离开 /chat 或面板收起 = 不可见', () => {
    expect(isWorkbenchVisible('/chat', true)).toBe(true)
    expect(isWorkbenchVisible('/chat/whatever', true)).toBe(true)
    expect(isWorkbenchVisible('/chat', false)).toBe(false)
    expect(isWorkbenchVisible('/office', true)).toBe(false)
    expect(isWorkbenchVisible('/notes', true)).toBe(false)
    expect(isWorkbenchVisible('/settings/model', true)).toBe(false)
  })
})

describe('isFocusInWorkPanel：焦点必须落在右栏面板 DOM 内', () => {
  it('面板内按钮 = true；面板外 / null = false', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-testid', 'work-panel')
    const inside = document.createElement('button')
    const outside = document.createElement('button')
    panel.appendChild(inside)
    document.body.appendChild(panel)
    document.body.appendChild(outside)
    try {
      expect(isFocusInWorkPanel(inside)).toBe(true)
      expect(isFocusInWorkPanel(panel)).toBe(true)
      expect(isFocusInWorkPanel(outside)).toBe(false)
      expect(isFocusInWorkPanel(null)).toBe(false)
      expect(isFocusInWorkPanel(inside, document)).toBe(true)
      // 没有 work-panel 容器时一律 false（不会把 body 焦点误判成右栏）
      expect(isFocusInWorkPanel(inside, document.createElement('div'))).toBe(false)
    } finally {
      panel.remove()
      outside.remove()
    }
  })
})

describe('resolveCtrlW：Ctrl+W 的上下文归属矩阵', () => {
  it('右栏可见 + 焦点在右栏 + 有标签 → workbench（优先于顶栏文档）', () => {
    expect(
      resolveCtrlW(snapshot({ focusInWorkPanel: true, workbenchTabCount: 1, topTabCount: 2 }))
    ).toBe('workbench')
  })

  it('右栏不可见 / 焦点不在右栏 → 回落到顶栏；空白在前台优先于文档', () => {
    // 焦点在右栏但面板收起（离开 /chat 后的残留焦点）：不归右栏
    expect(
      resolveCtrlW(
        snapshot({
          workPanelOpen: false,
          focusInWorkPanel: true,
          workbenchTabCount: 1,
          topTabCount: 1
        })
      )
    ).toBe('doc')
    // 面板可见但焦点不在右栏
    expect(
      resolveCtrlW(snapshot({ focusInWorkPanel: false, workbenchTabCount: 1, topTabCount: 1 }))
    ).toBe('doc')
    // 空白伪标签在前台 → 先关空白（单例、无脏确认）
    expect(
      resolveCtrlW(snapshot({ blankTabOpen: true, blankTabActive: true, topTabCount: 1 }))
    ).toBe('blank')
    // 空白在后台（有文档在前台）→ 关文档
    expect(
      resolveCtrlW(snapshot({ blankTabOpen: true, blankTabActive: false, topTabCount: 1 }))
    ).toBe('doc')
  })

  it('都没有 → none（仍要吞键防关窗；主对话不在可关集合里）', () => {
    expect(resolveCtrlW(snapshot())).toBe('none')
    expect(resolveCtrlW(snapshot({ blankTabOpen: true, blankTabActive: false }))).toBe('none')
    expect(
      resolveCtrlW(snapshot({ focusInWorkPanel: true, workbenchTabCount: 0, topTabCount: 0 }))
    ).toBe('none')
  })
})

describe('closeableTopTabId：顶栏可关文档 id 的兜底', () => {
  it('activeTabId 优先；空串兜底第一条；都没有返回 null', () => {
    expect(closeableTopTabId('b', [{ id: 'a' }, { id: 'b' }])).toBe('b')
    expect(closeableTopTabId('', [{ id: 'a' }, { id: 'b' }])).toBe('a')
    expect(closeableTopTabId('', [])).toBeNull()
  })
})

describe('路径归一 / 同一文件判定（右栏预览 ↔ 顶栏文档去重）', () => {
  it('正反斜杠与大小写都归一；同文件 true、不同文件 false', () => {
    expect(normalizeTabPath('Docs\\方案.DOCX')).toBe('docs/方案.docx')
    expect(isSamePreviewPath('docs\\方案.docx', 'Docs/方案.DOCX')).toBe(true)
    expect(isSamePreviewPath('./docs/方案.docx', 'docs/方案.docx')).toBe(true)
    expect(isSamePreviewPath('docs/另一份.docx', 'docs/方案.docx')).toBe(false)
    expect(isSamePreviewPath(undefined, 'docs/方案.docx')).toBe(false)
    expect(isSamePreviewPath('', 'docs/方案.docx')).toBe(false)
  })
})

describe('dispatchTabShortcut：按键 → 上下文分发的纯函数层', () => {
  beforeEach(() => {
    resetOfficeTabsStore()
    resetWorkbenchStore()
  })

  it('Ctrl+T：无条件交给顶栏新标签页（右栏不再占这个键）', () => {
    const h = handlers()
    const result = dispatchTabShortcut(
      { key: 't', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
      '/notes',
      h,
      snapshot({ pathname: '/notes' })
    )
    expect(result.consumed).toBe(true)
    expect(h.openTopNewTab).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Tab：没有顶栏文档时不抢键；有文档才吞键并循环', () => {
    const h = handlers()
    const ctx = { key: 'Tab', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(dispatchTabShortcut(ctx, '/chat', h, snapshot())).toEqual({ consumed: false })
    expect(h.cycleTopTabs).not.toHaveBeenCalled()

    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    expect(dispatchTabShortcut(ctx, '/chat', h, snapshot({ topTabCount: 1 }))).toEqual({
      consumed: true
    })
    expect(h.cycleTopTabs).toHaveBeenCalledWith(1)
    expect(
      dispatchTabShortcut({ ...ctx, shiftKey: true }, '/chat', h, snapshot({ topTabCount: 1 }))
    ).toEqual({ consumed: true })
    expect(h.cycleTopTabs).toHaveBeenLastCalledWith(-1)
  })

  it('Ctrl+W：一切上下文都吞键（防 Electron 关窗）；none 不做动作', () => {
    const h = handlers()
    const ctx = { key: 'w', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(dispatchTabShortcut(ctx, '/office', h, snapshot({ pathname: '/office' }))).toEqual({
      consumed: true
    })
    expect(h.closeTopTab).not.toHaveBeenCalled()
    expect(h.closeBlankTab).not.toHaveBeenCalled()

    // 已有文档：关 active
    useOfficeTabsStore.getState().open({ kind: 'docx', path: 'a.docx' })
    const doc = useOfficeTabsStore.getState().tabs[0]?.id
    dispatchTabShortcut(ctx, '/office', h, snapshot({ pathname: '/office', topTabCount: 1 }))
    expect(h.closeTopTab).toHaveBeenCalledWith(doc)
  })

  it('模态框开着：Ctrl+W 只吞键不关任何东西', () => {
    const h = handlers({ isDialogOpen: () => true })
    const ctx = { key: 'w', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(
      dispatchTabShortcut(ctx, '/office', h, snapshot({ pathname: '/office', topTabCount: 2 }))
    ).toEqual({ consumed: true })
    expect(h.closeTopTab).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+W / Ctrl+Alt+W 不归我们管（不吞）', () => {
    const h = handlers()
    const base = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(
      dispatchTabShortcut({ ...base, key: 'w', shiftKey: true }, '/office', h, snapshot())
    ).toEqual({ consumed: false })
    expect(
      dispatchTabShortcut({ ...base, key: 'w', altKey: true }, '/office', h, snapshot())
    ).toEqual({ consumed: false })
  })
})
