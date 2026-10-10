import { Wrench } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Tooltip } from '@renderer/components/ui/tooltip'
import type { Workspace } from '@shared/settings'
import { resolveApprovalWorkspace, type ApprovalRequest } from './approval'
import { approvalDiff, type DiffLine } from './approval-diff'

/**
 * 审批卡（T13）：写类工具在 ask 工作区里弹出，给用户四个决策。
 *
 * 卡的内容 = 工具名 + 目标路径 + 行级 diff + 四个按钮：
 *   - 允许一次：只放行这一次调用；
 *   - 本会话允许：这次会话里同工具 + 同工作区不再打扰（内存，不落盘）；
 *   - 永久允许：写成设置里的规则（settings.permissions.rules），重启后仍生效；
 *   - 拒绝：这次调用不执行（模型会拿到拒绝继续）。
 * 目标工作区判不出来时（只存在于没有 path 的外部工具）不给"本会话/永久允许"入口 ——
 * 那种情况下放行范围说不清，保守地只给"允许一次 / 拒绝"。
 *
 * 展示形状与工具卡同一族（圆角面板 + 一条 hairline），diff 区用底色分层、不再套第二层框线（雷点 7）。
 * 行级 diff 的 +/- 用 --Colors-DiffAdd / --Colors-DiffDelete（经 semantic 的 --diff-add / --diff-delete）。
 */
export type ApprovalDecision = 'once' | 'session' | 'forever' | 'deny'

export interface ApprovalCardProps {
  request: ApprovalRequest
  /** 渲染端那份被授权的工作区列表（判记忆粒度用） */
  workspaces: readonly Workspace[]
  onDecide: (decision: ApprovalDecision) => void
}

/** 工具名 → 卡片标题（认不出就用工具名本身，不猜） */
const TOOL_LABELS: Record<string, string> = {
  write: '写入文件',
  edit: '编辑文件'
}

const LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add/10 text-diff-add',
  remove: 'bg-diff-delete/10 text-diff-delete',
  context: 'text-ink-secondary',
  gap: 'text-ink-tertiary'
}

const LINE_MARKER: Record<DiffLine['kind'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
  gap: '…'
}

export function ApprovalCard({
  request,
  workspaces,
  onDecide
}: ApprovalCardProps): React.JSX.Element {
  const workspace = resolveApprovalWorkspace(request.input, workspaces)
  const diff = approvalDiff(request.toolName, request.input)
  const title = TOOL_LABELS[request.toolName.toLowerCase()] ?? request.toolName

  return (
    <div
      data-testid="approval-card"
      data-tool={request.toolName}
      data-workspace={workspace ?? ''}
      role="group"
      aria-label={`${title}：等待审批`}
      className="animate-message-in flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline bg-secondary px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
        <span className="text-b2 text-ink">{title}</span>
        <span className="ml-auto rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-warning">
          等待审批
        </span>
      </div>

      {request.path === null ? null : (
        <Tooltip label={request.path} side="bottom" align="start">
          <span
            data-testid="approval-target"
            tabIndex={0}
            className="min-w-0 truncate rounded-button-sm font-mono text-c1 text-ink-secondary"
          >
            {request.path}
          </span>
        </Tooltip>
      )}

      {diff === null || diff.length === 0 ? null : (
        <div
          data-testid="approval-diff"
          className="max-h-64 overflow-auto rounded-control bg-surface py-1"
        >
          {diff.map((line, index) => (
            <div
              key={`${index}-${line.kind}`}
              data-testid="approval-diff-line"
              data-kind={line.kind}
              className={cn(
                'flex min-h-5 gap-2 px-2 font-mono text-c1 leading-5',
                LINE_CLASS[line.kind]
              )}
            >
              <span aria-hidden="true" className="w-2 shrink-0 select-none opacity-70">
                {LINE_MARKER[line.kind]}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{line.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="approval-allow-once" onClick={() => onDecide('once')}>
          允许一次
        </Button>
        {workspace === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="approval-allow-session"
            onClick={() => onDecide('session')}
          >
            本会话允许
          </Button>
        )}
        {workspace === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="approval-allow-forever"
            onClick={() => onDecide('forever')}
          >
            永久允许
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="approval-deny"
          className="ml-auto"
          onClick={() => onDecide('deny')}
        >
          拒绝
        </Button>
      </div>
    </div>
  )
}
