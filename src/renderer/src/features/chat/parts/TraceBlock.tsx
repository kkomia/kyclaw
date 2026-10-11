import { useState } from 'react'
import type { UIMessage } from 'ai'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { approvalRequestOf } from '../approval'
import { ReasoningPart } from './ReasoningPart'
import { ToolCard } from './ToolCard'
import { isToolPart, toToolCardPart, toolStateRunning } from './tool-part'
import { TraceFold } from './TraceFold'

/**
 * 过程块（round 6，对照《对话UI-工具链与显示口径 v0.1》§1.1/§1.3）：一条助手消息里
 * **连续的过程 run**（思考 / 工具调用）折成一块 —— 正文文本把它们切开，块内的顺序保持原样。
 *
 * 头部 = 总名（`使用 N 个工具`）+ chevron，**没有图标槽**（§0.3「总标题 = 图标 + 摘要」已推翻）。
 * 开合策略（§0.3 #1 定案；round 29 修订）：进行中展开（full）、这一轮跑完自动收起、
 * 用户手动点过听用户的；**有待审批步骤也走"默认展开"这一档，但不再是锁死的强展开** ——
 * round 29 把审批搬到了输入框上方的审批条，块里只剩只读的「等待审批」状态行，没有理由再
 * 剥掉用户的折叠自由（也不再让头部缺箭头）。开合状态只存在组件内存里，**不持久化**。
 *
 * 等审批的 part 走普通工具行（ToolCard 的 `approval-requested` → 「等待审批」），
 * **块内不再有任何审批按钮** —— 决策入口只有一个：输入框上方的 ApprovalDock。
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
}

export function TraceBlock({ entries, running }: TraceBlockProps): React.JSX.Element {
  const [override, setOverride] = useState<boolean | null>(null)

  const toolCount = entries.filter((entry) => isToolPart(entry.part)).length
  /** 这一步里还挂着等审批的调用：默认展开，让用户看得见"卡在哪一步"（点一下照样能收） */
  const pending = entries.some((entry) => approvalRequestOf(entry.part) !== null)
  const open = override ?? (running || pending)
  const title = toolCount > 0 ? `使用 ${toolCount} 个工具` : '思考过程'

  return (
    <div
      data-testid="trace-block"
      data-open={open ? 'true' : 'false'}
      data-pending={pending ? 'true' : undefined}
    >
      <button
        type="button"
        data-testid="trace-toggle"
        data-running={running ? 'true' : undefined}
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="group/row flex min-h-6 w-full cursor-pointer items-center gap-2 text-left text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none"
      >
        <span className={cn('shrink-0', running && 'trace-live')}>{title}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
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
                  // 这一轮没跑完就保持展开：思考段后面跟着工具行时 entry.streaming 已翻 false，
                  // 靠它撑住"工具调用之间的思考段可见"（round 29）
                  live={running}
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
