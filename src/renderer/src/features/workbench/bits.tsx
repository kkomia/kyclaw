/**
 * 工作台四工具共用的小件：空态 / 错误行 / 加载 / 底部详情层 / 分区标题 / 刷新按钮。
 * 全部遵循 UI 雷点：零 emoji、没有小字解释、圆角内不套直角框、不叠多层框线。
 */
import { RotateCw, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/components/ui/cn'

/** 工具空态：图标 + 一句话（不写解释性小字；说不清就说明设计不对） */
export function ToolEmpty({
  testId,
  icon: Icon,
  title
}: {
  testId: string
  icon: LucideIcon
  title: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Icon aria-hidden="true" className="size-(--icon-size-lg) text-ink-tertiary" />
      <p className="text-b2 text-ink">{title}</p>
    </div>
  )
}

/** 加载中（面板内的居中 spinner） */
export function ToolLoading({ testId }: { testId: string }): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-1 items-center justify-center">
      <Spinner label="加载中" className="text-ink-tertiary" />
    </div>
  )
}

/** 出错行（人话；不藏、不静默） */
export function ToolError({
  message,
  testId
}: {
  message: string
  testId: string
}): React.JSX.Element {
  return (
    <p data-testid={testId} className="px-3 py-2 text-b2 text-danger">
      {message}
    </p>
  )
}

/** 工具条（各工具的顶部一行：左标题、右动作） */
export function ToolBar({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex h-9 shrink-0 items-center gap-1 px-2', className)}>{children}</div>
  )
}

/** 分区标题（变更 / 历史 这类一段的开始） */
export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="px-3 pt-3 pb-1 text-c1 text-ink-tertiary">{children}</p>
}

/** 刷新按钮（图标按钮，36 一致；label 就是无障碍名） */
export function RefreshButton({
  onClick,
  label = '刷新',
  testId
}: {
  onClick: () => void
  label?: string
  testId?: string
}): React.JSX.Element {
  return (
    <IconButton
      data-testid={testId}
      label={label}
      icon={<RotateCw />}
      onClick={onClick}
      className="border-transparent hover:bg-hover"
    />
  )
}

/**
 * 底部详情层（单击提交 / 单击文件后的预览）：贴在工具面板底部，只留一条上沿分隔线。
 * 高度走 .trace-fold 的 grid-template-rows 配方（全局的折叠过渡，双向，不硬切）。
 */
export function BottomSheet({
  testId,
  title,
  onClose,
  children
}: {
  testId: string
  title: ReactNode
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <section
      data-testid={testId}
      className="animate-message-in flex max-h-[70%] min-h-0 shrink-0 flex-col border-t border-hairline"
    >
      <ToolBar className="justify-between">
        <span className="min-w-0 truncate px-1 text-b2 text-ink">{title}</span>
        <IconButton
          label="关闭"
          icon={<X />}
          onClick={onClose}
          className="border-transparent hover:bg-hover"
        />
      </ToolBar>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  )
}
