import type { ReactNode } from 'react'

/**
 * 键帽（快捷键提示）：等宽观感、字符居中、圆角 --radius-badge、描边 hairline 细线，
 * 与工作台空态那组键帽同一形态（EmptyActions 里那份 KeyCap 是同一套类名）。
 *
 * 只做"一枚键"的观感：组合键由调用方按顺序排（`<span aria-hidden>` 包住整组，
 * 键帽不进无障碍名 —— "浏览器 Ctrl T"念出来是噪音）。
 */
export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-badge border-(length:--hairline-width) border-hairline px-1 font-mono text-c1 leading-none text-ink-tertiary">
      {children}
    </kbd>
  )
}
