import type { CSSProperties, ReactNode } from 'react'
import { formatTokens } from '@shared/models'
import { cn } from '@renderer/components/ui/cn'
import {
  breakdownRows,
  sessionStats,
  tokenStats,
  type BreakdownKey,
  type ContextUsageData
} from './context-usage-model'
import './context-usage.css'

/**
 * 上下文用量浮窗（task-107）：Claude style，磨砂玻璃 + 数字延迟显示。
 *
 * 结构（参考用户截图）：头行「上下文已用 N% + ~已用 / 总量」→ 分段进度条 → 图例（系统提示词 /
 * 工具定义 / 对话消息，各带 ~token）→ 细分隔线 →「会话统计」2×2 →「Token 用量」2×2。
 *
 * 数字延迟：结构/进度条先到，所有读数带 `ctx-num`（150ms 起、18ms 错峰淡入上浮）；
 * `prefers-reduced-motion` / 设置「减弱」直接显示。面板关闭即卸载 → 下次打开重置。
 *
 * 口径全部来自 `context-usage-model.ts`（一个 hook 算、环与浮窗共用），这里只画。
 */
export function ContextUsagePanel({
  stats,
  loading
}: {
  stats: ContextUsageData
  loading: boolean
}): React.JSX.Element {
  if (loading) {
    return (
      <div data-testid="context-loading" className="ctx-body">
        <div className="ctx-skeleton-head">
          <span className="ctx-skeleton ctx-skeleton-title" />
          <span className="ctx-skeleton ctx-skeleton-total" />
        </div>
        <span className="ctx-skeleton ctx-skeleton-bar" />
        <span className="ctx-skeleton ctx-skeleton-line" />
        <span className="ctx-skeleton ctx-skeleton-line ctx-skeleton-short" />
        <div className="ctx-rule" />
        <span className="ctx-skeleton ctx-skeleton-label" />
        <div className="ctx-skeleton-grid">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className="ctx-skeleton ctx-skeleton-cell" />
          ))}
        </div>
      </div>
    )
  }

  const rows = breakdownRows(stats)
  const used = stats.usedInput ?? 0
  const windowTokens = stats.windowTokens
  const remainingPct =
    windowTokens <= 0 ? 0 : Math.max(0, Math.min(100, ((windowTokens - used) / windowTokens) * 100))
  // 读数错峰序号是纯派生值（header 2 → 图例 rows.length → 统计 4 → Token 4），渲染期不修改外部变量
  const legendBase = 2
  const sessionBase = legendBase + rows.length
  const tokenBase = sessionBase + 4

  return (
    <div data-testid="context-panel" className="ctx-body">
      <div className="ctx-head">
        <span className="ctx-head-title">
          上下文已用{' '}
          <Num index={0} className={stats.overThreshold ? 'ctx-warning' : undefined}>
            {stats.usedPct}%
          </Num>
        </span>
        <span className="ctx-head-total">
          <Num index={1}>
            ~{formatTokens(used)} / {formatTokens(windowTokens)}
          </Num>
        </span>
      </div>

      <div className="ctx-bar" role="img" aria-label="上下文构成">
        {rows.map((row) => {
          if (row.tokens === null || row.tokens <= 0 || windowTokens <= 0) return null
          const width = Math.min(100, (row.tokens / windowTokens) * 100)
          return (
            <span
              key={row.key}
              className={`ctx-seg ctx-seg-${row.key}`}
              style={{ width: `${width}%` }}
              data-testid={`context-seg-${row.key}`}
            />
          )
        })}
        <span className="ctx-bar-rest" style={{ width: `${remainingPct}%` }} />
      </div>

      <ul data-testid="context-composition" className="ctx-legend">
        {rows.map((row, rowIndex) => (
          <li key={row.key} className="ctx-legend-row">
            <span className={`ctx-dot ctx-dot-${row.key}`} aria-hidden="true" />
            <span className="ctx-legend-label">{row.label}</span>
            <Num index={legendBase + rowIndex} className="ctx-legend-value">
              {row.tokens === null ? '—' : `~${formatTokens(row.tokens)}`}
            </Num>
          </li>
        ))}
      </ul>

      <div className="ctx-rule" aria-hidden="true" />

      <section className="ctx-section">
        <h3 className="ctx-section-title">会话统计</h3>
        <dl data-testid="context-session-stats" className="ctx-grid">
          {sessionStats(stats).map((cell, cellIndex) => (
            <div key={cell.label} className="ctx-cell">
              <dt className="ctx-cell-label">{cell.label}</dt>
              <dd className="ctx-cell-value">
                <Num index={sessionBase + cellIndex}>{cell.value}</Num>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="ctx-section">
        <h3 className="ctx-section-title">Token 用量</h3>
        <dl data-testid="context-token-stats" className="ctx-grid">
          {tokenStats(stats).map((cell, cellIndex) => (
            <div key={cell.label} className="ctx-cell">
              <dt className="ctx-cell-label">{cell.label}</dt>
              <dd className="ctx-cell-value">
                <Num index={tokenBase + cellIndex}>{cell.value}</Num>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

/** 延迟显示的读数：--i 是错峰序号，CSS 负责 150ms 起、18ms/格的淡入上浮 */
function Num({
  children,
  index,
  className
}: {
  children: ReactNode
  index: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn('ctx-num tabular-nums', className)}
      style={{ '--i': index } as CSSProperties}
    >
      {children}
    </span>
  )
}

/** 供测试/样式使用的段色 class（key → 在 CSS 里按现有语义 token 取色，不硬编码色值） */
export type { BreakdownKey }
