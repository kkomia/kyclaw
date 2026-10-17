import { FilePlus2, MessageSquare, Plus, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { useNewTabStore } from '@renderer/features/newtab/new-tab-store'
import {
  closeOfficeTab,
  registerOfficeShortcutHandler,
  saveOfficeTab,
  type OfficeShortcutAction
} from '@renderer/features/office/office-actions'
import {
  isOfficeQuitInFlight,
  useOfficeQuitStore
} from '@renderer/features/office/office-quit-flow'
import {
  OFFICE_KIND_ICON,
  OFFICE_KIND_LABEL,
  officePanelIdOf
} from '@renderer/features/office/office-kinds'
import {
  useOfficeTabsStore,
  type DirtyCloseAction,
  type OfficeTab
} from '@renderer/features/office/office-tabs-store'
import { useOfficeUiStore } from '@renderer/features/office/office-ui-store'

export interface AppTabBarProps {
  /**
   * 保存动作（测试注入用）：返回 true 才关标签。不传 = 走 `office-actions.saveOfficeTab`
   * （与 OfficePage 保存按钮 / Ctrl+S / 面内转发同一条路）。
   */
  onSave?: (tab: OfficeTab) => boolean | Promise<boolean>
  /**
   * 关闭动作（测试注入用）：默认 `closeOfficeTab`（面 `doc:close` → `office:release` → store close）。
   * 注入它只影响"关标签"的编排，脏确认三态仍在这里。
   */
  onClose?: (tab: OfficeTab) => void | Promise<void>
}

/**
 * 顶栏里的浏览器式标签栏：参考 HappyFriday 的 TabBar.vue，用现有 React + Tailwind + 设计 token
 * 重写，不引新依赖。
 *
 * 形态（用户口径 2026-10-17）：最左是**固定的「主对话」标签**（图标 + 文案，不可关闭、永不进
 * 「可关闭标签」体系），其右侧是 Office 文档标签（图标 + 标题 + hover/激活才可见的关闭钮；激活
 * 标签白底圆角 pill、未激活纯文字；宽 100~150；溢出横向滚动、隐藏原生滚动条、滚轮横向滚；
 * 活动标签变化 / 窗口 resize 后 scrollIntoView；标签间 1px 分隔线、active 两侧隐藏），末尾「＋」
 * = 去 /office 并打开「打开文件」弹窗（标志放 office-ui-store）。
 *
 * v2 路由口径（用户看完布局后拍板）：
 *   - 文档标签的激活态**只在 /office 生效**（其他路由不高亮，activeTabId 保留，切回 Office 继续亮）；
 *   - Ctrl+Tab / Ctrl+Shift+Tab **只在 /office 且文档标签 >0** 时响应，其他路由不抢键；
 *   - Ctrl+W（D14，M3-S4 口径变更）：**只在 /office** 关当前文档标签；其他路由若开着文档标签
 *     仍然 `preventDefault()` 压住 Electron 的默认关窗，但 **no-op**（不误关 Office 标签）；
 *   - Ctrl+S（M3-S4）：只在 /office 且文档标签 >0 时把 active 标签交给 `saveOfficeTab`
 *     （与 OfficePage 保存按钮、面内 `surface:shortcut` 同一实现）；
 *   - 确认弹窗 / 打开文件弹窗开着时快捷键只吞键、no-op。
 *
 * M3-S4：关闭先走 `closeOfficeTab`（面 `doc:close` → `office:release` → store close）；脏标签
 * 三态（保存/放弃/取消）在本文的 Dialog 里，**保存失败或没有运行时都会停在弹窗**，不吞标签。
 * 面内快捷键（焦点在 iframe 编辑器里）由 `surface:shortcut` 转到 OfficePage，再经
 * `registerOfficeShortcutHandler` 回到本文件的同一个 `runShortcut` —— 两条入口一套判断。
 *
 * 为什么标签栏在 TitleBar 里常驻、键盘监听也挂在这里：Office 是独立于会话的多标签工作区，标签栏
 * 要跨路由可见；Ctrl+W 在 Electron 里等于窗口 Close 加速键，有文档标签时不能让默认动作漏下去
 * （审查 shell-audit P1）。
 */
export function AppTabBar({ onSave, onClose }: AppTabBarProps = {}): React.JSX.Element {
  const pathname = useLocation().pathname
  const inOffice = pathname.startsWith('/office')
  const inChat = pathname.startsWith('/chat')
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const activeTabId = useOfficeTabsStore((state) => state.activeTabId)
  const activate = useOfficeTabsStore((state) => state.activate)
  const newTabOpen = useNewTabStore((state) => state.isOpen)
  const newTabActive = useNewTabStore((state) => state.isActive)
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pendingTab = tabs.find((tab) => tab.id === pendingCloseId)
  // 标签若被别的路径关掉，pendingCloseId 可能残留；一律以"还找得到这个标签"为准
  const confirming = pendingTab !== undefined

  /**
   * task-80：关空白伪标签（X / 中键 / Ctrl+W / Esc）。无确认——它不是文档、没有 dirty。
   * 焦点还给新激活的文档标签；没有文档回「主对话」标签（不把焦点丢到 body）。
   */
  const closeBlankTab = useCallback((): void => {
    useNewTabStore.getState().close()
    const activeId = useOfficeTabsStore.getState().activeTabId
    queueMicrotask(() => {
      const fallback =
        activeId === ''
          ? document.getElementById('app-tab-chat')
          : document.getElementById(`office-tab-${activeId}`)
      fallback?.focus()
    })
  }, [])

  /** 保存服务：默认走 office-actions 的同一实现（与保存按钮/面内转发同一条），测试可注入 */
  const saveService = onSave ?? saveOfficeTab

  /** 真正的关标签编排：默认释放主进程注册表 + 卸载面内编辑器；测试可注入 onClose */
  const performClose = useCallback(
    (tab: OfficeTab): void => {
      if (onClose !== undefined) {
        void onClose(tab)
        return
      }
      void closeOfficeTab(tab)
    },
    [onClose]
  )

  const requestClose = useCallback(
    (id: string): void => {
      // 退出确认在飞：不再拉起标签级脏三态（否则两个对话框叠一起）
      if (isOfficeQuitInFlight()) return
      const tab = useOfficeTabsStore.getState().tabs.find((entry) => entry.id === id)
      if (tab === undefined) return
      if (tab.dirty) {
        setPendingCloseId(id)
        return
      }
      performClose(tab)
    },
    // setPendingCloseId 是 useState 的稳定 setter，写进依赖只为满足编译器对显式依赖的校验
    [performClose, setPendingCloseId]
  )

  /**
   * 反向互斥（M3-S5-2）：退出确认一开始（主进程请求写进 store）就把**已显示**的标签级脏三态收掉
   * —— 两个 modal 不叠加。用 store.subscribe 的回调（外部系统更新）而不是在 effect 体内直接
   * setState（react-hooks/set-state-in-effect）；请求清空（用户取消退出）不会重新拉起旧框。
   */
  useEffect(() => {
    return useOfficeQuitStore.subscribe((state) => {
      if (state.request !== null) setPendingCloseId(null)
    })
  }, [])

  /**
   * 快捷键唯一实现（壳侧按键 + 面内 surface:shortcut 共用）。
   * 返回 true = 消费这次按键（调用方 preventDefault）；false = 不归我们管、不抢默认。
   *
   * 注意 Ctrl+W 的 D14 口径：非 /office 且开着文档标签时返回 true（拦住窗口默认关闭）但 no-op。
   */
  const runShortcut = useCallback(
    (action: OfficeShortcutAction): boolean => {
      const state = useOfficeTabsStore.getState()
      const dialogsOpen =
        confirming || useOfficeUiStore.getState().pickerOpen || isOfficeQuitInFlight()

      if (action === 'save') {
        if (!inOffice || state.tabs.length === 0) return false
        if (dialogsOpen) return true
        const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
        if (activeTab !== undefined) void saveService(activeTab)
        return true
      }

      if (action === 'next-tab' || action === 'prev-tab') {
        if (!inOffice || state.tabs.length === 0) return false
        if (dialogsOpen) return true
        // task-80：文档循环（v1）不含空白伪标签；进入文档循环 = 空白退出前台（标签仍保留）
        useNewTabStore.getState().deactivate()
        const current = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
        const step = action === 'next-tab' ? 1 : -1
        const nextIndex =
          current === -1
            ? step === -1
              ? state.tabs.length - 1
              : 0
            : (current + step + state.tabs.length) % state.tabs.length
        const next = state.tabs[nextIndex]
        if (next !== undefined) state.activate(next.id)
        return true
      }

      // close（task-80）：空白伪标签可见且在前台 → 先关它（无脏确认、不碰文档）
      if (useNewTabStore.getState().isOpen && useNewTabStore.getState().isActive) {
        if (dialogsOpen) return true
        closeBlankTab()
        return true
      }
      if (state.tabs.length === 0) return false
      // D14：非 /office 仍然拦住默认关窗，但不关任何标签
      if (!inOffice) return true
      if (dialogsOpen) return true
      requestClose(state.activeTabId)
      return true
    },
    [closeBlankTab, confirming, inOffice, requestClose, saveService]
  )

  // 面内快捷键（焦点在 iframe 编辑器里）经 OfficePage → handleOfficeShortcut → 这里
  useEffect(() => registerOfficeShortcutHandler(runShortcut), [runShortcut])

  // 活动标签滚回视野；resize 之后也滚一次（审查 P1：溢出后窗口变窄，活动标签会被挤出可视区）。
  // 只认文档标签与空白伪标签（主对话是固定位、不参与滚动定位）。
  const scrollActiveIntoView = useCallback((): void => {
    const container = scrollRef.current
    if (container === null) return
    const active = container.querySelector<HTMLElement>(
      '[data-office-tab-id][aria-selected="true"], [data-newtab-tab][aria-selected="true"]'
    )
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [])

  useEffect(() => {
    scrollActiveIntoView()
  }, [activeTabId, inOffice, tabs.length, newTabOpen, newTabActive, scrollActiveIntoView])

  useEffect(() => {
    window.addEventListener('resize', scrollActiveIntoView)
    return () => window.removeEventListener('resize', scrollActiveIntoView)
  }, [scrollActiveIntoView])

  // 滚轮横向滚动：React 的 onWheel 在根节点上是 passive 的，拦不住默认行为，
  // 所以挂原生监听（{ passive: false }）自己挪 scrollLeft。
  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent): void => {
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
      if (delta === 0) return
      event.preventDefault()
      container.scrollLeft += delta
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  // 键盘快捷键（壳侧焦点）：只做"按键 → 动作"的映射，动作语义全在 runShortcut。
  // Ctrl+S/W/Tab 都走这里；面内转发的同一套动作也落到 runShortcut（见上）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      let action: OfficeShortcutAction | null = null
      if (event.key === 'Tab') action = event.shiftKey ? 'prev-tab' : 'next-tab'
      else if ((event.key === 'w' || event.key === 'W') && !event.shiftKey) action = 'close'
      else if (event.key === 's' || event.key === 'S') action = 'save'
      if (action === null) return
      if (runShortcut(action)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runShortcut])

  const selectTab = (id: string): void => {
    // task-80：任何文档激活路径都先让空白退出前台（标签留在条上，不自动关）
    useNewTabStore.getState().deactivate()
    activate(id)
    navigate('/office')
  }

  /** 点空白伪标签：激活它并回 /office（不关这里任何东西） */
  const selectNewTab = (): void => {
    useNewTabStore.getState().activate()
    navigate('/office')
  }

  /** 「＋」= 打开空白页（单例：已开只激活）；不再直接弹文件选择器（task-80） */
  const openNewTab = (): void => {
    useNewTabStore.getState().open()
    navigate('/office')
  }

  const resolveDirtyClose = (action: DirtyCloseAction): void => {
    if (pendingTab === undefined) return
    if (action === 'cancel') {
      setPendingCloseId(null)
      return
    }
    if (action === 'discard') {
      performClose(pendingTab)
      setPendingCloseId(null)
      return
    }
    // 保存档：保存成功才关；失败/没有运行时都**停在弹窗里**（用户还能取消或放弃）
    setSaving(true)
    void (async () => {
      try {
        const saved = await saveService(pendingTab)
        if (!saved) return
        performClose(pendingTab)
        setPendingCloseId(null)
      } catch {
        // 保存失败留在弹窗里，别把标签吞掉
      } finally {
        setSaving(false)
      }
    })()
  }

  /** 白底 pill（激活）/ 纯文字（未激活）——「主对话」与文档标签共用同一档外观 */
  const tabClass = (active: boolean): string =>
    cn(
      'flex h-full w-full min-w-0 items-center gap-1.5 rounded-control text-left text-b2 font-medium transition-colors duration-(--motion-fast) ease-main',
      active ? 'bg-surface text-ink' : 'text-ink-secondary hover:bg-hover hover:text-ink'
    )

  return (
    <>
      <div data-testid="app-tabbar" className="flex h-full min-w-0 flex-1 items-center">
        {/* 标签区（no-drag）：只有这里与「＋」拦拖拽，末尾留白仍是标题栏的拖窗区 */}
        <div
          ref={scrollRef}
          data-testid="app-tabbar-scroll"
          role="tablist"
          aria-label="应用标签页"
          className="no-drag flex h-full min-w-0 items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {/* v2 固定「主对话」标签：永远最靠左、没有关闭钮、中键无效；不进可关闭标签体系 */}
          <div className="flex h-8 min-w-[100px] max-w-[150px] shrink-0 items-center">
            <button
              type="button"
              role="tab"
              id="app-tab-chat"
              data-testid="app-tab-chat"
              aria-selected={inChat}
              title="主对话"
              onClick={() => navigate('/chat')}
              onAuxClick={(event) => {
                // 中键对固定标签无效（也不让它起浏览器中键自动滚动的默认行为）
                if (event.button === 1) event.preventDefault()
              }}
              className={cn(tabClass(inChat), 'px-2')}
            >
              <MessageSquare
                aria-hidden="true"
                className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
              />
              <span className="min-w-0 flex-1 truncate">主对话</span>
            </button>
          </div>

          {tabs.map((tab, index) => {
            // v2：文档标签的激活态只在 /office 生效（其他路由不高亮，activeTabId 仍保留）
            const active = inOffice && tab.id === activeTabId
            const Icon = OFFICE_KIND_ICON[tab.kind]
            const previous = tabs[index - 1]
            // active 两侧的分隔线隐藏；第一条是「主对话」与第一个文档标签之间（聊天激活时也隐藏）
            const hideDivider =
              active || (previous === undefined ? inChat : inOffice && previous.id === activeTabId)
            return (
              <Fragment key={tab.id}>
                <span
                  aria-hidden="true"
                  data-testid="app-tab-divider"
                  className={cn(
                    'mx-1 h-4 w-px shrink-0 bg-hairline transition-opacity duration-(--motion-fast) ease-main',
                    hideDivider && 'opacity-0'
                  )}
                />
                <div
                  role="presentation"
                  className="group relative flex h-8 max-w-[150px] min-w-[100px] shrink-0 items-center"
                >
                  <button
                    type="button"
                    role="tab"
                    id={`office-tab-${tab.id}`}
                    aria-controls={officePanelIdOf(tab.id)}
                    aria-selected={active}
                    data-testid="app-tab"
                    data-office-tab-id={tab.id}
                    data-kind={tab.kind}
                    title={`${tab.title} · ${OFFICE_KIND_LABEL[tab.kind]}`}
                    onClick={() => selectTab(tab.id)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return
                      event.preventDefault()
                      requestClose(tab.id)
                    }}
                    className={cn(tabClass(active), 'pr-6 pl-2')}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
                    />
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    {tab.dirty ? (
                      <>
                        <span
                          aria-hidden="true"
                          data-testid="app-tab-dirty"
                          title="未保存修改"
                          className="size-1.5 shrink-0 rounded-full bg-warning"
                        />
                        <span className="sr-only">未保存</span>
                      </>
                    ) : null}
                    {tab.readOnly ? <span className="sr-only">只读</span> : null}
                  </button>
                  <button
                    type="button"
                    data-testid="app-tab-close"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={() => requestClose(tab.id)}
                    className={cn(
                      'absolute top-1/2 right-1 flex size-(--icon-size-lg) -translate-y-1/2 items-center justify-center rounded-badge text-ink-tertiary transition-opacity duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink',
                      active
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
                    )}
                  >
                    {/* 关闭钮图标随字号 scale（task-73；容器 = --icon-size-lg 20，图标 = sm 16，比例不变不溢出） */}
                    <X aria-hidden="true" className="size-(--icon-size-sm)" />
                  </button>
                </div>
              </Fragment>
            )
          })}

          {/* task-80：空白伪标签（单例）——固定排在文档标签之后、「＋」之前；
              只有 /office 且在前台时高亮；中键/关闭钮关它，不弹脏确认（它不是文档）。 */}
          {newTabOpen ? (
            <Fragment>
              <span
                aria-hidden="true"
                data-testid="app-tab-divider"
                className={cn(
                  'mx-1 h-4 w-px shrink-0 bg-hairline transition-opacity duration-(--motion-fast) ease-main',
                  inOffice && newTabActive && 'opacity-0'
                )}
              />
              <div
                role="presentation"
                className="group relative flex h-8 max-w-[150px] min-w-[100px] shrink-0 items-center"
              >
                <button
                  type="button"
                  role="tab"
                  id="app-tab-newtab"
                  data-testid="app-tab-newtab"
                  data-newtab-tab="true"
                  aria-selected={inOffice && newTabActive}
                  title="新标签页"
                  aria-label="新标签页"
                  onClick={selectNewTab}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    closeBlankTab()
                  }}
                  className={cn(tabClass(inOffice && newTabActive), 'pr-6 pl-2')}
                >
                  <FilePlus2
                    aria-hidden="true"
                    className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate">新标签页</span>
                </button>
                <button
                  type="button"
                  data-testid="app-tab-newtab-close"
                  aria-label="关闭 新标签页"
                  onClick={closeBlankTab}
                  className={cn(
                    'absolute top-1/2 right-1 flex size-(--icon-size-lg) -translate-y-1/2 items-center justify-center rounded-badge text-ink-tertiary transition-opacity duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink',
                    inOffice && newTabActive
                      ? 'opacity-100'
                      : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
                  )}
                >
                  <X aria-hidden="true" className="size-(--icon-size-sm)" />
                </button>
              </div>
            </Fragment>
          ) : null}
        </div>
        <button
          type="button"
          data-testid="app-tab-add"
          aria-label="新建标签页"
          title="新建标签页"
          onClick={openNewTab}
          className="no-drag flex size-7 shrink-0 items-center justify-center rounded-control text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink"
        >
          <Plus aria-hidden="true" className="size-(--icon-size-sm)" />
        </button>
        {/* 标签右侧的空白：不给 no-drag，标题栏的 drag-region 在这里继续生效（可拖窗） */}
        <div aria-hidden="true" data-testid="app-tabbar-spacer" className="h-full min-w-0 flex-1" />
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingCloseId(null)
        }}
        title="关闭未保存的标签？"
        description={
          pendingTab === undefined ? undefined : `「${pendingTab.title}」有未保存的修改。`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => resolveDirtyClose('cancel')} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={() => resolveDirtyClose('save')}>
              保存
            </Button>
            <Button variant="danger" onClick={() => resolveDirtyClose('discard')} disabled={saving}>
              放弃修改
            </Button>
          </>
        }
      />
    </>
  )
}
