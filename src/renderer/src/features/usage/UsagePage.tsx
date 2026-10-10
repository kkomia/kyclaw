import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { fetchUsage } from '@renderer/lib/usage-api'
import { formatCost, formatTokens } from '@renderer/lib/usage-format'
import { usageRangeSchema, type UsageRange, type UsageResponse } from '@shared/usage'

/**
 * 用量页（T14）：本地记账的窗口统计——今日 / 本月 + 按模型拆分。
 *
 * 数据全部来自服务端（/api/usage，libsql 的 usage_runs）：页面不自己算窗口、不自己算价，
 * 与"账在服务端"一致。切换窗口时内容按 key 重新挂一次（进场动效跟着走，不硬切）。
 * 数字口径见 lib/usage-format：未知模型的花费显示占位符、部分未计价时合计带 "≥"。
 */
const RANGE_LABELS: Record<UsageRange, string> = {
  today: '今日',
  month: '本月'
}

/** 分享条宽度：占比化整，但有 token 的行至少给 2% 宽度（否则细到看不见） */
function shareWidth(tokens: number, total: number): string {
  if (tokens <= 0 || total <= 0) return '0%'
  return `${Math.min(100, Math.max(2, Math.round((tokens / total) * 100)))}%`
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** 汇总 + 按模型拆分（数据已到位才渲染，所以 data 是确定的） */
function UsageReport({ data }: { data: UsageResponse }): React.JSX.Element {
  return (
    <>
      <section
        data-testid="usage-summary"
        className="flex flex-wrap gap-10 rounded-panel bg-secondary p-4"
      >
        <div className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">花费</span>
          <span data-testid="usage-cost" className="text-t1 font-medium text-ink">
            {formatCost(data.cost, { currency: data.currency, incomplete: data.costIncomplete })}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">Token</span>
          <span data-testid="usage-tokens" className="text-t1 font-medium text-ink">
            {formatTokens(data.tokens.total)}
          </span>
        </div>
      </section>

      {data.byModel.length === 0 ? (
        <p data-testid="usage-empty" className="text-b2 text-ink-secondary">
          这段时间还没有用量记录。
        </p>
      ) : (
        <section data-testid="usage-models" className="flex flex-col gap-3">
          <h2 className="text-b2 text-ink-secondary">按模型</h2>
          {data.byModel.map((row, index) => (
            <div
              key={`${row.provider ?? ''}:${row.model}`}
              data-testid={`usage-model-${index}`}
              className="flex flex-col gap-3 rounded-panel bg-secondary p-4"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span
                  data-testid={`usage-model-${index}-name`}
                  className="truncate text-b2 text-ink"
                >
                  {row.model}
                </span>
                <span
                  data-testid={`usage-model-${index}-cost`}
                  className="shrink-0 text-b2 text-ink"
                >
                  {formatCost(row.cost, { currency: data.currency })}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-1.5 w-full overflow-hidden rounded-pill bg-hover"
              >
                <div
                  className="h-full rounded-pill bg-(--text-tertiary)"
                  style={{ width: shareWidth(row.tokens.total, data.tokens.total) }}
                />
              </div>
              <div className="flex justify-between gap-4 text-c1 text-ink-secondary">
                <span data-testid={`usage-model-${index}-tokens`}>
                  {formatTokens(row.tokens.total)} Token
                </span>
                <span data-testid={`usage-model-${index}-runs`}>{row.runs} 次</span>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export function UsagePage(): React.JSX.Element {
  const [range, setRange] = useState<UsageRange>('today')
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<{
    key: string
    data: UsageResponse | null
    error: Error | null
  } | null>(null)

  const resolveKey = `${range}#${reloadToken}`

  useEffect(() => {
    let alive = true
    fetchUsage(range).then(
      (data) => {
        if (alive) setState({ key: `${range}#${reloadToken}`, data, error: null })
      },
      (cause: unknown) => {
        if (alive) setState({ key: `${range}#${reloadToken}`, data: null, error: toError(cause) })
      }
    )
    return () => {
      alive = false
    }
  }, [range, reloadToken])

  const current = state !== null && state.key === resolveKey ? state : null

  return (
    <section
      data-testid="usage-page"
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-t1 font-medium text-ink">用量</h1>
        <div role="group" aria-label="统计范围" className="flex gap-3">
          {usageRangeSchema.options.map((option) => (
            <Chip
              key={option}
              data-testid={`usage-range-${option}`}
              aria-pressed={range === option}
              className={cn(range === option && 'bg-selected')}
              onClick={() => setRange(option)}
            >
              {RANGE_LABELS[option]}
            </Chip>
          ))}
        </div>
      </div>

      {current === null ? (
        <div
          data-testid="usage-loading"
          className="flex flex-col gap-3 rounded-panel bg-secondary p-4"
        >
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : current.error !== null ? (
        <div
          data-testid="usage-error"
          role="alert"
          className="flex flex-col items-start gap-3 rounded-panel bg-secondary p-4"
        >
          <p className="text-b2 text-ink-secondary">{current.error.message}</p>
          <Button
            size="sm"
            variant="ghost"
            data-testid="usage-retry"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            重试
          </Button>
        </div>
      ) : current.data === null ? null : (
        <div key={resolveKey} className="animate-fade-in flex flex-col gap-6">
          <UsageReport data={current.data} />
        </div>
      )}
    </section>
  )
}
