import { cn } from './cn'

/**
 * 开关（R2 round 5，用户实拍 #9："启用/停止做成两个按钮" → 直接做成开关；形态照 Kimi 图5）。
 * 药丸轨 + 白色圆钮：关 = Fills-F3 灰轨，开 = 品牌蓝（--accent）；钮的位移走动效快档。
 * 语义：真 <button role="switch">，键盘可达（Space/Enter 触发），焦点环走全局口径（round 5 起是分隔线灰）。
 * 不画外圈（轨道自己就是形态）；不给 checked 的配色另起 token —— 开档用品牌蓝是 Kimi 通知页实测口径
 * （蓝只做小面积标记，开关正好是那一类）。
 */
export interface SwitchProps {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  /** 可访问名（没有可见 label 时必须给） */
  label: string
  'data-testid'?: string
}

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  'data-testid': testId
}: SwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill transition-colors duration-(--motion-fast) ease-main',
        checked ? 'bg-(--accent)' : 'bg-(--fill-active)',
        disabled && 'cursor-not-allowed opacity-60'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-4 rounded-pill bg-(--Always-White) transition-transform duration-(--motion-fast) ease-main',
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
