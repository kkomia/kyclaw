/**
 * 明细面板（自右侧滑出）：选中一行后看它的全部细节。
 *
 * 页签**按行的类型给**（口径在 detail-tabs.ts：工具行给概述 / 参数 / 结果 / 计时；
 * 请求行（系统 / 上下文）给概述 / 预览 / **请求** / 原始内容；其余给概述 / 预览 / 原始内容）。
 * 参数与结果是**原文**（pretty JSON，可一键复制）。「系统 / 上下文」两类行的正文**按需取**
 * （`row.request.id` → `/api/trajectory/requests/detail`）：一条请求实测 ~96 KB（3 条 system
 * 1.4 万字 + 35 件工具 8.1 万字），列表不带它；「请求」页签列出这一次发给模型的**全部消息**
 * （系统 / 用户 / 记忆 / 规矩 / 工具与后续工具结果），长条目的正文走可折叠长文本（`LongText`）。
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
import type { TrajectoryRequestDetail, TrajectoryRequestMessage } from '@shared/trajectory'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { detailTabsOf, type DetailTabId } from './detail-tabs'
import { useRequestDetail } from './use-request-detail'
import { formatClock, formatDuration, formatTokens, KIND_LABEL, type TrajectoryRow } from './model'

/** 预览页签里超过这么多字就先折叠（系统指令通常几万字，铺开会把面板撑爆） */
const COLLAPSE_THRESHOLD = 1200

/** 状态词：失败 / 进行中 / 已完成 */
function statusOf(row: TrajectoryRow): string {
  if (row.interactionStatus === 'waiting') return '等待回答'
  if (row.interactionStatus === 'answered') return '已回答'
  if (row.interactionStatus === 'cancelled') return '已取消'
  if (row.isError) return '失败'
  if (row.pending) return '进行中'
  return '已完成'
}

/** 计时来源的人话 */
function timingSourceOf(row: TrajectoryRow): string {
  return row.timingSource === 'session' ? '会话时间戳' : '未记录'
}

/** 这一行在会话里的位置（系统 / 上下文 / 失败三类不属于某个步骤，见 model.ts 头注） */
function positionOf(row: TrajectoryRow): string | null {
  if (row.turn === null) return null
  const step = row.request?.step
  const suffix = step === undefined || step === null ? '' : ` · 第 ${step + 1} 次请求`
  if (row.kind === 'system' || row.kind === 'context' || row.kind === 'error')
    return `第 ${row.turn} 轮 · ${KIND_LABEL[row.kind]}${suffix}`
  return row.step === null ? `第 ${row.turn} 轮` : `第 ${row.turn} 轮 · 步骤 ${row.step}`
}

/** 消息角色的界面词（请求里的 role 是 provider 协议词） */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具'
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role
}

/** 这一份请求的正文有没有就绪（没有就显示载入 / 失败 + 重试） */
function RequestBodyState({
  detail,
  loading,
  error,
  onRetry,
  children
}: {
  detail: TrajectoryRequestDetail | null
  loading: boolean
  error: string | null
  onRetry: () => void
  children: (detail: TrajectoryRequestDetail) => React.JSX.Element
}): React.JSX.Element {
  if (error !== null) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-2">
        <p data-testid="trajectory-request-error" className="text-c1 text-danger">
          {error}
        </p>
        <button
          type="button"
          data-testid="trajectory-request-retry"
          onClick={onRetry}
          className="rounded-control px-2 py-0.5 text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
        >
          重试
        </button>
      </div>
    )
  }
  if (detail === null) {
    return (
      <p
        data-testid="trajectory-request-loading"
        className={cn('px-3 py-2 text-c1 text-ink-tertiary', loading && 'animate-pulse')}
      >
        正在载入请求正文…
      </p>
    )
  }
  return children(detail)
}

/**
 * 可折叠长文本（预览页签）：短文本照旧直接渲染（不额外加一层按钮），
 * 超过 `COLLAPSE_THRESHOLD` 字的先收成一段固定高度，点「展开全部」看全（再点收起）。
 */
function LongText({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > COLLAPSE_THRESHOLD
  return (
    <div data-testid="trajectory-long-text" data-expanded={expanded ? 'true' : 'false'}>
      <div className={cn(!expanded && long && 'max-h-64 overflow-hidden')}>
        <TextPart text={text} />
      </div>
      {long ? (
        <button
          type="button"
          data-testid="trajectory-long-text-toggle"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 rounded-pill bg-active px-2 py-1 text-c2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
        >
          {expanded ? '收起' : `展开全部（${text.length.toLocaleString('en-US')} 字）`}
        </button>
      ) : null}
    </div>
  )
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

/** 消息清单的角色小计（"42 条消息 · 系统 3 · 用户 1 …"） */
function messageSummary(messages: readonly TrajectoryRequestMessage[]): string {
  const byRole = new Map<string, number>()
  for (const message of messages) byRole.set(message.role, (byRole.get(message.role) ?? 0) + 1)
  const parts = [...byRole.entries()].map(([role, count]) => `${roleLabel(role)} ${count}`)
  return `${messages.length} 条消息${parts.length === 0 ? '' : ` · ${parts.join(' · ')}`}`
}

/** 一条消息：角色徽标 + 正文（长正文走可折叠块） */
function RequestMessageRow({
  message,
  index
}: {
  message: TrajectoryRequestMessage
  index: number
}): React.JSX.Element {
  return (
    <div
      data-testid={`trajectory-request-message-${index}`}
      className="border-b border-hairline py-1.5 last:border-b-0"
    >
      <div className="flex items-center gap-2 pb-1">
        <span className="shrink-0 rounded-badge bg-active px-1.5 py-0.5 text-c2 text-ink-secondary">
          {roleLabel(message.role)}
        </span>
        <span className="min-w-0 flex-1 truncate text-c2 text-ink-tertiary">
          {message.truncated
            ? `已截断（原文 ${message.chars.toLocaleString('en-US')} 字）`
            : `${message.chars.toLocaleString('en-US')} 字`}
        </span>
      </div>
      {message.text === '' ? (
        <p className="text-c1 text-ink-tertiary">（无正文）</p>
      ) : (
        <LongText text={message.text} />
      )}
    </div>
  )
}

/** 「请求」页签：这一次发给模型的全部消息 */
function RequestMessages({ detail }: { detail: TrajectoryRequestDetail }): React.JSX.Element {
  return (
    <div data-testid="trajectory-tab-panel-request" className="px-3 py-2">
      <p className="pb-1 text-c2 text-ink-tertiary">{messageSummary(detail.messages)}</p>
      {detail.messageCount !== null && detail.messageCount > detail.messages.length ? (
        <p data-testid="trajectory-request-head-dropped" className="pb-1 text-c2 text-warning">
          （前面 {detail.messageCount - detail.messages.length} 条未保留）
        </p>
      ) : null}
      {detail.messages.map((message, index) => (
        <RequestMessageRow key={`${index}-${message.role}`} message={message} index={index} />
      ))}
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

  // 请求正文**按需取**（只有"拿到了请求体"的那类行才取；失败行没有正文、收起时也不取）
  const requestId = open && current?.request?.status === 'complete' ? current.request.id : null
  const request = useRequestDetail(requestId)

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
                ? (positionOf(current) ?? '轮次之间')
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
                    <Field label="位置" value={positionOf(current) ?? `第 ${current.turn} 轮`} />
                  )}
                  <Field label="时长" value={durationText ?? '未记录'} />
                  {current.kind === 'error' ? (
                    // 失败那一次**没有请求体**（provider 报错时 `steps[].request.body` 不存在）：
                    // 这里明说，而不是让"预览/请求"两页签空着让人以为是漏做
                    <Field label="请求正文" value="未捕获（这一轮失败了，provider 没回请求体）" />
                  ) : null}
                  {current.request?.truncated === true ? (
                    <Field label="正文" value="超上限已截断（明细里照实标出）" />
                  ) : null}
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
              current.request === null ? (
                <div data-testid="trajectory-tab-panel-preview" className="px-3 py-2">
                  {current.body === null ? (
                    <p className="text-c1 text-ink-tertiary">无内容</p>
                  ) : current.kind === 'tool' ? (
                    <pre className="font-mono text-c1 break-words whitespace-pre-wrap text-ink">
                      {current.body}
                    </pre>
                  ) : (
                    // 长正文（系统指令几万字）走可折叠块；短的正文明文渲染不变（见 LongText）
                    <LongText text={current.body} />
                  )}
                </div>
              ) : (
                <RequestBodyState {...request} onRetry={request.reload}>
                  {(detail) => (
                    <div data-testid="trajectory-tab-panel-preview" className="px-3 py-2">
                      {current.kind === 'system' ? (
                        detail.system === null ? (
                          <p className="text-c1 text-ink-tertiary">这一次请求里没有系统指令</p>
                        ) : (
                          <LongText text={detail.system} />
                        )
                      ) : detail.tools === null ? (
                        <p className="text-c1 text-ink-tertiary">这一次请求里没有工具表</p>
                      ) : (
                        <pre className="font-mono text-c1 break-words whitespace-pre-wrap text-ink">
                          {detail.tools}
                        </pre>
                      )}
                    </div>
                  )}
                </RequestBodyState>
              )
            ) : null}

            {tab === 'request' ? (
              <RequestBodyState {...request} onRetry={request.reload}>
                {(detail) => <RequestMessages detail={detail} />}
              </RequestBodyState>
            ) : null}

            {tab === 'raw' ? (
              requestId === null ? (
                // 普通行 / 失败行：这一行的原始条目（失败行给的就是那条账，没有请求体可取）
                <CopyBlock testId="trajectory-raw" text={current.raw} empty="无内容" />
              ) : (
                <RequestBodyState {...request} onRetry={request.reload}>
                  {(detail) => (
                    <CopyBlock
                      testId="trajectory-raw"
                      text={JSON.stringify(detail, null, 2)}
                      empty="无内容"
                    />
                  )}
                </RequestBodyState>
              )
            ) : null}
          </div>
        </div>
      )}
    </aside>
  )
}
