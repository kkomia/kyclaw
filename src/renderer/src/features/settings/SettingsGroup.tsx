import type { ReactNode } from 'react'

/**
 * 栏目卡片组：组用底色分层（不描边），组内控件自己带一条 hairline —— 避免近距多层框线。
 *
 * round 48 增补 `action` 槽（用户口径）：动作按钮与**组标题同一行、在圆角卡外面的右端** ——
 * 与插件页「新增」同一套模式（塞进卡里会把动作和内容混成一坨，也不跟别的组齐）。不给 action 时
 * 布局与从前逐字一致。
 */
export function SettingsGroup({
  title,
  testId,
  action,
  children
}: {
  title: string
  testId: string
  /** 标题行右端的动作（可选） */
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-b2 text-ink-secondary">{title}</h2>
        {action}
      </div>
      <div className="rounded-panel bg-secondary p-4">{children}</div>
    </section>
  )
}
