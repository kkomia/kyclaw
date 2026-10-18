/**
 * chat 首页 · 日历热力图（task-127，数据面 `/api/usage/calendar`）。
 *
 * 位置：hero 页预留容器 `welcome-heatmap-placeholder` 内部；容器本身/宽度公式不动。
 * 形态见 `.superpowers/chat-aesthetics/heatmap/DESIGN.md`：
 *   53/54 × 7 网格（周一起始）、方块 gap 3、圆角 2、accent 22/40/62/88% 色阶、
 *   月标签 + 一/三/五星期标签、hover 卡（portal 到 body）、年切换、空态/不足态、
 *   reduced 静态；整图用 section aria-label 汇报汇总（格子 aria-hidden）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UsageCalendar } from '@shared/usage'
import { formatTokens } from '@renderer/lib/usage-format'
import { buildHeatmap, weekdayLabelOf, type HeatmapCell, type HeatmapModel } from './heatmap-model'
import './welcome-heatmap.css'

export interface WelcomeHeatmapProps {
  /** 取数（测试/探针可注入；默认走真实 API） */
  loadCalendar?: (year: number) => Promise<UsageCalendar>
  /** 初始年份（默认当前本地年；测试注入） */
  initialYear?: number
  /** 当前时间（测试注入年份上限用） */
  now?: () => Date
}

function emptyCalendar(year: number): UsageCalendar {
  return { year, days: [], totalActiveDays: 0, totalTokens: 0 }
}

/**
 * 默认取数：**动态** import usage-api，且任何「取不到 API」的情况（单测里该模块被
 * `vi.mock` 成只有部分导出、jsdom 没 bridge、打包缺失）都安全降级为空年 → 渲染空态。
 * 真实的网络/HTTP 错误照常往上抛，由组件渲染「读取失败 · 重试」。
 */
async function defaultLoadCalendar(year: number): Promise<UsageCalendar> {
  let load: ((targetYear: number) => Promise<UsageCalendar>) | undefined
  try {
    const api = await import('@renderer/lib/usage-api')
    load = api.fetchUsageCalendar
  } catch {
    return emptyCalendar(year)
  }
  if (typeof load !== 'function') return emptyCalendar(year)
  return load(year)
}

function monthDateLabel(date: string): string {
  const [year, month, day] = date.split('-')
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`
}

export function WelcomeHeatmap({
  loadCalendar,
  initialYear,
  now
}: WelcomeHeatmapProps): React.JSX.Element {
  const currentYear = (now ?? (() => new Date()))().getFullYear()
  const [year, setYear] = useState(initialYear ?? currentYear)
  const [calendar, setCalendar] = useState<UsageCalendar | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<{ cell: HeatmapCell; left: number; top: number } | null>(null)
  const requestRef = useRef(0)

  const load = useMemo(() => loadCalendar ?? defaultLoadCalendar, [loadCalendar])

  useEffect(() => {
    const request = requestRef.current + 1
    requestRef.current = request
    // 不在 effect 体里同步 setState（react-hooks/set-state-in-effect）：loading/error 由
    // 触发方（初始态、年切换/重试的点击）设置；Promise.resolve().then 把 loader 的同步异常
    // 也变成 rejection，保证「组件永远可渲染」——异常只会走到 error 状态。
    void Promise.resolve()
      .then(() => load(year))
      .then((next) => {
        if (requestRef.current !== request) return
        setCalendar(next)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (requestRef.current !== request) return
        setCalendar(null)
        setError(cause instanceof Error ? cause.message : '读取失败')
        setLoading(false)
      })
    return () => {
      // 换年/卸载时让旧请求的 setState 失效（requestRef 自增即可）
      if (requestRef.current === request) requestRef.current += 1
    }
  }, [load, year])

  // 空年也 build 网格（ghost grid）；构图本身兜底，坏数据也不允许抛到 React 树
  const model: HeatmapModel = useMemo(() => {
    try {
      return buildHeatmap(calendar ?? emptyCalendar(year))
    } catch {
      return buildHeatmap(emptyCalendar(year))
    }
  }, [calendar, year])

  const summary =
    model.totalActiveDays === 0
      ? `${String(year)} 年还没有本地活动`
      : `${String(year)} 年本地活动：${String(model.totalActiveDays)} 个活跃日，共 ${formatTokens(
          model.totalTokens
        )} tokens`
  const insufficient = model.firstDate !== null && model.firstDate > `${String(year)}-01-31`

  /** 年切换：在点击事件里同步进入 loading（effect 体里不再 setState），并清掉旧年数据。 */
  const changeYear = (next: number): void => {
    if (next === year) return
    setCalendar(null)
    setError(null)
    setLoading(true)
    setYear(next)
  }

  const openHover = (cell: HeatmapCell, event: React.MouseEvent<HTMLElement>): void => {
    if (cell.day === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const section = event.currentTarget.closest('.welcome-heatmap')?.getBoundingClientRect()
    const width = 176
    const cardHeight = 88
    // 横向夹在热力图块内（不跑出内容列）；上方空间不够（第一行）就翻到格子下方，
    // 避免盖住上面的标题/副题。
    const left = Math.max(
      section?.left ?? 8,
      Math.min(
        (section?.right ?? window.innerWidth) - width,
        rect.left + rect.width / 2 - width / 2
      )
    )
    const preferredTop = rect.top - cardHeight - 8
    const headBottom =
      event.currentTarget
        .closest('.welcome-heatmap')
        ?.querySelector('.welcome-heatmap-head')
        ?.getBoundingClientRect().bottom ??
      section?.top ??
      0
    // 上方空间不够（或会盖住标题行）→ 翻到格子下方；仍夹在视口内
    const top =
      preferredTop < headBottom + 4
        ? Math.min(window.innerHeight - cardHeight - 8, rect.bottom + 8)
        : Math.max(8, preferredTop)
    setHover({ cell, left, top })
  }

  /** 年切换键盘：←/→ 直接换年（Enter/Space 是 button 原生点击）；nav 有 aria-label 提供当前年。 */
  const onYearKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      changeYear(Math.max(2000, year - 1))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      changeYear(Math.min(currentYear, year + 1))
    }
  }

  const hoverCard =
    hover === null || hover.cell.day === null ? null : (
      <div
        data-testid="welcome-heatmap-tip"
        className="welcome-heatmap-tip"
        style={{ left: `${String(hover.left)}px`, top: `${String(hover.top)}px` }}
        role="status"
      >
        <div className="welcome-heatmap-tip-date font-mono">
          {monthDateLabel(hover.cell.date ?? '')}
        </div>
        <div className="welcome-heatmap-tip-value">
          <b className="font-mono">{formatTokens(hover.cell.tokens)}</b>
          <span>tokens</span>
        </div>
        <div className="welcome-heatmap-tip-note">
          {hover.cell.day.runs} 轮对话 · {hover.cell.day.steps} 次模型调用
        </div>
      </div>
    )

  return (
    <section className="welcome-heatmap" data-testid="welcome-heatmap" aria-label={summary}>
      <div className="welcome-heatmap-head">
        <div className="welcome-heatmap-title">
          <h2>本地活动</h2>
          <span className="welcome-heatmap-sub">近一年 · 数据不出这台机器</span>
        </div>
        <div
          className="welcome-heatmap-year"
          data-testid="welcome-heatmap-year-nav"
          role="group"
          aria-label={`年份切换，当前 ${String(year)} 年`}
          onKeyDown={onYearKeyDown}
        >
          <button
            type="button"
            aria-label="上一年"
            data-testid="welcome-heatmap-prev"
            onClick={() => changeYear(year - 1)}
            disabled={year <= 2000}
          >
            ‹
          </button>
          <span
            className="font-mono"
            data-testid="welcome-heatmap-year"
            aria-live="polite"
            aria-label={`当前年份 ${String(year)}`}
          >
            {year}
          </span>
          <button
            type="button"
            aria-label="下一年"
            data-testid="welcome-heatmap-next"
            onClick={() => changeYear(Math.min(currentYear, year + 1))}
            disabled={year >= currentYear}
          >
            ›
          </button>
        </div>
      </div>

      <div className="welcome-heatmap-plot">
        <div
          className="welcome-heatmap-months font-mono"
          aria-hidden="true"
          style={{ gridTemplateColumns: `repeat(${String(model.weeks)}, minmax(0, 1fr))` }}
        >
          {model.months.map((month) => (
            <span
              key={`${String(month.column)}-${month.text}`}
              style={{ gridColumn: `${String(month.column)} / span 3` }}
            >
              {month.text}
            </span>
          ))}
        </div>
        <div className="welcome-heatmap-days font-mono" aria-hidden="true">
          {Array.from({ length: 7 }, (_, weekday) => (
            <span key={weekday}>{weekdayLabelOf(weekday)}</span>
          ))}
        </div>
        <div
          className="welcome-heatmap-grid"
          data-testid="welcome-heatmap-grid"
          data-weeks={model.weeks}
          data-loading={loading ? 'true' : undefined}
          aria-hidden="true"
          style={{ gridTemplateColumns: `repeat(${String(model.weeks)}, minmax(0, 1fr))` }}
        >
          {model.cells.map((cell) => (
            <span
              key={`${String(cell.week)}-${String(cell.weekday)}`}
              className="welcome-heatmap-cell"
              data-level={cell.level}
              data-out={cell.date === null ? 'true' : undefined}
              data-testid={cell.date === null ? undefined : 'welcome-heatmap-cell'}
              data-date={cell.date ?? undefined}
              style={{
                gridColumn: `${String(cell.week + 1)} / span 1`,
                gridRow: `${String(cell.weekday + 1)} / span 1`
              }}
              onMouseEnter={
                cell.date === null
                  ? undefined
                  : (event) => {
                      openHover(cell, event)
                    }
              }
              onMouseLeave={() => {
                setHover(null)
              }}
            />
          ))}
        </div>
      </div>

      {error !== null ? (
        <div className="welcome-heatmap-foot" data-testid="welcome-heatmap-error">
          <span className="welcome-heatmap-stat font-mono">本地活动读取失败 · {error}</span>
          <button
            type="button"
            className="welcome-heatmap-retry"
            onClick={() => {
              setCalendar(null)
              setError(null)
              setLoading(true)
              void Promise.resolve()
                .then(() => load(year))
                .then((next) => {
                  setCalendar(next)
                  setLoading(false)
                })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : '读取失败')
                  setLoading(false)
                })
            }}
          >
            重试
          </button>
        </div>
      ) : model.totalActiveDays === 0 ? (
        <div className="welcome-heatmap-empty" data-testid="welcome-heatmap-empty">
          <p>这一年还没有本地活动</p>
          <span>开始一次对话，热力图会记下这一天。</span>
        </div>
      ) : (
        <div className="welcome-heatmap-foot">
          <span className="welcome-heatmap-stat font-mono" data-testid="welcome-heatmap-stat">
            {model.totalActiveDays} 个活跃日 · 共 <b>{formatTokens(model.totalTokens)}</b> tokens
            {insufficient && model.firstDate !== null ? ` · 从 ${model.firstDate} 开始记录` : ''}
          </span>
          <span className="welcome-heatmap-legend font-mono" aria-hidden="true">
            少
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} data-level={level} />
            ))}
            多
          </span>
        </div>
      )}

      {hoverCard === null ? null : createPortal(hoverCard, document.body)}
    </section>
  )
}
