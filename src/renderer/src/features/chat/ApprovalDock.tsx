import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import type { Workspace } from '@shared/settings'
import { ApprovalCard, type ApprovalDecision } from './ApprovalCard'
import type { ApprovalRequest } from './approval'

/**
 * 审批条（round 29，用户口径）：**所有待审批都出现在输入框正上方**（composer 停靠区、
 * 主列宽度内、与输入卡同宽），不再让人在消息流的工具链上点「允许」。
 *
 * 数据源只有一处：当前会话里 `state='approval-requested'` 的工具 part（live 来自流式消息；
 * 重开/重启场景来自 message-map 从存储 `metadata.pendingToolApprovals` 复原的同形态 part）。
 * 同一步多个挂起 → 多条堆叠，逐个处理。
 *
 * 决策仍走既有唯一路径（`onDecide` → ChatPage.decideApproval → addToolApprovalResponse →
 * canResumeAfterApproval 自动续跑）——这里不自造第二套判定。
 *
 * 动效（用户雷点：不许闪现/硬切），两层都在 DOM 里跑、不做条件渲染硬切：
 *   1. 停靠区本身 = 常驻的 grid 容器，`grid-template-rows: 0fr ↔ 1fr` 双向过渡 —— 审批出现时
 *      整块从 0 高度撑开（输入框是平滑下移的，不是被顶下去），全部处理完再收回；
 *   2. 单条 = 决策后先不摘，跑完收缩（0fr）+ 淡出（opacity/translate），超时再真正移除，
 *      于是下面的条目是滑上来的，而不是被硬拽下去。
 * 时长取 --motion-main（.3s）那一档；reduced-motion 下过渡整档停掉（全局兜底 + motion-reduce:）。
 */
export interface ApprovalDockProps {
  /** 当前挂起的审批（顺序即展示顺序） */
  requests: readonly ApprovalRequest[]
  /** 渲染端那份被授权的工作区列表（卡片判记忆粒度用） */
  workspaces: readonly Workspace[]
  onDecide: (request: ApprovalRequest, decision: ApprovalDecision) => void
}

/** 单条退场时长，与 --motion-main（.3s）同一档；JS 侧只能写数字，改 token 时这里要一起看 */
const EXIT_MS = 300

export function ApprovalDock({
  requests,
  workspaces,
  onDecide
}: ApprovalDockProps): React.JSX.Element {
  /** 正在退场的条目（决策已发出、动画还没跑完）：渲染里继续留着，超时后摘掉 */
  const [leaving, setLeaving] = useState<readonly ApprovalRequest[]>([])
  /**
   * 当前渲染的条目 id 顺序（含位置）。上层决策回灌后会把那条从 requests 里摘掉，
   * 于是"它原来排第几"只剩这份本地快照知道 —— 退场的条目留在原位收高度，
   * 下面的条目才是顺着往上滑的（而不是被硬拽上去）。
   * 这是 React 文档认可的"按 props 调整 state"写法：渲染期间条件 setState，
   * 本次渲染作废、React 立刻用新值重渲染一次（同 TraceFold 的 everOpened）。
   */
  const [shown, setShown] = useState<readonly string[]>([])

  const decide = (request: ApprovalRequest, decision: ApprovalDecision): void => {
    setLeaving((previous) =>
      previous.some((item) => item.approvalId === request.approvalId)
        ? previous
        : [...previous, request]
    )
    // 不给这个定时器做卸载清理：会话切走把组件卸掉时那一次 setState 是空操作（React 18 起不
    // 再告警），留着反而能让"切走 → 立刻切回"的条目接着把动画跑完
    window.setTimeout(() => {
      setLeaving((previous) => previous.filter((item) => item.approvalId !== request.approvalId))
    }, EXIT_MS)
    onDecide(request, decision)
  }

  // 退场只认"上层已收回、这里还留着"的那几条：上层这一刻还列着的，就照常按正常态画
  // （决策回灌是异步的，回灌失败时条目会原样留在原地，而不是先缩掉再弹回来）
  const leavingItems = leaving.filter(
    (item) => !requests.some((request) => request.approvalId === item.approvalId)
  )
  const leavingIds = new Set(leavingItems.map((item) => item.approvalId))
  const byId = new Map<string, ApprovalRequest>(
    [...requests, ...leavingItems].map((item) => [item.approvalId, item])
  )
  const nextShown: string[] = []
  for (const id of shown) if (byId.has(id)) nextShown.push(id)
  for (const id of byId.keys()) if (!nextShown.includes(id)) nextShown.push(id)
  if (nextShown.length !== shown.length || nextShown.some((id, index) => id !== shown[index])) {
    setShown(nextShown)
  }
  const items = shown.flatMap((id) => {
    const item = byId.get(id)
    return item === undefined ? [] : [item]
  })
  const open = items.length > 0

  return (
    <div
      data-testid="approval-dock"
      data-open={open ? 'true' : 'false'}
      className={cn(
        'grid transition-[grid-template-rows] duration-(--motion-main) ease-main motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {/* 条目之间不用 flex gap：间距挂进"会折叠的那块"里，退场时跟着高度一起收掉，
            否则最后一条摘掉时剩余条目会被 gap 消失拽着跳 8px（末段硬切，用户雷点 5） */}
        <div className="mx-auto flex w-full max-w-(--chat-input-max-width) flex-col pb-2">
          {items.map((request) => {
            const isLeaving = leavingIds.has(request.approvalId)
            return (
              <div
                key={request.approvalId}
                data-testid="approval-dock-item"
                data-leaving={isLeaving ? 'true' : undefined}
                className={cn(
                  'grid transition-[grid-template-rows] duration-(--motion-main) ease-main motion-reduce:transition-none',
                  isLeaving ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                )}
              >
                <div
                  className={cn(
                    'min-h-0 overflow-hidden pb-2 transition-[opacity,transform] duration-(--motion-main) ease-main motion-reduce:transition-none',
                    isLeaving && '-translate-y-1 opacity-0'
                  )}
                >
                  <ApprovalCard
                    request={request}
                    workspaces={workspaces}
                    onDecide={(decision) => decide(request, decision)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
