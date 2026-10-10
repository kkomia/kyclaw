import { useState } from 'react'
import type { UIMessage } from 'ai'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import type { Workspace } from '@shared/settings'
import { ApprovalCard, type ApprovalDecision } from '../ApprovalCard'
import { approvalRequestOf, type ApprovalRequest } from '../approval'
import { ReasoningPart } from './ReasoningPart'
import { ToolCard } from './ToolCard'
import { isToolPart, toToolCardPart, toolStateRunning } from './tool-part'
import { TraceFold } from './TraceFold'

/**
 * 过程块（round 6，对照《对话UI-工具链与显示口径 v0.1》§1.1/§1.3）：一条助手消息里
 * **连续的过程 run**（思考 / 工具调用）折成一块 —— 正文文本把它们切开，块内的顺序保持原样。
 *
 * 头部 = 总名（`使用 N 个工具`）+ chevron，**没有图标槽**（§0.3「总标题 = 图标 + 摘要」已推翻）。
 * 开合策略（§0.3 #1 定案）：进行中展开（full）、这一轮跑完自动收起、用户手动点过听用户的、
 * 有待审批步骤强制展开（且不画箭头）；开合状态只存在组件内存里，**不持久化**。
 *
 * 等审批的 part 由审批卡接管（接不到决策回调时退回静态工具行）；审批卡本身即"强制展开的
 * 展开体"，不另画步骤行（避免行头与卡头两遍工具名）。
 */
export interface TraceBlockEntry {
  part: UIMessage['parts'][number]
  /** 这一条是消息里最后一条可渲染内容且轮次还在流式（思考行据此显示"思考中…"） */
  streaming: boolean
}

export interface TraceBlockProps {
  entries: TraceBlockEntry[]
  /** 这一轮还在流式（进行中 → 默认展开；跑完自动收起） */
  running: boolean
  workspaces?: readonly Workspace[]
  onApprovalDecision?: (request: ApprovalRequest, decision: ApprovalDecision) => void
}

export function TraceBlock({
  entries,
  running,
  workspaces,
  onApprovalDecision
}: TraceBlockProps): React.JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null)

  const toolCount = entries.filter((entry) => isToolPart(entry.part)).length
  /** 有待审批步骤：强制展开，且头部不画箭头（用户不能把等审批的块收掉） */
  const forced =
    onApprovalDecision !== undefined &&
    entries.some((entry) => approvalRequestOf(entry.part) !== null)
  const open = forced || (override ?? running)
  const title = toolCount > 0 ? `使用 ${toolCount} 个工具` : '思考过程'

  return (
    <div data-testid="trace-block" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        data-testid="trace-toggle"
        data-running={running ? 'true' : undefined}
        data-forced={forced ? 'approval' : undefined}
        aria-expanded={open}
        aria-disabled={forced ? true : undefined}
        onClick={() => {
          if (!forced) setOverride(!open)
        }}
        className={cn(
          'group/row flex min-h-6 w-full items-center gap-2 text-left text-c1 text-ink-secondary',
          !forced &&
            'cursor-pointer transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none'
        )}
      >
        <span className={cn('shrink-0', running && 'trace-live')}>{title}</span>
        {forced ? null : (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
              open && 'rotate-90'
            )}
          />
        )}
      </button>

      <TraceFold open={open}>
        <div className="flex flex-col gap-3 pt-3">
          {entries.map((entry, index) => {
            const part = entry.part
            if (part.type === 'reasoning') {
              return (
                <ReasoningPart
                  key={`reasoning-${index}`}
                  text={part.text}
                  streaming={entry.streaming}
                />
              )
            }
            const approval = approvalRequestOf(part)
            if (approval !== null && onApprovalDecision !== undefined) {
              return (
                <ApprovalCard
                  key={`approval-${index}`}
                  request={approval}
                  workspaces={workspaces ?? []}
                  onDecide={(decision) => onApprovalDecision(approval, decision)}
                />
              )
            }
            const tool = toToolCardPart(part)
            if (tool === null) return null
            return (
              <ToolCard
                key={`tool-${index}`}
                part={tool}
                running={running && toolStateRunning(tool.state)}
              />
            )
          })}
        </div>
      </TraceFold>
    </div>
  )
}
