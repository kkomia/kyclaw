import { MessageSquare, Plus, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import {
  OFFICE_KIND_ICON,
  OFFICE_KIND_LABEL,
  OFFICE_PANEL_ID
} from '@renderer/features/office/office-kinds'
import {
  useOfficeTabsStore,
  type DirtyCloseAction,
  type OfficeTab
} from '@renderer/features/office/office-tabs-store'
import { useOfficeUiStore } from '@renderer/features/office/office-ui-store'

export interface AppTabBarProps {
  /**
   * 接编辑器后注入的保存动作：返回 true 才关标签。
   * 不传（当前没有编辑器）= 脏标签关闭只给「取消 / 放弃修改」两档，保存档留在接口上。
   */
  onSave?: (tab: OfficeTab) => boolean | Promise<boolean>
}

/**
 * 顶栏里的浏览器式标签栏：参考 HappyFriday 的 TabBar.vue，用现有 React + Tailwind + 设计 token
 * 重写，不引新依赖。
 *
 * 形态（用户口径 2026-10-17）：最左是**固定的「主对话」标签**（图标 + 文案，不可关闭、永不进
 * 「可关闭标签」体系），其右侧是 Office 文档标签（图标 + 标题 + hover/激活才可见的关闭钮；激活
 * 标签白底圆角 pill、未激活纯文字；宽 100~150；溢出横向滚动、隐藏原生滚动条、滚轮横向滚；
 * 活动标签变化 / 窗口 resize 后 scrollIntoView；标签间 1px 分隔线、active 两侧隐藏），末尾「＋」
 * = 去 /office 并打开「打开文件（示例）」弹窗（标志放 office-ui-store）。
 *
 * v2 路由口径（用户看完布局后拍板）：
 *   - 文档标签的激活态**只在 /office 生效**（其他路由不高亮，activeTabId 保留，切回 Office 继续亮）；
 *   - Ctrl+Tab / Ctrl+Shift+Tab **只在 /office 且文档标签 >0** 时响应，其他路由不抢键；
 *   - Ctrl+W 口径不变（有文档标签就拦默认 + 关当前文档标签；「主对话」标签不在 store 里，永远关不到）；
 *   - 确认弹窗 / 示例弹窗打开时快捷键只吞键、no-op。
 *
 * 为什么标签栏在 TitleBar 里常驻、键盘监听也挂在这里：Office 是独立于会话的多标签工作区，标签栏
 * 要跨路由可见；Ctrl+W 在 Electron 里等于窗口 Close 加速键，有文档标签时不能让默认动作漏下去
 * （审查 shell-audit P1）。
 */
export function AppTabBar({ onSave }: AppTabBarProps = {}): React.JSX.Element {
  const pathname = useLocation().pathname
  const inOffice = pathname.startsWith('/office')
  const inChat = pathname.startsWith('/chat')
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const activeTabId = useOfficeTabsStore((state) => state.activeTabId)
  const close = useOfficeTabsStore((state) => state.close)
  const activate = useOfficeTabsStore((state) => state.activate)
  const openPicker = useOfficeUiStore((state) => state.openPicker)
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pendingTab = tabs.find((tab) => tab.id === pendingCloseId)
  // 标签若被别的路径关掉，pendingCloseId 可能残留；一律以"还找得到这个标签"为准
  const confirming = pendingTab !== undefined

  const requestClose = useCallback(
    (id: string): void => {
      const tab = useOfficeTabsStore.getState().tabs.find((entry) => entry.id === id)
      if (tab === undefined) return
      if (tab.dirty) {
        setPendingCloseId(id)
        return
      }
      close(id)
    },
    // setPendingCloseId 是 useState 的稳定 setter，写进依赖只为满足编译器对显式依赖的校验
    [close, setPendingCloseId]
  )

  // 活动标签滚回视野；resize 之后也滚一次（审查 P1：溢出后窗口变窄，活动标签会被挤出可视区）。
  // 只认文档标签（主对话是固定位、不参与滚动定位）。
  const scrollActiveIntoView = useCallback((): void => {
    const container = scrollRef.current
    if (container === null) return
    const active = container.querySelector<HTMLElement>(
      '[data-office-tab-id][aria-selected="true"]'
    )
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [])

  useEffect(() => {
    scrollActiveIntoView()
  }, [activeTabId, inOffice, tabs.length, scrollActiveIntoView])

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

  // 键盘快捷键（v2 路由口径）：
  //   Ctrl+Tab / Ctrl+Shift+Tab —— 只在 /office 且文档标签 >0 时响应；其他路由完全不抢。
  //   Ctrl+W —— 口径不变：有文档标签就无条件 preventDefault（防 Electron 默认关窗），
  //             弹窗打开时 no-op，否则关当前文档标签。「主对话」标签不在 store 里，永远关不到。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const state = useOfficeTabsStore.getState()
      const dialogsOpen = confirming || useOfficeUiStore.getState().pickerOpen

      if (event.key === 'Tab') {
        if (!inOffice || state.tabs.length === 0) return
        event.preventDefault()
        if (dialogsOpen) return
        const current = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
        const nextIndex =
          current === -1
            ? event.shiftKey
              ? state.tabs.length - 1
              : 0
            : (current + (event.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length
        const next = state.tabs[nextIndex]
        if (next !== undefined) state.activate(next.id)
        return
      }

      const isClose = (event.key === 'w' || event.key === 'W') && !event.shiftKey
      if (!isClose || state.tabs.length === 0) return
      event.preventDefault()
      if (dialogsOpen) return
      requestClose(state.activeTabId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirming, inOffice, requestClose])

  const selectTab = (id: string): void => {
    activate(id)
    navigate('/office')
  }

  const openPickerFromTitleBar = (): void => {
    navigate('/office')
    openPicker()
  }

  const resolveDirtyClose = (action: DirtyCloseAction): void => {
    if (pendingTab === undefined) return
    if (action === 'cancel') {
      setPendingCloseId(null)
      return
    }
    if (action === 'discard') {
      close(pendingTab.id)
      setPendingCloseId(null)
      return
    }
    if (onSave === undefined) return
    setSaving(true)
    void (async () => {
      try {
        const saved = await onSave(pendingTab)
        if (!saved) return
        close(pendingTab.id)
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
                    aria-controls={OFFICE_PANEL_ID}
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
                      'absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-badge text-ink-tertiary transition-opacity duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink',
                      active
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
                    )}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              </Fragment>
            )
          })}
        </div>
        <button
          type="button"
          data-testid="app-tab-add"
          aria-label="打开文件"
          title="打开文件"
          onClick={openPickerFromTitleBar}
          className="no-drag flex size-7 shrink-0 items-center justify-center rounded-control text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink"
        >
          <Plus aria-hidden="true" className="size-4" />
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
            {onSave === undefined ? null : (
              <Button variant="primary" loading={saving} onClick={() => resolveDirtyClose('save')}>
                保存
              </Button>
            )}
            <Button variant="danger" onClick={() => resolveDirtyClose('discard')} disabled={saving}>
              放弃修改
            </Button>
          </>
        }
      />
    </>
  )
}
