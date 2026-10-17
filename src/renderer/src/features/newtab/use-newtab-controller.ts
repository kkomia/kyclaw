import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useNotesStore } from '@renderer/features/notes/notes-store'
import {
  activateExistingDocument,
  createBlankDocument,
  openOfficeDocumentFromPicker
} from '@renderer/features/office/office-actions'
import { openBlockReason, type OpenBlock } from '@renderer/features/office/office-capacity'
import { useOfficeTabsStore, type OfficeTab } from '@renderer/features/office/office-tabs-store'
import { useNewTabStore } from './new-tab-store'
import { relativeNewTabTime } from './newtab-time'

/**
 * 新增标签页 · **行为 / 数据层**（task-80；DESIGN §5/§8/§9）。
 *
 * 这一层只关心"能做什么、状态是什么"，不渲染任何视觉：单例空白伪标签的消费、
 * create-blank/open-dialog/notes 三条真实动作、容量闸门、键盘语义、焦点与日期。
 * 视觉层在 `NewTabView.tsx`（用户 02:44 口径：页面视觉要重做，底座先稳定、壳可整体替换）——
 * 换设计时**只动 View + newtab.css**，本 hook 与测试的行为契约不动。
 *
 * 状态转移（DESIGN §5）：任何成功选择才 consume；失败/取消留在本页：
 *   - 新建 Word：容量 → create-blank → openDocumentChecked → markDirty → consume → /office；
 *   - 写笔记：notes.init（幂等）→ create → consume → /notes；失败留页给行下错误行；
 *   - 打开 Word：容量 → open-dialog → 成功 consume；取消静默；失败留页人话；
 *   - 继续：激活已有标签 + consume；标签不存在（竞态）→ 留页刷新列表；
 *   - 关闭：close（X/中键/Ctrl+W/Esc 共用），焦点还给标签条。
 */
export type Pending = 'blank' | 'note' | 'open'
export type ErrorWhere = 'start' | 'recent'

export interface PageError {
  where: ErrorWhere
  message: string
}

const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const

/** 真实日期（视觉层用：`2026 年 10 月 18 日` / `datetime` 用 ISO 日） */
export function formatNewTabDate(date: Date): string {
  return `${String(date.getFullYear())} 年 ${MONTHS[date.getMonth()] ?? ''} 月 ${String(date.getDate())} 日`
}

export function isoDayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

export interface NewTabController {
  /** 页面容器（视觉层挂 ref；tabindex=-1 时进入即聚焦） */
  pageRef: React.RefObject<HTMLElement | null>
  today: Date
  todayLabel: string
  todayIso: string
  pending: Pending | null
  busy: boolean
  pageError: PageError | null
  block: OpenBlock | null
  /** 最近打开的文档（`lastActiveAt` 倒序、最多 5） */
  recent: OfficeTab[]
  /** 相对时间（视觉层行尾用） */
  relativeTimeOf: (tab: OfficeTab) => string
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  closeBlank: () => void
  /** 三条真实动作（点击/数字键共用同一实现） */
  createDocument: () => void
  writeNote: () => void
  openDocument: () => void
  openRecent: (tabId: string) => void
}

export function useNewTabController(): NewTabController {
  const navigate = useNavigate()
  const pageRef = useRef<HTMLElement | null>(null)
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const [today, setToday] = useState(() => new Date())
  const [pending, setPending] = useState<Pending | null>(null)
  const [pageError, setPageError] = useState<PageError | null>(null)

  /** 打开的文档（继续栏）：按上次激活倒序、最多 5；空白伪标签不在 tabs 里，天然不计 */
  const recent = useMemo(
    () =>
      [...tabs]
        .sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0))
        .slice(0, 5),
    [tabs]
  )
  /** 容量满（5 标签 / 3 未保存）：只禁「会新增文档」的动作；写笔记与继续不受影响 */
  const block = useMemo(() => openBlockReason(tabs, 'docx'), [tabs])
  const busy = pending !== null

  // 进入页面即把焦点放到容器（无可见环），Tab 的第一站是主 CTA
  useEffect(() => {
    pageRef.current?.focus({ preventScroll: true })
  }, [])

  // 跨天/切回窗口时刷新日期（真实读数；不在渲染期读系统时钟做副作用）
  useEffect(() => {
    const refresh = (): void => setToday(new Date())
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  /** 关闭空白：无确认；焦点还给新激活的文档标签，没有文档回「主对话」标签 */
  const closeBlank = useCallback((): void => {
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

  /** 新建空白 Word：成功后空白原地变 docx 标签（标签条位置由 AppTabBar 保证不跳） */
  const runCreate = useCallback(async (): Promise<void> => {
    if (busy || block !== null) return
    setPending('blank')
    setPageError(null)
    const result = await createBlankDocument()
    if (!useNewTabStore.getState().isOpen) return
    if (!result.ok) {
      setPageError({ where: 'start', message: result.message ?? '新建失败，再试一次' })
      setPending(null)
      return
    }
    useNewTabStore.getState().consume()
    navigate('/office')
  }, [block, busy, navigate])

  /**
   * 写笔记（task-89 修复）：init（幂等）→ create（**await 到新笔记被选中**）→ 关空白 → /notes。
   * 成功判定不只看 listError：还要求 selectedId 非空（create 失败时 notes-store 会把错误写进
   * listError；selectedId 缺失说明新笔记没真正打开，不能把用户丢进笔记模块的列表）。
   * 焦点进标题由 notes-store 的 `titleFocusSeq` + NoteEditor 消费（新建后一次性聚焦）。
   */
  const runNote = useCallback(async (): Promise<void> => {
    if (busy) return
    setPending('note')
    setPageError(null)
    const notes = useNotesStore.getState()
    await notes.init(false)
    await notes.create()
    if (!useNewTabStore.getState().isOpen) return
    const after = useNotesStore.getState()
    if (after.listError !== null || after.selectedId === null) {
      setPageError({
        where: 'start',
        message: after.listError ?? '没能新建笔记，再试一次'
      })
      setPending(null)
      return
    }
    useNewTabStore.getState().consume()
    navigate('/notes')
  }, [busy, navigate])

  /** 打开 Word 文档…：取消静默；容量拒绝先 release；失败给主进程人话 */
  const runOpen = useCallback(async (): Promise<void> => {
    if (busy || block !== null) return
    setPending('open')
    setPageError(null)
    const outcome = await openOfficeDocumentFromPicker()
    if (!useNewTabStore.getState().isOpen) return
    if (outcome.status === 'opened') {
      useNewTabStore.getState().consume()
      navigate('/office')
      return
    }
    if (outcome.status === 'cancelled') {
      setPending(null)
      return
    }
    setPageError({ where: 'start', message: outcome.message })
    setPending(null)
  }, [block, busy, navigate])

  /** 「继续」项：激活已有标签 + 消费空白；标签已不在（竞态）就留在本页刷新列表 */
  const openRecent = useCallback(
    (tabId: string): void => {
      if (activateExistingDocument(tabId)) {
        navigate('/office')
        return
      }
      setPageError({ where: 'recent', message: '这个标签已经不在了' })
    },
    [navigate]
  )

  /** 组内方向键/Home/End：只走当前组的可点行（开始组 / 继续组各自循环） */
  const moveFocus = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, direction: -1 | 1 | 'first' | 'last'): void => {
      const group = (event.target as HTMLElement).closest<HTMLElement>('[data-npw-group]')
      if (group === null) return
      const items = Array.from(
        group.querySelectorAll<HTMLElement>('[data-npw-item]:not([disabled])')
      )
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLElement)
      let next: number
      if (direction === 'first') next = 0
      else if (direction === 'last') next = items.length - 1
      else if (current === -1) next = 0
      else next = (current + direction + items.length) % items.length
      items[next]?.focus()
    },
    []
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      const target = event.target as HTMLElement
      const inField =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape') {
        // v1 没有行内输入；原生对话框开着时由对话框自己处理
        event.preventDefault()
        closeBlank()
        return
      }
      if (inField) return
      if (event.key === 'ArrowDown') moveFocus(event, 1)
      else if (event.key === 'ArrowUp') moveFocus(event, -1)
      else if (event.key === 'Home') moveFocus(event, 'first')
      else if (event.key === 'End') moveFocus(event, 'last')
      else if (event.key === '1') {
        event.preventDefault()
        void runCreate()
      } else if (event.key === '2') {
        event.preventDefault()
        void runNote()
      } else if (event.key === '3') {
        event.preventDefault()
        void runOpen()
      }
    },
    [closeBlank, moveFocus, runCreate, runNote, runOpen]
  )

  return {
    pageRef,
    today,
    todayLabel: formatNewTabDate(today),
    todayIso: isoDayOf(today),
    pending,
    busy,
    pageError,
    block,
    recent,
    relativeTimeOf: (tab: OfficeTab) => relativeNewTabTime(tab.lastActiveAt),
    onKeyDown,
    closeBlank,
    createDocument: () => void runCreate(),
    writeNote: () => void runNote(),
    openDocument: () => void runOpen(),
    openRecent
  }
}
