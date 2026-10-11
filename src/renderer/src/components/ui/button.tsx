import { cva, type VariantProps } from 'class-variance-authority'
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from './cn'
import { Spinner } from './spinner'

/**
 * 按钮三档（UI 参考 §4.7 .km-button-small / medium / large）：
 * 高 26/32/44、圆角 8/10/12、字号 C1/B2/T2、最小宽 52/62/72、内边距 4×8 / 6×10 / 10×14、间隙 2/4/6。
 * 状态过渡走主档 .3s ease-in-out（§6.5 点名的 .km-button）。
 * 焦点环不在这里写：全局 :focus-visible 给 1px 内环（round 5 起是分隔线灰，不是墨色）。
 */
const button = cva(
  'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium select-none transition-colors duration-(--motion-main) ease-main',
  {
    variants: {
      variant: {
        primary: 'bg-(--button-primary-bg) text-(--button-primary-fg)',
        ghost: 'bg-transparent text-ink',
        danger: 'bg-(--button-danger-bg) text-(--button-danger-fg)'
      },
      size: {
        sm: 'h-(--control-height-sm) min-w-(--control-min-width-sm) gap-0.5 rounded-button-sm px-2 py-1 text-c1',
        md: 'h-(--control-height-md) min-w-(--control-min-width-md) gap-1 rounded-control px-2.5 py-1.5 text-b2',
        lg: 'h-(--control-height-lg) min-w-(--control-min-width-lg) gap-1.5 rounded-button-lg px-3.5 py-2.5 text-t2'
      },
      disabled: {
        true: 'cursor-not-allowed bg-(--fill-disabled) text-(--text-disabled)',
        false: ''
      }
    },
    compoundVariants: [
      {
        variant: 'primary',
        disabled: false,
        class: 'hover:bg-(--button-primary-bg-hover) active:bg-(--button-primary-bg-active)'
      },
      { variant: 'ghost', disabled: false, class: 'hover:bg-hover active:bg-active' },
      {
        variant: 'danger',
        disabled: false,
        class: 'hover:bg-(--button-danger-bg-hover) active:bg-(--button-danger-bg-active)'
      }
    ],
    defaultVariants: { variant: 'primary', size: 'md', disabled: false }
  }
)

const ICON_SIZE_CLASS: Record<NonNullable<VariantProps<typeof button>['size']>, string> = {
  sm: 'size-(--icon-size-sm)',
  md: 'size-(--icon-size-md)',
  lg: 'size-(--icon-size-lg)'
}

export type ButtonVariant = NonNullable<VariantProps<typeof button>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof button>['size']>

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** loading：换成 spinner（直径跟档位）、禁用交互、标 aria-busy（视觉防闪见 useDelayedLoading） */
  loading?: boolean
  /** 前导图标（loading 时被 spinner 顶掉） */
  icon?: ReactNode
}

/**
 * 防闪时序（round 9 用户实拍："点击保存存在保存按钮内的快速转圈闪烁"）：
 * loading 置位后**延迟这么久**才把 spinner/灰底显示出来——本机保存往往 <50ms，
 * 期间就结束的话视觉上完全不动（但按钮从第一刻起就禁用防重复提交）。
 */
const LOADING_SHOW_DELAY_MS = 200

/** 一旦显示了 spinner，**至少保持这么久**再退回（避免收尾时再闪一下） */
const LOADING_MIN_VISIBLE_MS = 300

/**
 * loading → "要不要把 spinner 画出来"。两个定时器口径：晚到 200ms、早退 300ms。
 * 定时器存 ref，重入 / 卸载都会清（重入：loading 又变回 true 时把待退的定时器撤掉，
 * spinner 连续显示不闪断）。
 */
function useDelayedLoading(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | null>(null)
  /** spinner 真正显示出来的时刻（算"至少保持"用） */
  const shownAtRef = useRef(0)

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    clear()

    if (loading) {
      if (visible) return clear
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        shownAtRef.current = Date.now()
        setVisible(true)
      }, LOADING_SHOW_DELAY_MS)
      return clear
    }
    if (visible) {
      // 到点（或已过点）再退：0 也走异步定时器，避免在 effect 里同步 setState
      const remaining = Math.max(LOADING_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current), 0)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setVisible(false)
      }, remaining)
    }
    return clear
  }, [loading, visible])

  return visible
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  type = 'button',
  disabled,
  className,
  children,
  ...props
}: ButtonProps): React.JSX.Element {
  // 功能上立即禁用（防重复提交）；视觉上的 spinner / 灰底走防闪时序
  const isDisabled = disabled === true || loading
  const showLoading = useDelayedLoading(loading)

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        button({ variant, size, disabled: disabled === true || showLoading }),
        className
      )}
      {...props}
    >
      {showLoading ? (
        <Spinner size={size} decorative />
      ) : icon === undefined ? null : (
        <span
          aria-hidden="true"
          className={cn(ICON_SIZE_CLASS[size], 'shrink-0 [&>svg]:size-full')}
        >
          {icon}
        </span>
      )}
      {children}
    </button>
  )
}
