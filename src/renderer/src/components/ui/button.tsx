import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'
import { Spinner } from './spinner'

/**
 * 按钮三档（UI 参考 §4.7 .km-button-small / medium / large）：
 * 高 26/32/44、圆角 8/10/12、字号 C1/B2/T2、最小宽 52/62/72、内边距 4×8 / 6×10 / 10×14、间隙 2/4/6。
 * 状态过渡走主档 .3s ease-in-out（§6.5 点名的 .km-button）。
 * 焦点环不在这里写：全局 :focus-visible 给墨色 1px 内环（§5.4）。
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
  /** loading：换成 spinner（直径跟档位）、禁用交互、标 aria-busy */
  loading?: boolean
  /** 前导图标（loading 时被 spinner 顶掉） */
  icon?: ReactNode
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
  const isDisabled = disabled === true || loading

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(button({ variant, size, disabled: isDisabled }), className)}
      {...props}
    >
      {loading ? (
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
