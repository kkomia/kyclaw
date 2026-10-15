/**
 * 轨迹页（与「对话」并列的一等视图）：工具栏 + 时间轴泳道 + 步骤列表 + 明细面板。
 *
 * 数据流是单向的、只有一处真源：
 *   `useTrajectoryData`（取数 + 投影）→ 搜索（纯函数）→ 时间轴与列表（各自纯函数）
 *   → 选中态（`selectedIndex`）同时喂给时间轴与列表 → 点谁都是**改这一个 state**。
 *
 * 视图档（时长 / 轮次 / 调用）同时改两处（时间轴投影 + 列表排序/分组），口径见 timeline.ts。
 *
 * 取数只有**消息腿**是硬腿：它失败才是整页的错误态（`trajectory-error` + 重试）；用量 / 压缩 /
 * 请求快照三条软腿失败只降级（`trajectory-degraded` 一行人话 + 重试），轨迹照出（round 87 / 017）。
 */
import { useCallback, useMemo, useState } from 'react'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { buildLedgerItems } from './ledger'
import { deriveTimeline, type TrajectoryViewMode } from './timeline'
import { searchTrajectory } from './search'
import {
  downloadTrajectoryExport,
  serializeTrajectoryExport,
  trajectoryExportFileName
} from './export'
import { TrajectoryDetails } from './TrajectoryDetails'
import { TrajectoryLedger } from './TrajectoryLedger'
import { TrajectoryTimeline } from './TrajectoryTimeline'
import { TrajectoryToolbar } from './TrajectoryToolbar'
import { useTrajectoryData } from './use-trajectory-data'
import { TaskSnapshotSummary } from './TaskSnapshotSummary'
import { TaskHistory } from './TaskHistory'

export interface TrajectoryViewProps {
  threadId: string
  /** 用户当前在轨迹页签（false = 一次请求都不发；仍保持挂载以保住滚动/选中态） */
  active: boolean
  /** 取数信号：父组件在一轮结束时换一个值（轨迹只投影已落库的事实） */
  revision?: string
}

export function TrajectoryView({
  threadId,
  active,
  revision = ''
}: TrajectoryViewProps): React.JSX.Element {
  const { doc, messages, usageRuns, requests, compaction, loading, error, usageError, reload } =
    useTrajectoryData({ threadId, active, revision })
  const title = useSessionsStore(
    (state) => state.threads.find((thread) => thread.id === threadId)?.title ?? null
  )

  const [mode, setMode] = useState<TrajectoryViewMode>('duration')
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [exporting, setExporting] = useState(false)

  const search = useMemo(() => searchTrajectory(doc.rows, query), [doc.rows, query])
  /** 搜索生效时列表/时间轴都只认命中行；否则 null = 不过滤 */
  const matchIndexes = search.active ? search.matches : null

  const timeline = useMemo(() => deriveTimeline(doc, mode, matchIndexes), [doc, mode, matchIndexes])

  const items = useMemo(
    () => buildLedgerItems({ doc, mode, collapsedTurns, matches: matchIndexes }),
    [doc, mode, collapsedTurns, matchIndexes]
  )

  const rowsByIndex = useMemo(() => new Map(doc.rows.map((row) => [row.index, row])), [doc.rows])

  const allTurnsCollapsed =
    doc.turns.length > 0 && doc.turns.every((turn) => collapsedTurns.has(turn.turn))

  const onToggleTurn = useCallback((turn: number) => {
    setCollapsedTurns((current) => {
      const next = new Set(current)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }, [])

  const onToggleAllTurns = useCallback(() => {
    setCollapsedTurns((current) =>
      doc.turns.length > 0 && doc.turns.every((turn) => current.has(turn.turn))
        ? new Set()
        : new Set(doc.turns.map((turn) => turn.turn))
    )
  }, [doc.turns])

  const onExport = useCallback(() => {
    setExporting(true)
    try {
      const json = serializeTrajectoryExport({
        thread: { id: threadId, title },
        mode,
        doc,
        messages,
        usageRuns,
        requests,
        compaction
      })
      downloadTrajectoryExport(json, trajectoryExportFileName(threadId))
    } finally {
      setExporting(false)
    }
  }, [compaction, doc, messages, mode, requests, threadId, title, usageRuns])

  const selectedRow = selectedIndex === null ? null : (rowsByIndex.get(selectedIndex) ?? null)

  if (error !== null) {
    return (
      <section
        data-testid="trajectory-view"
        className="flex min-h-0 flex-1 flex-col items-start gap-2 px-4 pt-4"
      >
        <p data-testid="trajectory-error" className="text-b2 text-danger">
          {error}
        </p>
        <button
          type="button"
          data-testid="trajectory-retry"
          onClick={reload}
          className="rounded-control px-2 py-1 text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
        >
          重试
        </button>
      </section>
    )
  }

  if (loading) {
    return (
      <section data-testid="trajectory-view" className="flex min-h-0 flex-1 flex-col px-4 pt-4">
        <p data-testid="trajectory-loading" className="text-b2 text-ink-tertiary">
          正在载入轨迹…
        </p>
      </section>
    )
  }

  return (
    <section data-testid="trajectory-view" className="flex min-h-0 flex-1 flex-col">
      <TaskSnapshotSummary threadId={threadId} />
      <TaskHistory
        threadId={threadId}
        active={active}
        revision={revision}
        representedRevisions={
          new Set(
            doc.rows.flatMap((row) => (row.taskRevision === undefined ? [] : [row.taskRevision]))
          )
        }
      />
      {/* 软腿（用量 / 压缩 / 请求快照）没取到：**不挡轨迹**（用户在反馈 017 里点的就是这个），
          只在顶上留一行人话 + 重试；缺的那部分（token 列 / 「已压缩」行 / 系统·上下文那几行）
          自动留白，不假装是 0 */}
      {usageError === null ? null : (
        <div
          data-testid="trajectory-degraded"
          className="flex shrink-0 items-center gap-2 px-3 pt-1"
        >
          <p data-testid="trajectory-usage-error" className="min-w-0 flex-1 text-c2 text-warning">
            {usageError}
          </p>
          <button
            type="button"
            data-testid="trajectory-usage-retry"
            onClick={reload}
            className="shrink-0 rounded-control px-2 py-0.5 text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
          >
            重试
          </button>
        </div>
      )}
      <TrajectoryToolbar
        mode={mode}
        onModeChange={setMode}
        query={query}
        onQueryChange={setQuery}
        matchCount={search.matches.size}
        totalCount={doc.rows.length}
        searching={search.active}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={onToggleAllTurns}
        onExport={onExport}
        exporting={exporting}
      />
      <TrajectoryTimeline
        model={timeline}
        rowOf={(index) => rowsByIndex.get(index)}
        selectedIndex={selectedIndex}
        matchIndexes={matchIndexes}
        onSelect={setSelectedIndex}
      />

      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <TrajectoryLedger
          items={items}
          selectedIndex={selectedIndex}
          matchIndexes={matchIndexes}
          onSelect={setSelectedIndex}
          onToggleTurn={onToggleTurn}
        />
        {/* 明细面板**常驻**（收起时 0 宽 + 透明，见 TrajectoryDetails）：开合双向都有过渡，
            收起来不占地方（列表因此拿到整幅宽度） */}
        <TrajectoryDetails row={selectedRow} onClose={() => setSelectedIndex(null)} />
      </div>
    </section>
  )
}
