/**
 * 顶栏/右栏标签的**统一快捷键入口**（T1，2026-10-18）。
 *
 * 行为矩阵（Lead 拍板）：
 *   - Ctrl+W：右栏可见且焦点在右栏 → 关右栏当前标签；否则空白伪标签在前台 → 关空白；
 *             否则顶栏有文档 → 关当前文档；都没有 → **吞键不做事**（绝不漏给 Electron 关窗）。
 *             主对话是固定标签，永远不在可关集合里。
 *   - Ctrl+Tab / Ctrl+Shift+Tab：只在顶栏文档标签内循环（全局）；右栏不抢键。
 *   - Ctrl+T：统一开顶栏「新标签页」（空白伪标签）；右栏浏览器不再占这个键。
 *   - Ctrl+S：仍是"保存当前文档标签"，只在 /office 且有文档标签时生效（沿用旧口径）。
 *
 * 只做"按键 → 上下文判定 → 调注入的动作"，不持有标签状态；两个 store 与 Office 的
 * 关闭/保存/退出编排都保持原样（动作由 AppTabBar 注入）。
 */
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { useOfficeTabsStore } from '@renderer/features/office/office-tabs-store'
import { useNewTabStore } from '@renderer/features/newtab/new-tab-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { useWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import {
  closeableTopTabId,
  isFocusInWorkPanel,
  resolveCtrlW,
  type TabShortcutSnapshot
} from './tab-model'

export interface TabShortcutHandlers {
  /** 关顶栏某个文档标签（脏态三态/Office release 由 AppTabBar 既有编排负责） */
  closeTopTab: (id: string) => void
  /** 关顶栏空白伪标签（单例、无脏确认） */
  closeBlankTab: () => void
  /** 顶栏文档标签循环（+1 下一个 / -1 上一个），会顺带让空白退出前台 */
  cycleTopTabs: (step: 1 | -1) => void
  /** 开顶栏「新标签页」（单例：已开只激活） */
  openTopNewTab: () => void
  /** 保存当前文档标签 */
  saveTopTab: () => void
  /** 是否有模态框开着（脏三态 / 打开文件 / 退出确认）：开着时快捷键只吞键不做事 */
  isDialogOpen: () => boolean
}

/** 一次快捷键处理的结果：consumed = 调用方要 preventDefault */
export interface TabShortcutResult {
  consumed: boolean
}

/**
 * 纯分发（不挂监听，单测可直接调用）：按当前上下文返回 consumed 并执行动作。
 * 真实监听在 `useTabShortcuts` 里注册到 window。
 */
export function dispatchTabShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  pathname: string,
  handlers: TabShortcutHandlers,
  snapshot: TabShortcutSnapshot
): TabShortcutResult {
  const hasCommand = event.ctrlKey || event.metaKey
  if (!hasCommand || event.altKey) return { consumed: false }

  const key = event.key
  const topTabs = useOfficeTabsStore.getState()

  // Ctrl+T：统一开顶栏新标签页（右栏浏览器已让出这个键）
  if ((key === 't' || key === 'T') && !event.shiftKey) {
    handlers.openTopNewTab()
    return { consumed: true }
  }

  // Ctrl+Tab / Ctrl+Shift+Tab：只在顶栏文档标签内循环（全局）；没有文档不抢键
  if (key === 'Tab') {
    if (topTabs.tabs.length === 0) return { consumed: false }
    if (handlers.isDialogOpen()) return { consumed: true }
    handlers.cycleTopTabs(event.shiftKey ? -1 : 1)
    return { consumed: true }
  }

  // Ctrl+S：保存当前文档标签（沿用旧口径：只在 /office 且有文档标签时生效）
  if ((key === 's' || key === 'S') && !event.shiftKey) {
    if (!pathname.startsWith('/office') || topTabs.tabs.length === 0) return { consumed: false }
    if (handlers.isDialogOpen()) return { consumed: true }
    handlers.saveTopTab()
    return { consumed: true }
  }

  // Ctrl+W：上下文归属（调用方必须吞键，防止 Electron 把窗口关掉）
  if ((key === 'w' || key === 'W') && !event.shiftKey) {
    if (handlers.isDialogOpen()) return { consumed: true }
    const target = resolveCtrlW(snapshot)
    if (target === 'workbench') {
      const workbench = useWorkbenchStore.getState()
      const id = workbench.activeTabId === '' ? workbench.tabs[0]?.id : workbench.activeTabId
      if (id !== undefined) workbench.closeTab(id)
      return { consumed: true }
    }
    if (target === 'blank') {
      handlers.closeBlankTab()
      return { consumed: true }
    }
    if (target === 'doc') {
      const id = closeableTopTabId(topTabs.activeTabId, topTabs.tabs)
      if (id !== null) handlers.closeTopTab(id)
      return { consumed: true }
    }
    // none：没有可关的（典型：只剩固定「主对话」）—— 仍然吞键，不关窗
    return { consumed: true }
  }

  return { consumed: false }
}

/**
 * 注册 window 级快捷键（壳常驻，所以任何路由都收得到）。
 * handlers 只在事件发生那一刻取最新值（存 ref，不在 render 期读写 ref）。
 */
export function useTabShortcuts(handlers: TabShortcutHandlers): void {
  const pathname = useLocation().pathname
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const office = useOfficeTabsStore.getState()
      const blank = useNewTabStore.getState()
      const shell = useShellStore.getState()
      const workbench = useWorkbenchStore.getState()
      const snapshot: TabShortcutSnapshot = {
        pathname,
        workPanelOpen: shell.workPanelOpen,
        focusInWorkPanel: isFocusInWorkPanel(document.activeElement),
        workbenchTabCount: workbench.tabs.length,
        blankTabOpen: blank.isOpen,
        blankTabActive: blank.isActive,
        topTabCount: office.tabs.length
      }
      // 别的入口先认领的按键不抢（defaultPrevented）
      if (event.defaultPrevented) return
      const result = dispatchTabShortcut(event, pathname, handlersRef.current, snapshot)
      if (result.consumed) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pathname])
}
