import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'
import './page-chrome.css'

/**
 * 页面级 chrome 的统一声部（task-100 · 设计一致性 P1）。
 *
 * 全站只保留这几档标题/元信息/空态外壳；各页只决定「标题字是什么、动作是什么」，
 * 不再各写一套字号（评审 P1-1/2/5）。字号全部 = 基准档 × `--ui-scale`（随设置字号缩放）。
 *
 * - `PageTitle`   页面 h1：衬线 22/30 600（对话页、Office 显式登记为「无可见页面标题」）
 * - `PageMeta`    标题旁读数：mono 10/14 tabular（篇数/份数/页数）
 * - `DetailTitle` 详情 h2：衬线 24/32 600
 * - `SectionTitle` 分区 h2：衬线 24/28 600（新标签页「开始/继续」这类 section 档）
 * - `EmptyState`  空态四件套：可选 mark/icon/眉题 + 衬线 22/30 标题 + 一句邀请 +
 *                 可选能力标签（≤6）+ 可选主按钮；不放插画（章程 §9.6）
 */
export function PageTitle({ className, ...props }: ComponentProps<'h1'>): React.JSX.Element {
  return <h1 className={cn('ui-page-title', className)} {...props} />
}

export function PageMeta({ className, ...props }: ComponentProps<'span'>): React.JSX.Element {
  return <span className={cn('ui-page-meta', className)} {...props} />
}

export function DetailTitle({ className, ...props }: ComponentProps<'h2'>): React.JSX.Element {
  return <h2 className={cn('ui-detail-title', className)} {...props} />
}

export function SectionTitle({ className, ...props }: ComponentProps<'h2'>): React.JSX.Element {
  return <h2 className={cn('ui-section-title', className)} {...props} />
}

export interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'title'> {
  /** 标题上方的可选标记（如笔记的稿纸记号）；纯装饰，模板结构的一部分 */
  mark?: ReactNode
  /** 可选图标（如 Office 的文档图标）；与 mark 二选一 */
  icon?: ReactNode
  /** 可选 mono 眉题（如知识库「资料索引」）；不再重复页名 */
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** 能力/格式标签（≤6；真实支持的格式，不假装更多） */
  tags?: readonly string[]
  /** 标签行的测试钩子（跨页模板统一、页面自己的 testid 契约保留） */
  tagsTestId?: string
  /** 主按钮（可选；空态最多一个动作） */
  action?: ReactNode
}

export function EmptyState({
  mark,
  icon,
  eyebrow,
  title,
  description,
  tags,
  tagsTestId,
  action,
  className,
  ...props
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={cn('ui-empty', className)} {...props}>
      {mark}
      {icon === undefined ? null : (
        <span className="ui-empty-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {eyebrow === undefined ? null : <p className="ui-empty-eyebrow">{eyebrow}</p>}
      <h2 className="ui-empty-title">{title}</h2>
      {description === undefined ? null : <p className="ui-empty-desc">{description}</p>}
      {tags === undefined || tags.length === 0 ? null : (
        <ul className="ui-empty-tags" aria-hidden="true" data-testid={tagsTestId}>
          {tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      {action === undefined ? null : <div className="ui-empty-action">{action}</div>}
    </div>
  )
}
