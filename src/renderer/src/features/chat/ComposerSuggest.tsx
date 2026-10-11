import { useEffect, useRef } from 'react'
import { cn } from '@renderer/components/ui/cn'
import type { SuggestionGroup, SuggestionRow } from './suggestion-model'

/**
 * 输入框建议浮窗（round 15：`@` 文件 / `/` 插件·技能）：非模态、浮在输入卡上方，照 Kimi 形态。
 * 键盘（↑/↓/Enter/Esc）由 Composer 的 textarea 处理并驱动 activeIndex；这里只负责画 + 点击：
 *   - 收起时不卸载（opacity/translate 过渡，reduced-motion 直显），避免硬切；
 *   - 鼠标按下先 preventDefault（别让 textarea 失焦丢选区），点击才选中；
 *   - 分组标题为空串时不出标题（@ 文件列表没有分区头）。
 */
export interface ComposerSuggestProps {
  open: boolean
  groups: readonly SuggestionGroup[]
  /** 平铺后的行数（键盘上下走的轴；与 groups 的渲染顺序一致） */
  rowCount: number
  activeIndex: number
  /** 无匹配/无数据时的一行说明 */
  emptyText: string
  /** 数据取不到时的一行说明（优先于 emptyText） */
  notice?: string
  onPick: (row: SuggestionRow) => void
  onHover: (index: number) => void
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

  // 键盘走动时把选中项滚进视野（nearest：不打扰已可见的列表；jsdom 没实现 scrollIntoView）
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
        'absolute right-0 bottom-full left-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-overlay bg-menu p-1 shadow-(--shadow-overlay) backdrop-blur-(--blur-glass) transition-[opacity,transform] duration-(--motion-fast) ease-main motion-reduce:transition-none',
        open ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
      )}
    >
      {notice !== undefined ? (
        <p data-testid="composer-suggest-notice" className="px-2 py-1.5 text-b2 text-ink-secondary">
          {notice}
        </p>
      ) : null}

      {notice === undefined && rowCount === 0 ? (
        <p data-testid="composer-suggest-empty" className="px-2 py-1.5 text-b2 text-ink-secondary">
          {emptyText}
        </p>
      ) : null}

      {notice === undefined
        ? groups.map((group) => (
            <div key={group.title === '' ? '（.）' : group.title}>
              {group.title === '' ? null : (
                <p className="px-2 pt-1.5 pb-0.5 text-c2 text-ink-tertiary">{group.title}</p>
              )}
              {group.rows.map((row) => {
                flatIndex += 1
                const active = flatIndex === activeIndex
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-testid={`suggest-${row.id}`}
                    data-active={active ? 'true' : undefined}
                    // 按下先别让 textarea 失焦（选区/焦点都是插入要用的状态）
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(row)}
                    onMouseEnter={() => onHover(flatIndex)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-(--menu-item-radius) px-2 py-1.5 text-left transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
                      active ? 'bg-hover' : 'hover:bg-hover'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-b2 text-ink">{row.label}</span>
                    {row.hint === undefined ? null : (
                      <span className="max-w-[60%] min-w-0 truncate text-c1 text-ink-tertiary">
                        {row.hint}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))
        : null}
    </div>
  )
}
