import { useState } from 'react'
import {
  Brain,
  ChevronRight,
  FileText,
  FolderInput,
  GitBranch,
  Globe,
  Pencil,
  PenLine,
  Search,
  Server,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useWorkbenchRoot } from '@renderer/features/workbench/use-workbench-root'
import { formatToolName } from '@shared/mcp'
import { displayPath } from '../display-path'
import { TraceFold } from './TraceFold'
import { askUserResultLabel } from '../ask-user'
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
 * 行 = 图标 + 工具名 + 行详情（path/pattern；round28 补了 bash 的命令与 fetch 的 URL）+
 * 状态签 + hover 才露的 chevron；
 * 展开体 = 入参 + 结果（走 TraceFold 的 grid-rows 折叠，不做条件渲染硬切）。
 * 24px 行高、hover 只变字色（无底色）、行级耗时不印。
 *
 * round 85：行详情里的路径按**展示口径**显示 —— 会话根内的文件给工作区相对路径（根外 / 判不出根
 * 原样），见 display-path；**只改这一行的显示**（入参面板与回执文本原样，模型看到的路径不动）。
 *
 * 状态取自 AI SDK 的 tool part 状态机（spec §7.1：input-streaming → input-available →
 * （approval-requested → approval-responded）→ output-available / output-error；v7 另有
 * output-denied 这一档）；未知状态原样显示，不猜。判定与文案在 tool-part.ts（纯逻辑）。
 *
 * 结果预览：**恒定 600 字截断、不给出口**（文档 §1.6，没有「加载全部」按钮）；
 * 入参不截断（服务端已裁 2000 字），px 限高 + 纵向滚动。
 *
 * 审批与 AskUser 交互在输入框上方停靠；本卡只展示调用状态与结果（含等待回答、已回答和已取消）。
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
    // round28 模块 1 的新工具（没有专名也在 default 兜底里照常显示，这里只是给套更像的图标）
    case 'bash':
      return <Terminal aria-hidden="true" className={className} />
    case 'delete':
      return <Trash2 aria-hidden="true" className={className} />
    case 'move':
      return <FolderInput aria-hidden="true" className={className} />
    case 'fetch':
      return <Globe aria-hidden="true" className={className} />
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_add':
    case 'git_commit':
      return <GitBranch aria-hidden="true" className={className} />
    default:
      return <Wrench aria-hidden="true" className={className} />
  }
}

/**
 * 行详情兜底（round28）：tool-part.toolDetailOf 只认 path/pattern/query，
 * bash（command）与 fetch（url）在这两样上取不到值 —— 在组件侧补一条只读兜底，
 * 不改 tool-part 的公共口径。删除/移动有 path，走既有路径。
 */
function extraDetailOf(toolName: string, input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as { command?: unknown; url?: unknown }
  if (toolName === 'bash' && typeof record.command === 'string' && record.command !== '') {
    return record.command
  }
  if (toolName === 'fetch' && typeof record.url === 'string' && record.url !== '') {
    return record.url
  }
  return null
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
  /**
   * 行详情里的路径按**展示口径**收成工作区相对路径（round 85，用户实报 013：编辑工作区内文件时
   * 那一行铺出整条绝对路径、太长）。会话根与文件树 / 预览 / 附件同一个来源（`useWorkbenchRoot`，
   * 它读的是 `sessionRootPathOf` 这份**真根**），本组件不另做路径推断；判不出根 / 根外文件原样显示。
   * 只动这一行的**显示**：入参面板（`tool-input`）与工具回执仍是原样，模型看到的路径不变。
   */
  const { rootPath } = useWorkbenchRoot()
  const displayName = formatToolName(part.toolName, mcpServers)
  const output = part.errorText ?? part.output
  const hasOutput = output !== undefined && output !== ''
  const hasBody = part.input !== undefined || hasOutput
  // 单步默认折着（文档 §1.3：单步没有自动展开档）；点过听用户的
  const open = override ?? false
  const tone = STATE_TONES[part.state] ?? 'pending'
  const detail = toolDetailOf(part.input) ?? extraDetailOf(part.toolName, part.input)
  /** 行详情只改**显示**：根内 → 工作区相对路径，根外 / 判不出根 → 原样（见 display-path） */
  const shownDetail = detail === null ? null : displayPath(detail, rootPath)
  const live = running && toolStateRunning(part.state)
  const stateLabel =
    part.toolName === 'ask_user'
      ? (askUserResultLabel(part.output) ??
        (part.state === 'input-available' ? '等待回答' : (STATE_LABELS[part.state] ?? part.state)))
      : part.state === 'input-available' && !running
        ? '已调用'
        : (STATE_LABELS[part.state] ?? part.state)

  const row = (
    <>
      <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center">
        <ToolIcon toolName={part.toolName} className="size-[15px] text-ink-tertiary" />
      </span>
      <span data-font-role="code" className="shrink-0 font-mono text-c1">
        {displayName}
      </span>
      {shownDetail === null ? null : (
        <span
          data-testid="tool-detail"
          data-font-role="code"
          className="min-w-0 truncate font-mono text-c1 text-ink-tertiary tabular-nums"
        >
          {shownDetail}
        </span>
      )}
      <span
        data-testid="tool-state"
        data-font-role="ui"
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
