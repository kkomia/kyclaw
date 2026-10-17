/**
 * 面内自绘 ribbon 的**纯表现层**（A2）。
 *
 * 数据来自 `office-ribbon-model.ts`，命令经 `OfficeCommandAdapter`（A2-prep 定义）——
 * 这样这个组件可以在 jsdom 里用 fake adapter 单测，真实接线在 `OfficeRibbon.tsx`。
 *
 * 视觉口径（用户 2026-10-17 定调 + 设计研究）：
 *   - 字体三声部：chrome sans；数字/快捷键/组标签等"技术标签"用 mono + tabular-nums；
 *     文档内容完全不受影响（Word-faithful）；
 *   - QAT/tab 行 32px、工具带固定 80px、按钮 30px、组标签常显（HF 结构）；
 *   - 动效令牌：反馈 120ms / 入场/展开 --office-motion-enter / 离场 --office-motion-exit；
 *     只有保存态圆点用 spring，其余 settle 无回弹；reduced-motion 由 CSS 压到 0.01ms；
 *   - 零 text-shadow、零霓虹；focus = 1px halo + 2px ring；hover 只变底色/描边。
 *
 * 状态订阅口径（spec R9）：**每个命令项自己订阅**，ribbon 外层不订阅；
 * 外层只订阅 tab/折叠这类纯 UI 状态，避免整条 ribbon 随选区重渲染。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ALargeSmall,
  ArrowLeftToLine,
  ArrowRightToLine,
  Baseline,
  BetweenVerticalStart,
  Bold,
  BookOpen,
  CaseSensitive,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Droplet,
  FileCog,
  Frame,
  Highlighter,
  Image,
  Italic,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListTree,
  MessageSquareText,
  Percent,
  Pilcrow,
  Redo2,
  RemoveFormatting,
  Replace,
  Ruler,
  Save,
  Search,
  SeparatorHorizontal,
  Sparkles,
  SquareSplitVertical,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Type,
  Underline,
  Undo2,
  X,
  type LucideIcon
} from 'lucide-react'
import type { DocxCommandArgs, DocxCommandId } from '@betteroffice/docx-react'
import {
  OFFICE_QAT_ITEMS,
  OFFICE_RIBBON_TABS,
  isOfficeRibbonHostToggle,
  isOfficeRibbonSeparator,
  type OfficeHostToggleId,
  type OfficeQatItem,
  type OfficeRibbonCommandItem,
  type OfficeRibbonGroup,
  type OfficeRibbonHostToggleItem,
  type OfficeRibbonIcon,
  type OfficeRibbonTab,
  type OfficeRibbonTabId
} from './office-ribbon-model'
import type { OfficeCommandAdapter, OfficeCommandState } from './office-command-adapter'
import { OfficeBuiltinCommand } from './OfficeBuiltinCommand'
import { useAnchoredPanel } from './office-popover'

/** 保存态（面内 best-effort；壳写盘结果是真相，见 a2-report.md "保存态" 一节） */
export type OfficeSaveState = 'saved' | 'dirty' | 'saving'

export interface OfficeRibbonViewProps {
  adapter: OfficeCommandAdapter
  /** 当前文档名（QAT 右侧，接管 A1 隐藏 strip 的文件身份） */
  documentName: string
  saveState: OfficeSaveState
  readOnly: boolean
  /** QAT 保存：走既有 onSaveRequest 通路（不另造协议） */
  onRequestSave(): void
  /** AI 面板开关占位：A3 才接面板；不传 = 按钮禁用（诚实占位） */
  onToggleAi?(): void
  /** 视图 tab 的宿主开关（DocxEditor 的 showRuler/showOutline/showMarginGuides） */
  hostToggles?: Partial<Record<OfficeHostToggleId, boolean>>
  onToggleHost?(host: OfficeHostToggleId): void
  /** 初始激活 tab（默认「开始」） */
  initialTabId?: OfficeRibbonTabId
  /** 初始折叠态（默认展开） */
  initialCollapsed?: boolean
  /**
   * 是否显示上下文组（图片/表格，A2-prep 模型里有、按 `enabledWhen` 描述）。
   * v1 默认隐藏：选中图片/光标进表格才该出现，上下文显隐留给 A5；
   * 常显会让「开始」tab 出现一排灰色内核控件（A2 真机截图的观感问题）。
   */
  showContextGroups?: boolean
}

const CONTEXT_GROUP_IDS = new Set(['image-context', 'table-context'])

const ICONS = {
  Save,
  Undo2,
  Redo2,
  Type,
  CaseSensitive,
  ALargeSmall,
  ArrowLeftToLine,
  ArrowRightToLine,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Superscript,
  Subscript,
  Baseline,
  Highlighter,
  RemoveFormatting,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  List,
  ListOrdered,
  ListIndentIncrease,
  ListIndentDecrease,
  BetweenVerticalStart,
  Image,
  Table,
  Link,
  SquareSplitVertical,
  SeparatorHorizontal,
  BookOpen,
  Droplet,
  FileCog,
  Pilcrow,
  MessageSquareText,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  X,
  Search,
  Replace,
  Percent,
  Ruler,
  ListTree,
  Frame
} satisfies Record<OfficeRibbonIcon, LucideIcon>

function RibbonIcon({ name, size = 18 }: { name: OfficeRibbonIcon; size?: number }): ReactNode {
  const Icon = ICONS[name]
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
}

/** 每个命令项独立订阅自己的 state（R9：ribbon 外层不订阅） */
function useOfficeCommandState(
  adapter: OfficeCommandAdapter,
  id: DocxCommandId,
  args: DocxCommandArgs[DocxCommandId] | undefined
): OfficeCommandState {
  const [state, setState] = useState<OfficeCommandState>(() => adapter.getState(id, args))
  useEffect(() => {
    let alive = true
    const read = (): void => {
      if (alive) setState(adapter.getState(id, args))
    }
    read()
    const unsubscribe = adapter.subscribe(read)
    return () => {
      alive = false
      unsubscribe()
    }
    // args 来自 ribbon 模型里的常量对象（对齐 4 个变体各渲染一份），引用稳定
  }, [adapter, id, args])
  return state
}

/** 选择器选项 → 展示值（对齐 `OfficeCommandState.value` 与选项 args 的标量） */
function optionScalar(id: DocxCommandId, args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  switch (id) {
    case 'paragraphStyle':
      return String(record.styleId ?? '')
    case 'fontFamily':
      return String(record.family ?? '')
    case 'fontSize':
      return String(record.points ?? record.size ?? '')
    case 'lineSpacing':
      return String(record.value ?? record.lineSpacing ?? '')
    case 'editingMode':
      return String(record.mode ?? '')
    case 'zoom':
      return String(record.scale ?? record.value ?? '')
    case 'imageWrap':
      return String(record.wrap ?? record.value ?? '')
    default:
      return ''
  }
}

const TEXT_COLOR_PRESETS = [
  '000000',
  '434343',
  '666666',
  '999999',
  'B7B7B7',
  'FFFFFF',
  'FF0000',
  'FF9900',
  'FFFF00',
  '00B050',
  '00B0F0',
  '9900FF'
] as const

const HIGHLIGHT_PRESETS = ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'none'] as const

/**
 * split 颜色按钮：主按钮 + 自绘色板（task-76：改 portal + fixed 定位，逃出 `.ofr-band` 的
 * `overflow-y:hidden` 裁切；浮层用面内 token，深浅主题随 `html[data-theme]` 立即重绘）。
 */
function RibbonColorSplit({
  adapter,
  item,
  readOnly
}: {
  adapter: OfficeCommandAdapter
  item: OfficeRibbonCommandItem
  readOnly: boolean
}): ReactNode {
  const state = useOfficeCommandState(adapter, item.id, item.args)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const paletteRef = useRef<HTMLDivElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const panel = useAnchoredPanel(open, triggerRef, paletteRef, close, {
    minWidth: 168,
    maxHeight: 220
  })
  const disabled = readOnly || !state.enabled

  const presets = item.id === 'highlightColor' ? HIGHLIGHT_PRESETS : TEXT_COLOR_PRESETS
  const isHighlight = item.id === 'highlightColor'
  const palette =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={paletteRef}
            className="ofr-palette"
            role="menu"
            aria-label={item.label}
            data-testid="office-ribbon-color-palette"
            data-placement={panel.placement}
            style={panel.style}
          >
            {presets.map((preset) => (
              <button
                key={preset}
                type="button"
                role="menuitem"
                className="ofr-swatch"
                aria-label={preset}
                title={preset === 'none' ? '无' : preset}
                style={
                  preset === 'none'
                    ? undefined
                    : { background: preset.startsWith('#') ? preset : `#${preset}` }
                }
                onClick={() => {
                  close()
                  void adapter.execute(item.id, {
                    color: preset === 'none' ? null : preset
                  } as never)
                }}
              >
                {preset === 'none' ? <X size={12} strokeWidth={2} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    <span className="ofr-split">
      <button
        ref={triggerRef}
        type="button"
        className="ofr-btn"
        data-testid={item.testId}
        aria-label={item.label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={item.label}
        disabled={disabled}
        data-active={state.active === true}
        onClick={() => setOpen((value) => !value)}
      >
        <RibbonIcon name={item.icon} />
        {isHighlight ? null : (
          <span
            className="ofr-color-strip"
            style={
              typeof state.value === 'string' && state.value.length > 0
                ? { background: state.value }
                : undefined
            }
            aria-hidden="true"
          />
        )}
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
      </button>
      {palette}
    </span>
  )
}

/**
 * select 类命令（task-76 返工）：原生 `<select>` 的 popup 由 OS 绘制，CSS/token/主题都接管不了
 * （暗色下白底白字、只有选中项蓝底可见）→ 改成**自绘 listbox 下拉**：
 *   - trigger 复用 `.ofr-select` 外观（高度压到 24）；浮层 portal 到 body + fixed 定位；
 *   - 键盘 ↑↓ Home/End Enter Esc，aria combobox/listbox/option/aria-expanded/aria-activedescendant；
 *   - 点外/滚动/resize 由 useAnchoredPanel 处理；选项列表内部滚动（max-height 240）；
 *   - 浮层颜色全部走 semantic token（--bg-menu/--border-hairline/--shadow-overlay），
 *     切主题时 html[data-theme] 一变即重绘，不残留旧色。
 */
function RibbonSelect({
  adapter,
  item,
  readOnly
}: {
  adapter: OfficeCommandAdapter
  item: OfficeRibbonCommandItem
  readOnly: boolean
}): ReactNode {
  const state = useOfficeCommandState(adapter, item.id, item.args)
  const options = state.options
  const currentIndex = options.findIndex(
    (option) => optionScalar(item.id, option.args) === String(state.value ?? '')
  )
  const disabled = readOnly || !state.enabled || options.length === 0
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const close = useCallback(() => setOpen(false), [])
  const panel = useAnchoredPanel(open, triggerRef, menuRef, close, {
    minWidth: 56,
    maxHeight: 240,
    flipThreshold: 120
  })

  const openMenu = (): void => {
    if (disabled) return
    setActiveIndex(currentIndex >= 0 ? currentIndex : 0)
    setOpen(true)
  }

  const choose = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    close()
    void adapter.execute(item.id, option.args as never)
  }

  // 键盘移动时把高亮项滚进可视区（列表可滚动）
  useEffect(() => {
    if (!open) return
    const menu = menuRef.current
    if (menu === null) return
    const active = menu.querySelector<HTMLElement>('[data-active="true"]')
    if (typeof active?.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    const key = event.key
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault()
        openMenu()
      }
      return
    }
    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (key === 'Tab') {
      close()
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      const delta = key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + delta + options.length) % options.length)
      return
    }
    if (key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      choose(activeIndex)
    }
  }

  const currentLabel = currentIndex >= 0 ? (options[currentIndex]?.label ?? item.label) : item.label
  const menu =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="ofr-select-menu"
            role="listbox"
            aria-label={item.label}
            data-testid={`${item.testId}-menu`}
            data-placement={panel.placement}
            style={panel.style}
          >
            {options.map((option, index) => (
              <button
                key={`${option.label}-${index}`}
                type="button"
                role="option"
                id={`${menuId}-${index}`}
                className="ofr-select-option"
                aria-selected={index === currentIndex}
                data-active={index === activeIndex}
                data-selected={index === currentIndex}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <span className="ofr-select-option-label">{option.label}</span>
                {index === currentIndex ? (
                  <CheckCheck size={12} strokeWidth={2} aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ofr-select"
        data-testid={item.testId}
        role="combobox"
        aria-label={item.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
        title={item.label}
        disabled={disabled}
        data-value={currentLabel}
        onClick={() => {
          if (open) close()
          else openMenu()
        }}
        onKeyDown={onKeyDown}
      >
        <span className="ofr-select-value">{currentLabel}</span>
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" className="ofr-select-chevron" />
      </button>
      {menu}
    </>
  )
}

/** 普通命令按钮 / toggle（active 由命令 state 驱动） */
function RibbonCommandButton({
  adapter,
  item,
  readOnly
}: {
  adapter: OfficeCommandAdapter
  item: OfficeRibbonCommandItem
  readOnly: boolean
}): ReactNode {
  const state = useOfficeCommandState(adapter, item.id, item.args)
  const disabled = readOnly || !state.enabled
  const active = state.active === true
  return (
    <button
      type="button"
      className="ofr-btn"
      data-testid={item.testId}
      data-active={active}
      data-mixed={state.active === 'mixed'}
      aria-label={item.label}
      aria-pressed={item.type === 'toggle' ? active : undefined}
      title={item.shortcut === undefined ? item.label : `${item.label}（${item.shortcut}）`}
      disabled={disabled}
      onClick={() => {
        void adapter.execute(item.id, item.args)
      }}
    >
      <RibbonIcon name={item.icon} />
    </button>
  )
}

/** 宿主开关（视图 tab 的标尺/大纲/页边距参考线，不是内核命令） */
function RibbonHostToggle({
  item,
  toggles,
  onToggleHost
}: {
  item: OfficeRibbonHostToggleItem
  toggles?: Partial<Record<OfficeHostToggleId, boolean>>
  onToggleHost?: (host: OfficeHostToggleId) => void
}): ReactNode {
  const active = toggles?.[item.host] === true
  return (
    <button
      type="button"
      className="ofr-btn"
      data-testid={item.testId}
      data-active={active}
      aria-pressed={active}
      aria-label={item.label}
      title={item.label}
      disabled={onToggleHost === undefined}
      onClick={() => onToggleHost?.(item.host)}
    >
      <RibbonIcon name={item.icon} />
    </button>
  )
}

function RibbonItem({
  item,
  adapter,
  readOnly,
  toggles,
  onToggleHost
}: {
  item: OfficeRibbonGroup['items'][number]
  adapter: OfficeCommandAdapter
  readOnly: boolean
  toggles?: Partial<Record<OfficeHostToggleId, boolean>>
  onToggleHost?: (host: OfficeHostToggleId) => void
}): ReactNode {
  if (isOfficeRibbonSeparator(item)) {
    return (
      <span className="ofr-sep" data-testid={`office-ribbon-sep-${item.id}`} aria-hidden="true" />
    )
  }
  if (isOfficeRibbonHostToggle(item)) {
    return <RibbonHostToggle item={item} toggles={toggles} onToggleHost={onToggleHost} />
  }
  if (item.control === 'builtin') {
    return <OfficeBuiltinCommand id={item.id} label={item.label} />
  }
  if (item.type === 'select')
    return <RibbonSelect adapter={adapter} item={item} readOnly={readOnly} />
  if (item.type === 'split')
    return <RibbonColorSplit adapter={adapter} item={item} readOnly={readOnly} />
  return <RibbonCommandButton adapter={adapter} item={item} readOnly={readOnly} />
}

/** QAT 左侧：保存/撤销/重做（save 走 onRequestSave，其余走命令适配层） */
function QatButton({
  adapter,
  item,
  readOnly,
  onRequestSave
}: {
  adapter: OfficeCommandAdapter
  item: OfficeRibbonCommandItem
  readOnly: boolean
  onRequestSave(): void
}): ReactNode {
  const state = useOfficeCommandState(adapter, item.id, undefined)
  const isSave = item.id === 'save'
  const disabled = isSave ? readOnly : readOnly || !state.enabled
  return (
    <button
      type="button"
      className="ofr-qat-btn"
      data-testid={item.testId}
      aria-label={item.label}
      title={item.shortcut === undefined ? item.label : `${item.label}（${item.shortcut}）`}
      disabled={disabled}
      onClick={() => {
        if (isSave) onRequestSave()
        else void adapter.execute(item.id)
      }}
    >
      <RibbonIcon name={item.icon} size={16} />
    </button>
  )
}

const SAVE_STATE_LABEL: Record<OfficeSaveState, string> = {
  saved: '已保存',
  dirty: '未保存修改',
  saving: '保存中…'
}

export function OfficeRibbonView({
  adapter,
  documentName,
  saveState,
  readOnly,
  onRequestSave,
  onToggleAi,
  hostToggles,
  onToggleHost,
  initialTabId = 'home',
  initialCollapsed = false,
  showContextGroups = false
}: OfficeRibbonViewProps): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState<OfficeRibbonTabId>(initialTabId)
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const bandRef = useRef<HTMLDivElement | null>(null)

  const activeTab: OfficeRibbonTab =
    OFFICE_RIBBON_TABS.find((tab) => tab.id === activeTabId) ?? OFFICE_RIBBON_TABS[0]!
  const visibleGroups = activeTab.groups.filter(
    (group) => showContextGroups || !CONTEXT_GROUP_IDS.has(group.id)
  )

  // 工具带滚轮横滚（HF 的同款交互；隐藏滚动条，见 office-chrome.css）
  useEffect(() => {
    const band = bandRef.current
    if (band === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      if (band.scrollWidth <= band.clientWidth) return
      event.preventDefault()
      band.scrollLeft += event.deltaY
    }
    band.addEventListener('wheel', onWheel, { passive: false })
    return () => band.removeEventListener('wheel', onWheel)
  }, [activeTabId, collapsed])

  const qatCommandItems = (OFFICE_QAT_ITEMS as readonly OfficeQatItem[]).filter(
    (item): item is OfficeRibbonCommandItem => item.type !== 'status'
  )
  const aiDisabled = onToggleAi === undefined

  return (
    <div className="ofr-ribbon" data-testid="office-ribbon" data-collapsed={collapsed}>
      {/* QAT / tab 行：32px */}
      <div className="ofr-bar">
        <div className="ofr-qat" role="toolbar" aria-label="快速访问">
          {qatCommandItems.map((item) => (
            <QatButton
              key={item.id}
              adapter={adapter}
              item={item}
              readOnly={readOnly}
              onRequestSave={onRequestSave}
            />
          ))}
          <span
            className="ofr-save-state"
            data-testid="office-ribbon-save-state"
            data-state={saveState}
            role="status"
            aria-live="polite"
          >
            <span className="ofr-save-dot" data-state={saveState} aria-hidden="true" />
            <span key={saveState} className="ofr-save-text office-save-swap">
              {SAVE_STATE_LABEL[saveState]}
            </span>
          </span>
        </div>

        <div className="ofr-tabs" role="tablist" aria-label="功能区">
          {OFFICE_RIBBON_TABS.map((tab) => {
            const selected = tab.id === activeTabId
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`office-ribbon-tab-${tab.id}`}
                className="ofr-tab"
                data-testid={`office-ribbon-tab-${tab.id}`}
                data-active={selected}
                aria-selected={selected}
                aria-controls="office-ribbon-band"
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setActiveTabId(tab.id)
                  setCollapsed(false)
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <div className="ofr-bar-right">
          <span
            className="ofr-doc-title"
            data-testid="office-ribbon-doc-title"
            title={documentName}
          >
            {documentName}
          </span>
          <span
            className="ofr-dirty-badge"
            data-testid="office-ribbon-dirty-badge"
            data-dirty={saveState !== 'saved'}
            aria-hidden="true"
          />
          <button
            type="button"
            className="ofr-btn ofr-ai-btn"
            data-testid="office-ribbon-ai"
            aria-label="AI 面板"
            aria-pressed={false}
            title={aiDisabled ? 'AI 面板（A3 接入）' : 'AI 面板'}
            disabled={aiDisabled}
            onClick={onToggleAi}
          >
            <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ofr-btn ofr-collapse"
            data-testid="office-ribbon-collapse"
            aria-label={collapsed ? '展开功能区' : '收起功能区'}
            aria-expanded={!collapsed}
            title={collapsed ? '展开功能区' : '收起功能区'}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronUp size={15} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* 工具带：固定 80px（折叠时高度过渡到 0） */}
      <div
        className="ofr-body"
        id="office-ribbon-band"
        role="tabpanel"
        aria-labelledby={`office-ribbon-tab-${activeTab.id}`}
        data-testid="office-ribbon-body"
      >
        <div className="ofr-band" ref={bandRef} data-testid="office-ribbon-band">
          {visibleGroups.map((group) => (
            <div
              key={group.id}
              className="ofr-group"
              data-testid={`office-ribbon-group-${activeTab.id}-${group.id}`}
              role="group"
              aria-label={group.label}
            >
              <div className="ofr-group-items">
                {group.items.map((item) => (
                  <RibbonItem
                    key={
                      isOfficeRibbonHostToggle(item)
                        ? `host-${item.host}`
                        : isOfficeRibbonSeparator(item)
                          ? `sep-${item.id}`
                          : (item.testId ?? `${item.id}-${JSON.stringify(item.args ?? null)}`)
                    }
                    item={item}
                    adapter={adapter}
                    readOnly={readOnly}
                    toggles={hostToggles}
                    onToggleHost={onToggleHost}
                  />
                ))}
              </div>
              <span className="ofr-group-label" aria-hidden="true">
                {group.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
