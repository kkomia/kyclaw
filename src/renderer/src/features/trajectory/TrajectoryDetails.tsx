/**
 * 明细面板（自右侧滑出）：选中一行后看它的全部细节。
 *
 * 页签**按行的类型给**（口径在 detail-tabs.ts：工具行给概述 / 参数 / 结果 / 计时，
 * 其余给概述 / 预览 / 原始内容）；参数与结果是**原文**（pretty JSON，可一键复制）。
 *
 * 「计时」把口径写清楚：开始时刻、结束时刻、时长、**计时来源**。来源只有两种取值：
 *   - 会话时间戳：从存储里记录下来的时刻倒推（本产品能拿到的就只有这个，见 model.ts 头注）；
 *   - 未记录：两头都没有记录下来的时刻。
 * 时长与来源是两件事：用户消息、还没收尾的调用都有时刻却没有时长，界面照实写"未记录"。
 * TTFT / 逐请求 token 存储里没有，所以这里是"未记录"，不是漏做。
 */
import { useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { formatToolName } from '@shared/mcp'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { detailTabsOf, type DetailTabId } from './detail-tabs'
import { formatClock, formatDuration, formatTokens, KIND_LABEL, type TrajectoryRow } from './model'

/** 状态词：失败 / 进行中 / 已完成 */
function statusOf(row: TrajectoryRow): string {
  if (row.isError) return '失败'
  if (row.pending) return '进行中'
  return '已完成'
}

/** 计时来源的人话 */
function timingSourceOf(row: TrajectoryRow): string {
  return row.timingSource === 'session' ? '会话时间戳' : '未记录'
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-2 py-0.5">
      <dt className="text-c1 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 text-c1 break-words text-ink">{value}</dd>
    </div>
  )
}

/** 可复制的原文块（参数 / 结果 / 原始内容共用一个形状） */
function CopyBlock({
  testId,
  text,
  empty
}: {
  testId: string
  text: string | null
  empty: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  if (text === null) {
    return (
      <p data-testid={`${testId}-empty`} className="px-3 py-2 text-c1 text-ink-tertiary">
        {empty}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 justify-end px-2 pt-1 pb-1">
        <IconButton
          data-testid={`${testId}-copy`}
          label={copied ? '已复制' : '复制'}
          icon={copied ? <Check /> : <Copy />}
          className="size-7 border-transparent"
          onClick={() => {
            void navigator.clipboard?.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
        />
      </div>
      <pre
        data-testid={testId}
        className="min-h-0 flex-1 overflow-auto px-3 pb-3 font-mono text-c1 break-words whitespace-pre-wrap text-ink"
      >
        {text}
      </pre>
    </div>
  )
}

export interface TrajectoryDetailsProps {
  /** 选中的行；null = 收起（面板**不卸载**，宽度与透明度双向过渡，见下面的层） */
  row: TrajectoryRow | null
  onClose: () => void
}

export function TrajectoryDetails({ row, onClose }: TrajectoryDetailsProps): React.JSX.Element {
  /**
   * 收起时留着**上一个选中行**：面板始终挂在文档里、靠宽度 + 透明度过渡开合（雷点 5：
   * 侧面板开合不许硬切），要有东西可过渡，就不能一收起就把内容清空。收起时整块
   * `aria-hidden` + `inert`，读屏与键盘都够不着（视觉上也已经是 0 宽）。
   */
  const [shown, setShown] = useState<TrajectoryRow | null>(row)
  if (row !== null && row !== shown) setShown(row)
  const open = row !== null
  const current = row ?? shown
  // 工具名按同一把展示尺（MCP 走「服务名 · 工具名」；原始名只留在导出里，见 export.ts 的取舍）
  const mcpServers = useSettingsStore((state) => state.settings.mcpServers)
  const durationText = current === null ? null : formatDuration(current.durationMs)
  const startedText = current === null ? null : formatClock(current.startedAt)
  const endedText = current === null ? null : formatClock(current.endedAt)

  const tabs = current === null ? [] : detailTabsOf(current)
  const [tab, setTab] = useState<DetailTabId>(tabs[0]?.id ?? 'overview')
  /**
   * 换行不重置页签会看到"上一条的页签"落在新行上（用户以为点错了），
   * 所以换行时回到这一行**支持的第一个页签**；这是"按 props 调整 state"的合法写法
   * （render 期间条件 setState，React 在提交前用新值重渲染这一次，不走 effect）。
   */
  const [forRow, setForRow] = useState(current)
  if (forRow !== current && current !== null) {
    setForRow(current)
    setTab(detailTabsOf(current)[0]?.id ?? 'overview')
  }

  return (
    <aside
      data-testid="trajectory-details"
      data-open={open ? 'true' : 'false'}
      aria-label="事件详情"
      aria-hidden={open ? undefined : true}
      inert={!open}
      className={cn(
        'shrink-0 overflow-hidden transition-[width,opacity] duration-(--motion-main) ease-main motion-reduce:transition-none',
        open ? 'w-[22rem] opacity-100' : 'w-0 opacity-0'
      )}
    >
      {current === null ? null : (
        /* 内层定宽：外层宽度过渡时里面的字不会跟着重排 */
        <div className="flex h-full w-[22rem] flex-col rounded-panel bg-secondary">
          <header className="flex shrink-0 items-center gap-2 px-3 py-2">
            <span className="shrink-0 rounded-badge bg-active px-1.5 py-0.5 text-c2 text-ink-secondary">
              {KIND_LABEL[current.kind]}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-c1 text-ink">
              {current.toolName === null
                ? current.turn === null
                  ? '轮次之间'
                  : `第 ${current.turn} 轮 · 步骤 ${current.step ?? '-'}`
                : formatToolName(current.toolName, mcpServers)}
            </span>
            <IconButton
              data-testid="trajectory-details-close"
              label="关闭详情"
              icon={<X />}
              className="size-7 border-transparent"
              onClick={onClose}
            />
          </header>

          <div role="tablist" aria-label="事件详情页签" className="flex shrink-0 gap-1 px-2 pb-1">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                data-testid={`trajectory-tab-${entry.id}`}
                onClick={() => setTab(entry.id)}
                className={cn(
                  'rounded-pill px-2 py-1 text-c1 transition-colors duration-(--motion-main) ease-main',
                  tab === entry.id ? 'bg-surface text-ink' : 'text-ink-tertiary hover:bg-hover'
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {/* 内容整体换页签时淡入（不硬切）；数值与原文都在这里 */}
          <div key={tab} className="animate-fade-in flex min-h-0 flex-1 flex-col overflow-auto">
            {tab === 'overview' ? (
              <div data-testid="trajectory-tab-panel-overview" className="px-3 py-2">
                <dl className="m-0">
                  <Field label="来源" value={current.source} />
                  <Field label="状态" value={statusOf(current)} />
                  {current.modelId === null ? null : <Field label="模型" value={current.modelId} />}
                  {current.turn === null ? null : (
                    <Field
                      label="位置"
                      value={
                        current.step === null
                          ? `第 ${current.turn} 轮`
                          : `第 ${current.turn} 轮 · 步骤 ${current.step}`
                      }
                    />
                  )}
                  <Field label="时长" value={durationText ?? '未记录'} />
                  {current.usage === null ? null : (
                    <>
                      <Field
                        label="本轮输入"
                        value={
                          current.usage.steps === null
                            ? formatTokens(current.usage.input)
                            : `${formatTokens(current.usage.input)}（${current.usage.steps} 次调用合计）`
                        }
                      />
                      {current.usage.cachedInput === null ? null : (
                        <Field label="本轮缓存" value={formatTokens(current.usage.cachedInput)} />
                      )}
                      <Field label="本轮输出" value={formatTokens(current.usage.output)} />
                      {current.usage.contextInput === null ? null : (
                        <Field
                          label="上下文大小"
                          value={formatTokens(current.usage.contextInput)}
                        />
                      )}
                    </>
                  )}
                </dl>
                {current.thinking === null ? null : (
                  <blockquote
                    data-testid="trajectory-thinking"
                    className="mt-2 border-l-2 border-hairline pl-2 text-c1 whitespace-pre-wrap text-ink-secondary"
                  >
                    {current.thinking}
                  </blockquote>
                )}
              </div>
            ) : null}

            {tab === 'input' ? (
              <CopyBlock testId="trajectory-payload" text={current.inputRaw} empty="未捕获参数" />
            ) : null}

            {tab === 'output' ? (
              <CopyBlock testId="trajectory-result" text={current.outputRaw} empty="未捕获结果" />
            ) : null}

            {tab === 'timing' ? (
              <div data-testid="trajectory-tab-panel-timing" className="px-3 py-2">
                <dl className="m-0">
                  <Field label="开始时间" value={startedText ?? '不可用'} />
                  <Field label="结束时间" value={endedText ?? '不可用'} />
                  <Field label="时长" value={durationText ?? '未记录'} />
                  <Field label="计时来源" value={timingSourceOf(current)} />
                </dl>
              </div>
            ) : null}

            {tab === 'preview' ? (
              <div data-testid="trajectory-tab-panel-preview" className="px-3 py-2">
                {current.body === null ? (
                  <p className="text-c1 text-ink-tertiary">无内容</p>
                ) : current.kind === 'tool' ? (
                  <pre className="font-mono text-c1 break-words whitespace-pre-wrap text-ink">
                    {current.body}
                  </pre>
                ) : (
                  <TextPart text={current.body} />
                )}
              </div>
            ) : null}

            {tab === 'raw' ? (
              <CopyBlock testId="trajectory-raw" text={current.raw} empty="无内容" />
            ) : null}
          </div>
        </div>
      )}
    </aside>
  )
}
