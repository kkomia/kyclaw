import { useState } from 'react'
import {
  Brain,
  ChevronRight,
  FileText,
  Pencil,
  PenLine,
  Search,
  Server,
  Wrench
} from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { formatToolName } from '@shared/mcp'
import { TraceFold } from './TraceFold'
import {
  STATE_LABELS,
  STATE_TONES,
  TONE_CLASS,
  formatValue,
  previewOutput,
  toolDetailOf,
  toolStateRunning
} from './tool-part'
import type { ToolCardPart } from './tool-part'

/**
 * 工具行（round 6 改造，对照《对话UI-工具链与显示口径 v0.1》§1.4/§1.5/§1.6）：
 * 行 = 图标 + 工具名 + 行详情（path/pattern）+ 状态签 + hover 才露的 chevron；
 * 展开体 = 入参 + 结果（走 TraceFold 的 grid-rows 折叠，不做条件渲染硬切）。
 * 24px 行高、hover 只变字色（无底色）、行级耗时不印。
 *
 * 状态取自 AI SDK 的 tool part 状态机（spec §7.1：input-streaming → input-available →
 * （approval-requested → approval-responded）→ output-available / output-error；v7 另有
 * output-denied 这一档）；未知状态原样显示，不猜。判定与文案在 tool-part.ts（纯逻辑）。
 *
 * 结果预览：**恒定 600 字截断、不给出口**（文档 §1.6，没有「加载全部」按钮）；
 * 入参不截断（服务端已裁 2000 字），px 限高 + 纵向滚动。
 *
 * 审批交互不在这里：`approval-requested` 且接了决策回调的 part 由 TraceBlock 交给审批卡接管，
 * 本卡只负责"已回应/执行完成"之后的静态收束（含被拒绝）。
 */
export type { ToolCardPart }

/** 面板体限高（文档 §5.2：132px ≈ 6 行） */
const PANEL_MAX_HEIGHT = 'max-h-[132px]'

/** 行级图标（文档 §1.5 的 STEP_ICONS 按我们现有工具集简化；MCP 一律 Server，兜底 Wrench） */
function ToolIcon({
  toolName,
  className
}: {
  toolName: string
  className?: string
}): React.JSX.Element {
  if (toolName.startsWith('mcp__')) return <Server aria-hidden="true" className={className} />
  switch (toolName) {
    case 'read':
      return <FileText aria-hidden="true" className={className} />
    case 'write':
      return <Pencil aria-hidden="true" className={className} />
    case 'edit':
      return <PenLine aria-hidden="true" className={className} />
    case 'glob':
    case 'grep':
      return <Search aria-hidden="true" className={className} />
    case 'updateWorkingMemory':
      return <Brain aria-hidden="true" className={className} />
    default:
      return <Wrench aria-hidden="true" className={className} />
  }
}

function rowClass(interactive: boolean): string {
  return cn(
    'group/row flex min-h-6 w-full items-center gap-2 text-left text-c1 text-ink-secondary',
    interactive &&
      'cursor-pointer transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none'
  )
}

export interface ToolCardProps {
  part: ToolCardPart
  /** 这一轮还在流式：input-available 显示"调用中"（否则是"已调用"——没回执的调用不该永远装进行中） */
  running?: boolean
}

export function ToolCard({ part, running = false }: ToolCardProps): React.JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null)
  // MCP 工具显示用户注册的服务名（round 14）：`mcp__mcp-1__search` → 「知识库 · search」
  const mcpServers = useSettingsStore((state) => state.settings.mcpServers)
  const displayName = formatToolName(part.toolName, mcpServers)
  const output = part.errorText ?? part.output
  const hasOutput = output !== undefined && output !== ''
  const hasBody = part.input !== undefined || hasOutput
  // 单步默认折着（文档 §1.3：单步没有自动展开档）；点过听用户的
  const open = override ?? false
  const tone = STATE_TONES[part.state] ?? 'pending'
  const detail = toolDetailOf(part.input)
  const live = running && toolStateRunning(part.state)
  const stateLabel =
    part.state === 'input-available' && !running
      ? '已调用'
      : (STATE_LABELS[part.state] ?? part.state)

  const row = (
    <>
      <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center">
        <ToolIcon toolName={part.toolName} className="size-[15px] text-ink-tertiary" />
      </span>
      <span className="shrink-0 font-mono text-c1">{displayName}</span>
      {detail === null ? null : (
        <span
          data-testid="tool-detail"
          className="min-w-0 truncate font-mono text-c1 text-ink-tertiary"
        >
          {detail}
        </span>
      )}
      <span
        data-testid="tool-state"
        className={cn(
          'ml-auto shrink-0 text-c1',
          live ? 'trace-live' : TONE_CLASS[tone],
          // "已调用"不是告警腔：中性色（等审批/出错那几档才吃语气色）
          !live && part.state === 'input-available' && 'text-ink-tertiary'
        )}
      >
        {stateLabel}
      </span>
      {hasBody ? (
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-tertiary transition-[opacity,transform] duration-(--motion-fast) ease-main motion-reduce:transition-none',
            open
              ? 'rotate-90 opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100'
          )}
        />
      ) : null}
    </>
  )

  return (
    <div data-testid="tool-card" data-tool={part.toolName} data-state={part.state} data-tone={tone}>
      {hasBody ? (
        <button
          type="button"
          data-testid="tool-row"
          aria-expanded={open}
          onClick={() => setOverride(!open)}
          className={rowClass(true)}
        >
          {row}
        </button>
      ) : (
        <div className={rowClass(false)}>{row}</div>
      )}
      <TraceFold open={open} className="pl-7">
        {part.input === undefined ? null : (
          <pre
            data-testid="tool-input"
            className={cn(
              PANEL_MAX_HEIGHT,
              'mt-1 overflow-auto rounded-control bg-secondary p-2 font-mono text-c1 whitespace-pre-wrap text-ink-tertiary [overflow-wrap:anywhere]'
            )}
          >
            {formatValue(part.input)}
          </pre>
        )}
        {hasOutput ? (
          <pre
            data-testid="tool-output"
            className={cn(
              PANEL_MAX_HEIGHT,
              'mt-1 overflow-auto rounded-control bg-secondary p-2 font-mono text-c1 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]'
            )}
          >
            {previewOutput(output)}
          </pre>
        ) : null}
      </TraceFold>
    </div>
  )
}
