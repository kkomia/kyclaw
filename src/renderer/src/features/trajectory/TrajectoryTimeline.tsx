/**
 * 时间轴泳道（三条：输入 / 模型 / 工具）：一条横向时间轴，块的**横向位置 = 时刻、宽度 = 时长**。
 *
 * 几何全部来自 `deriveTimeline`（纯函数、有 spec）；这里只负责画：
 *   - 三条泳道各占一行（等高铁轨，与左侧标签同行对齐，所以不会有 px 魔法数在组件里）；
 *   - 块一律 `rounded-pill`（圆角容器里不出现直角方框）；
 *   - 选中：被选中的块描一圈、别的降到 20% —— 与列表**双向联动**（点块选行、选行亮块）；
 *   - 搜索：命中的块亮、未命中的降到 14%（与列表的过滤口径一致）。
 *
 * 时刻缺一头的记录（没时长）画成最小刻度（2px 起），**不是**"瞬间完成"。
 */
import { LANE_LABELS, spanGeometry, type TimelineModel, type TrajectoryLane } from './timeline'
import { cn } from '@renderer/components/ui/cn'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { formatToolName } from '@shared/mcp'
import { formatClock, formatDuration, type TrajectoryRow } from './model'

export interface TrajectoryTimelineProps {
  model: TimelineModel
  /** 按行序号取行（画 tooltip 文案用） */
  rowOf: (index: number) => TrajectoryRow | undefined
  selectedIndex: number | null
  /** 搜索命中的行序号；null = 没在搜索 */
  matchIndexes: ReadonlySet<number> | null
  onSelect: (rowIndex: number) => void
}

/**
 * tooltip 文案：类型 + 时刻区间 + 时长（拿不到的字段不写这一行）。
 * 工具名走 `formatToolName`（与审批卡 / 工具卡同一把尺）：MCP 工具显示「服务名 · 工具名」，
 * 不是线里的 `mcp__<serverId>__<tool>` —— 服务名要现读设置，所以由调用方传进来。
 */
function spanTooltip(
  row: TrajectoryRow | undefined,
  servers: ReadonlyArray<{ id: string; name: string }>
): string {
  if (row === undefined) return ''
  const kind =
    row.kind === 'tool'
      ? `工具 ${row.toolName === null ? '' : formatToolName(row.toolName, servers)}`.trim()
      : row.kind === 'message'
        ? '模型'
        : '输入'
  const from = formatClock(row.startedAt)
  const to = formatClock(row.endedAt)
  const duration = formatDuration(row.durationMs)
  const lines = [kind]
  if (from !== null && to !== null && row.endedAt !== row.startedAt) lines.push(`${from} → ${to}`)
  else if (from !== null) lines.push(from)
  if (duration !== null) lines.push(duration)
  return lines.join('\n')
}

/**
 * 泳道行高：标签列与三条泳道共用同一把尺 —— 取 C2 的行高（--ui-C2-line-height），
 * 不是 h-2 的 8px。C2 档 10px 字号配 14px 行高，塞进 8px 的高度会上下各漫出 3px，
 * 两列间隙只有 4px，漫出来的部分盖住邻行就叠成一团。两列同高 + 同 gap 即逐行对齐，
 * 字号档换档时两者一起变，组件里仍然没有 px 魔法数。
 */
const LANE_ROW_HEIGHT = 'h-(--ui-C2-line-height)'

export function TrajectoryTimeline({
  model,
  rowOf,
  selectedIndex,
  matchIndexes,
  onSelect
}: TrajectoryTimelineProps): React.JSX.Element {
  const lanes: TrajectoryLane[] = [0, 1, 2]
  const duration = Math.max(1, model.domainEnd - model.domainStart)
  // MCP 工具名的展示口径（服务名现读设置；认不出回落原样，见 @shared/mcp 的 formatToolName）
  const mcpServers = useSettingsStore((state) => state.settings.mcpServers)

  return (
    <section
      data-testid="trajectory-timeline"
      aria-label="轨迹时间轴"
      className="shrink-0 px-4 pb-3"
    >
      <div className="flex gap-2 rounded-panel bg-secondary px-3 py-2.5">
        {/* 泳道标签：与右侧三条泳道同行高、同间隙（靠同一个 flex 列 + gap 对齐） */}
        <div aria-hidden="true" className="flex shrink-0 flex-col gap-1">
          {LANE_LABELS.map((label) => (
            <span
              key={label}
              className={cn('flex items-center text-c2 text-ink-tertiary', LANE_ROW_HEIGHT)}
            >
              {label}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* 轮次分界：一条细竖线（不是框线，只是刻度） */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {model.turnBoundaries.map((boundary) => (
              <span
                key={boundary.turn}
                data-testid={`trajectory-turn-boundary-${boundary.turn}`}
                className="absolute inset-y-0 w-px bg-hairline"
                style={{
                  left: `${((boundary.at - model.domainStart) / duration) * 100}%`
                }}
              />
            ))}
          </div>

          <div className="flex flex-col gap-1">
            {lanes.map((lane) => (
              <div key={lane} className={cn('relative rounded-pill bg-hover', LANE_ROW_HEIGHT)}>
                {model.spans
                  .filter((span) => span.lane === lane)
                  .map((span) => {
                    const geometry = spanGeometry(model, span)
                    const row = rowOf(span.rowIndex)
                    const dimmed =
                      (selectedIndex !== null && selectedIndex !== span.rowIndex) ||
                      (matchIndexes !== null && !matchIndexes.has(span.rowIndex))
                    return (
                      <Tooltip
                        key={span.rowIndex}
                        label={spanTooltip(row, mcpServers)}
                        side="bottom"
                      >
                        <button
                          type="button"
                          data-testid={`trajectory-span-${span.rowIndex}`}
                          data-selected={selectedIndex === span.rowIndex ? 'true' : undefined}
                          data-dimmed={dimmed ? 'true' : undefined}
                          aria-label={spanTooltip(row, mcpServers).replace('\n', '，')}
                          onClick={() => onSelect(span.rowIndex)}
                          className={cn(
                            'absolute inset-y-0 rounded-pill transition-opacity duration-(--motion-fast) ease-main motion-reduce:transition-none',
                            span.kind === 'tool' && 'bg-warning',
                            span.kind === 'message' && 'bg-accent',
                            span.kind === 'compacted' && 'bg-ink-tertiary',
                            (span.kind === 'user' ||
                              span.kind === 'context' ||
                              span.kind === 'system') &&
                              'bg-positive',
                            span.isError && 'bg-danger',
                            selectedIndex === span.rowIndex && 'ring-1 ring-ink',
                            dimmed && 'opacity-20'
                          )}
                          style={{
                            left: `${geometry.leftPercent}%`,
                            // 宽度 = 时长占比；没时长的给一个最小刻度（2px），不假装持续多久
                            width: `max(2px, ${geometry.widthPercent}%)`
                          }}
                        />
                      </Tooltip>
                    )
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {model.empty ? (
        <p data-testid="trajectory-timeline-empty" className="px-3 pt-2 text-c1 text-ink-tertiary">
          无计时数据
        </p>
      ) : null}
    </section>
  )
}
