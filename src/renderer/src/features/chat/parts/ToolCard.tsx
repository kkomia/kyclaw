import { Wrench } from 'lucide-react'

/**
 * 工具卡：工具名 + 状态 + 入参/结果（静态呈现）。
 * 本轮不做审批交互（那是 T12/T13 的审批卡），所以这里没有按钮，只有状态。
 * 的状态取自 AI SDK 的 tool part 状态机；未知状态原样显示，不猜。
 */
export interface ToolCardPart {
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

const STATE_LABELS: Record<string, string> = {
  'input-streaming': '准备参数',
  'input-available': '调用中',
  'approval-requested': '等待审批',
  'approval-responded': '审批已回应',
  'output-available': '已完成',
  'output-error': '出错',
  'output-denied': '已拒绝'
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ToolCard({ part }: { part: ToolCardPart }): React.JSX.Element {
  const output = part.errorText ?? part.output

  return (
    <div
      data-testid="tool-card"
      data-tool={part.toolName}
      data-state={part.state}
      className="flex flex-col gap-1.5 rounded-panel border-(length:--hairline-width) border-hairline bg-secondary px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
        <span className="font-mono text-c1 text-ink-secondary">{part.toolName}</span>
        <span
          data-testid="tool-state"
          className="ml-auto rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-ink-tertiary"
        >
          {STATE_LABELS[part.state] ?? part.state}
        </span>
      </div>
      {part.input === undefined ? null : (
        <pre
          data-testid="tool-input"
          className="max-h-40 overflow-auto font-mono text-c1 whitespace-pre-wrap text-ink-tertiary"
        >
          {formatValue(part.input)}
        </pre>
      )}
      {output === undefined || output === '' ? null : (
        <pre
          data-testid="tool-output"
          className="max-h-40 overflow-auto font-mono text-c1 whitespace-pre-wrap text-ink-secondary"
        >
          {formatValue(output)}
        </pre>
      )}
    </div>
  )
}
