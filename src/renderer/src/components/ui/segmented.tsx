import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * 分段切换（自绘，不是原生控件 —— 雷点 4）：
 * 一条轨道 + 一枚**滑动的**指示片（`transform` 走主档时长，切换不硬切 —— 雷点 5）。
 *
 * 两处在用（同一份实现，形状不会分叉）：
 *   - 对话页顶部栏的「对话 / 轨迹」（轨迹是与对话并列的一等视图）；
 *   - 轨迹页工具栏的「时长 / 轮次 / 调用」。
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  testId?: string
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** 可访问名（控件本身没有可见标签，靠这个说清"这是一组什么"） */
  ariaLabel: string
  className?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className
}: SegmentedProps<T>): React.JSX.Element {
  const count = Math.max(1, options.length)
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex shrink-0 rounded-pill bg-active p-0.5', className)}
    >
      <div className="relative flex items-center">
        {/* 指示片：宽度 = 一份，位移 = 份数 × 100% */}
        <span
          aria-hidden="true"
          data-testid="segmented-thumb"
          className="pointer-events-none absolute inset-y-0 left-0 rounded-pill bg-surface transition-transform duration-(--motion-main) ease-main motion-reduce:transition-none"
          style={{ width: `${100 / count}%`, transform: `translateX(${activeIndex * 100}%)` }}
        />
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={option.testId}
              onClick={() => {
                if (!selected) onChange(option.value)
              }}
              className={cn(
                'relative z-10 inline-flex h-7 items-center gap-1 rounded-pill px-3 text-c1 whitespace-nowrap transition-colors duration-(--motion-main) ease-main',
                selected ? 'text-ink' : 'text-ink-tertiary hover:text-ink-secondary'
              )}
            >
              {option.icon === undefined ? null : (
                <span aria-hidden="true" className="size-3.5 shrink-0 [&>svg]:size-full">
                  {option.icon}
                </span>
              )}
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
