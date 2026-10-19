import { useEffect, useRef } from 'react'
import { Check, FileText, Plug, Sparkles, Terminal } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import type { SuggestionGroup, SuggestionRow } from './suggestion-model'

/**
 * 输入框建议浮窗（`@` 文件 / `/` 命令）——task-61 按 claude-style 紧凑菜单重做。
 *
 * PB-039（0.1.6，对标 DSH `client-ui-commands:1815`）：命令面板数值照抄——
 * 容器 max-height 320 / padding 4；行 padding 5px 7px / 字号 12 / gap 6；详情 11；
 * 选中行右侧 check 14；键盘（↑↓/Tab/Shift+Tab/Enter/Esc）由 Composer 的 textarea 驱动。
 */
export interface ComposerSuggestProps {
  open: boolean
  groups: readonly SuggestionGroup[]
  /** 平铺后的行数（键盘上下走的轴；与 groups 的渲染顺序一致） */
  rowCount: number
  activeIndex: number
  /** 无匹配 / 无数据时的一行说明 */
  emptyText: string
  /** 数据取不到时的一行说明（优先于 emptyText） */
  notice?: string
  onPick: (row: SuggestionRow) => void
  onHover: (index: number) => void
}

/** 分组 → 行图标（用现有数据的分组标题；文件分组没有标题，用文件图标） */
function iconOfGroup(title: string): React.JSX.Element {
  if (title === '命令' || title === '指令') return <Terminal aria-hidden="true" />
  if (title === '插件') return <Plug aria-hidden="true" />
  if (title === '技能') return <Sparkles aria-hidden="true" />
  return <FileText aria-hidden="true" />
}

/** 命令行的英文/斜杠名：真实命令标识（`/compact` / `/plan` / `/goal`），不编造 */
function secondaryOf(row: SuggestionRow): string | null {
  return row.command === undefined ? null : `/${row.command}`
}

export function ComposerSuggest({
  open,
  groups,
  rowCount,
  activeIndex,
  emptyText,
  notice,
  onPick,
  onHover
}: ComposerSuggestProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  // 键盘走动时把选中项滚进视野（nearest；jsdom 没实现 scrollIntoView）
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    if (active !== null && active !== undefined && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, rowCount])

  let flatIndex = -1
  return (
    <div
      ref={listRef}
      data-testid="composer-suggest"
      data-open={open ? 'true' : undefined}
      aria-hidden={open ? undefined : true}
      className={cn(
        'absolute bottom-full left-0 z-20 mb-1 max-h-[320px] w-[min(360px,calc(100vw-24px))] overflow-y-auto rounded-[10px] border-(length:--hairline-width) border-hairline bg-menu p-1 shadow-(--shadow-overlay) backdrop-blur-(--blur-glass) transition-[opacity,transform] duration-(--motion-fast) ease-main motion-reduce:transition-none',
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
      )}
    >
      {notice !== undefined ? (
        <p
          data-testid="composer-suggest-notice"
          className="px-[7px] py-[5px] text-[12px] leading-4 text-ink-secondary"
        >
          {notice}
        </p>
      ) : null}

      {notice === undefined && rowCount === 0 ? (
        <p
          data-testid="composer-suggest-empty"
          className="px-[7px] py-[5px] text-[12px] leading-4 text-ink-secondary"
        >
          {emptyText}
        </p>
      ) : null}

      {notice === undefined
        ? groups.map((group) => (
            <div key={group.title === '' ? 'files' : group.title}>
              {group.title === '' ? null : (
                <p className="px-[7px] pt-[5px] pb-[3px] text-[11px] leading-4 font-medium text-ink-tertiary select-none">
                  {group.title}
                </p>
              )}
              {group.rows.map((row) => {
                flatIndex += 1
                const active = flatIndex === activeIndex
                const disabled = row.disabled === true
                const secondary = secondaryOf(row)
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={disabled}
                    data-testid={`suggest-${row.id}`}
                    data-active={active ? 'true' : undefined}
                    // 按下先别让 textarea 失焦（选区/焦点都是插入要用的状态）
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(row)}
                    onMouseEnter={() => onHover(flatIndex)}
                    className={cn(
                      'flex min-h-[24px] w-full cursor-pointer items-center gap-[6px] rounded-[6px] px-[7px] py-[5px] text-left text-[12px] leading-4 transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
                      active ? 'bg-hover' : 'hover:bg-hover',
                      disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex size-4 shrink-0 items-center justify-center text-ink-tertiary [&>svg]:size-4"
                    >
                      {iconOfGroup(group.title)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{row.label}</span>
                    {secondary === null ? null : (
                      <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-ink-tertiary">
                        {secondary}
                      </span>
                    )}
                    {row.hint === undefined ? null : (
                      <span className="max-w-[45%] min-w-0 shrink-0 truncate text-[11px] text-ink-tertiary">
                        {row.hint}
                      </span>
                    )}
                    {active ? (
                      <Check
                        aria-hidden="true"
                        data-testid="suggest-check"
                        className="size-3.5 shrink-0 text-ink-tertiary"
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))
        : null}
    </div>
  )
}
