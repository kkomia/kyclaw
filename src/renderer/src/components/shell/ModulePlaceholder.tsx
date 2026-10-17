/**
 * 一级模块的占位页（0.2.0 第一阶段）：标题 + 空态，不承载业务。
 * 后续模块在自己的页面里替换这块内容，路由与 testid 先按模块固定下来。
 */
export interface ModulePlaceholderProps {
  title: string
  pageTestId: string
  emptyTestId: string
  emptyText: string
}

export function ModulePlaceholder({
  title,
  pageTestId,
  emptyTestId,
  emptyText
}: ModulePlaceholderProps): React.JSX.Element {
  return (
    <section
      data-testid={pageTestId}
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="content-column flex flex-col gap-6 p-6">
        <h1 data-testid={`${pageTestId}-title`} className="text-t1 font-medium text-ink">
          {title}
        </h1>
        <div
          data-testid={emptyTestId}
          className="flex min-h-40 flex-col items-center justify-center rounded-panel bg-secondary p-6 text-center"
        >
          <p className="text-b2 text-ink-secondary">{emptyText}</p>
        </div>
      </div>
    </section>
  )
}
