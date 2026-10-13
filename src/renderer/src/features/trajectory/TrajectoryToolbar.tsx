/**
 * 轨迹工具栏：`时长 | 轮次 | 调用` 三段切换 + 搜索框 + 轮次全展开/全收起 + 导出。
 *
 * 搜索框是自绘的（雷点 4：输入框不用原生样式），图标靠在输入框左内缘一条固定的内边距走廊上，
 * 不叠在文字上（也就不用"小字"去提示）。导出走工具栏右端，导出的内容见 export.ts。
 */
import { Download, Search, X } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Input } from '@renderer/components/ui/input'
import { Segmented } from '@renderer/components/ui/segmented'
import { Button } from '@renderer/components/ui/button'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { VIEW_MODES, type TrajectoryViewMode } from './timeline'

export interface TrajectoryToolbarProps {
  mode: TrajectoryViewMode
  onModeChange: (mode: TrajectoryViewMode) => void
  query: string
  onQueryChange: (query: string) => void
  /** 命中条数 / 总条数（搜索生效时显示"命中 x / 共 y"） */
  matchCount: number
  totalCount: number
  searching: boolean
  allTurnsCollapsed: boolean
  onToggleAllTurns: () => void
  onExport: () => void
  exporting?: boolean
}

export function TrajectoryToolbar({
  mode,
  onModeChange,
  query,
  onQueryChange,
  matchCount,
  totalCount,
  searching,
  allTurnsCollapsed,
  onToggleAllTurns,
  onExport,
  exporting = false
}: TrajectoryToolbarProps): React.JSX.Element {
  return (
    <div
      data-testid="trajectory-toolbar"
      role="toolbar"
      aria-label="轨迹工具栏"
      className="flex shrink-0 items-center gap-3 px-4 pt-3 pb-2"
    >
      <Segmented
        options={VIEW_MODES.map((entry) => ({
          value: entry.id,
          label: entry.label,
          testId: `trajectory-mode-${entry.id}`
        }))}
        value={mode}
        onChange={onModeChange}
        ariaLabel="轨迹视图"
      />

      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-tertiary"
        />
        {/* type 用 text 而不是 search：Chromium 会给 search 加一个原生的清除钮（雷点 4：
            原生控件一律自绘）—— 清除按钮在下面自己画 */}
        <Input
          type="text"
          data-testid="trajectory-search"
          aria-label="搜索轨迹"
          placeholder="搜索"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          className="h-8 pr-8 pl-8"
        />
        {query === '' ? null : (
          <IconButton
            data-testid="trajectory-search-clear"
            label="清空搜索"
            icon={<X />}
            className="absolute top-1/2 right-1 size-6 -translate-y-1/2 border-transparent"
            onClick={() => onQueryChange('')}
          />
        )}
      </div>

      {searching ? (
        <p data-testid="trajectory-search-count" className="shrink-0 text-c1 text-ink-tertiary">
          命中 {matchCount} / 共 {totalCount}
        </p>
      ) : null}

      <Tooltip label={allTurnsCollapsed ? '展开所有轮次' : '收起所有轮次'}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="trajectory-fold-all"
          onClick={onToggleAllTurns}
        >
          {allTurnsCollapsed ? '展开轮次' : '收起轮次'}
        </Button>
      </Tooltip>

      <Button
        variant="ghost"
        size="sm"
        data-testid="trajectory-export"
        icon={<Download />}
        loading={exporting}
        onClick={onExport}
      >
        导出
      </Button>
    </div>
  )
}
