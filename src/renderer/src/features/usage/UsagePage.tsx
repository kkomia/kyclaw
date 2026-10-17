import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { fetchUsage } from '@renderer/lib/usage-api'
import { formatTokens } from '@renderer/lib/usage-format'
import { usageRangeSchema, type UsageRange, type UsageResponse } from '@shared/usage'

/**
 * 用量面板（T14 起；round 5 从页面里拆出）：本地记账的窗口统计——今日 / 本月 + 按模型拆分。
 * 面板本体同时被设置页「用量」栏复用（round 5 去重：设置为唯一导航源）。
 *
 * 数据全部来自服务端（/api/usage，libsql 的 usage_runs）：页面不自己算窗口，
 * 与"账在服务端"一致。切换窗口时内容按 key 重新挂一次（进场动效跟着走，不硬切）。
 *
 * 用户口径 014：**这一页不做计费** —— 只留 token 用量（总量 / 按模型 / 次数）。
 * 服务端的用量记账与 /api/usage 回包也一并去掉了计费口径（没有 cost / 币种字段可读）。
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

/**
 * 汇总 + 按模型拆分（数据已到位才渲染，所以 data 是确定的）。
 *
 * 数字排版（P2 字体统一）：用量/次数是**数据读数** → mono + tabular-nums（章程 §2.4/§2.5）：
 *   - 总量的 t1 可以保留字号，但必须 mono + tabular（等宽数字不跳动）；
 *   - 模型行的数字单独包一层 mono+tabular，后面的「Token / 次」标签仍是 sans（继承外层文字声部）。
 */
function UsageReport({ data }: { data: UsageResponse }): React.JSX.Element {
  return (
    <>
      <section
        data-testid="usage-summary"
        className="flex flex-wrap gap-10 rounded-panel bg-secondary p-4"
      >
        <div className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">Token</span>
          <span
            data-testid="usage-tokens"
            className="font-mono text-t1 font-medium text-ink tabular-nums"
          >
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
                  <span className="font-mono tabular-nums">{formatTokens(row.tokens.total)}</span>{' '}
                  Token
                </span>
                <span data-testid={`usage-model-${index}-runs`}>
                  <span className="font-mono tabular-nums">{row.runs}</span> 次
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export function UsagePanel(): React.JSX.Element {
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
    <>
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
    </>
  )
}

/** 用量页（独立路由 /usage）：页级容器 + 标题 + 面板；面板同时被设置页「用量」栏复用。 */
export function UsagePage(): React.JSX.Element {
  return (
    // round 23：外层全宽滚动容器（滚动条贴窗口右缘）+ 内层限宽内容列（口径不变）
    <section
      data-testid="usage-page"
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div data-testid="usage-page-column" className="content-column flex flex-col gap-6 p-6">
        <h1 className="text-t1 font-medium text-ink">用量</h1>
        <UsagePanel />
      </div>
    </section>
  )
}
