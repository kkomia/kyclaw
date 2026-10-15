import { Wrench } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useWorkbenchRoot } from '@renderer/features/workbench/use-workbench-root'
import { formatToolName } from '@shared/mcp'
import type { Workspace } from '@shared/settings'
import {
  approvalDetailOf,
  approvalRiskOf,
  approvalScopeNote,
  isDangerousTool,
  resolveApprovalWorkspace,
  type ApprovalRequest
} from './approval'
import { approvalDiff, type DiffLine } from './approval-diff'
import { displayPath } from './display-path'

/**
 * 审批条上的单条（T13；round 29 位置迁移）：写类工具在 ask 工作区里要用户决策时出现。
 *
 * 位置（round 29，用户口径）：不再画在消息流的工具链上，由 ApprovalDock 折进**输入框正上方**
 * 的审批条里（同一步多个挂起 → 多条堆叠）。卡片自身只管"在批什么 + 怎么决策"，停靠与退场
 * 动效归 ApprovalDock。
 *
 * 卡的内容 = 工具名 + 目标（path；bash 加命令、fetch 加 URL、move 加目标位置）+ 行级 diff +
 * 按钮：
 *   - 允许一次：只放行这一次调用；
 *   - 本会话允许：这次会话里同工具 + 同工作区不再打扰（内存，不落盘）；
 *   - 永久允许：写成设置里的规则（settings.permissions.rules），重启后仍生效；
 *   - 拒绝：这次调用不执行（模型会拿到拒绝继续）。
 * round 75 起卡片还会写一行**为什么会问**（`approvalScopeNote`）：服务端按"目标落在哪个区"判
 * （区内的 full 工作区免审、区外按「工作区之外」那一档），用户在卡上就能看出这次批的是哪一档。
 * 「本会话/永久允许」两个记忆入口只在**工作区判得出、且没踩区外**时才给（round 76 起对
 * delete/move 与其它写类一视同仁 —— 用户口径"允许就是永久允许"：能点就真的会生效）：
 *   - 工作区判不出（bash 按 cwd、fetch 按 save_to 判；都没有且授权列表不止一条就判不出）→
 *     放行范围说不清，只给"允许一次 / 拒绝"；
 *   - 区外的目标（`approvalRiskOf` 命中）→ 隐藏：规则绑的是"某个工作区"，区外的目标绑不上，
 *     卡片改用它上方那行话说清"按区外档判"。
 * round 76 之前 delete/move 走的是另一条（隐藏入口，口头解释是"它们的授权走工作区档位"）——
 * 那条已按用户口径撤掉：这两个工具的规则同样是 (工具 × 工作区)，服务端 gate 一直就吃它。
 *
 * 展示形状与工具卡同一族（圆角面板 + 一条 hairline），diff 区用底色分层、不再套第二层框线（雷点 7）。
 * 行级 diff 的 +/- 用 --Colors-DiffAdd / --Colors-DiffDelete（经 semantic 的 --diff-add / --diff-delete）。
 *
 * round 86（用户实报 013 的后半）：目标路径按**展示口径**收成工作区相对路径（`displayPath`，与工具卡
 * 同一份实现、同一份会话根）——整条绝对路径铺在卡片上太长。**绝对路径不丢**：那一行本来就有
 * tooltip 挂着原文，判"到底动哪个文件"时鼠标一停就看得见；根外 / 判不出根则原样显示绝对路径
 * （与工具卡同一口径：`display-path.ts` 只做展示，模型看到的入参一个字不动）。
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
  edit: '编辑文件',
  // 模块 4：产出物五件（写类，与 write 同档审批）
  create_report: '生成报告',
  create_pdf: '导出 PDF',
  create_excel: '生成 Excel',
  // 增量改已有的一份表格（与 create_excel 同一族，命名照上面的动词口径）
  edit_excel: '修改 Excel',
  create_ppt: '生成 PPT',
  // round 76：改已有的一份演示文稿（与 create_ppt 同一族，命名照上面的动词口径）
  edit_ppt: '修改 PPT',
  create_docx: '生成 Word',
  // 增量改已有的一份 Word 文档（与 create_docx 同一族，命名照上面的动词口径）
  edit_docx: '修改 Word'
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
  const workspace = resolveApprovalWorkspace(request.input, workspaces, request.toolName)
  const detail = approvalDetailOf(request.toolName, request.input)
  // round 75：目标是不是落在工作区外 / 命令形态落不到工作区里（服务端按区外档判的那一类）
  const risk = approvalRiskOf(request.input, workspaces)
  // 记忆入口的两个条件（round 76 起对所有工具一视同仁，含 delete/move）：
  // 工作区判得出 + 没踩区外（区外的目标绑不上某个工作区，规则也就无从写下）
  const rememberable = workspace !== null && risk === null
  const destructive = isDangerousTool(request.toolName)
  const diff = approvalDiff(request.toolName, request.input)
  // 与 ToolCard 一致（round 14）：MCP 工具显示「服务名 · 工具名」，认不出回落原样
  const mcpServers = useSettingsStore((state) => state.settings.mcpServers)
  const outsideMode = useSettingsStore((state) => state.settings.outsideWorkspaceMode)
  const scope = approvalScopeNote(request.input, request.toolName, workspaces, outsideMode)
  const title =
    TOOL_LABELS[request.toolName.toLowerCase()] ?? formatToolName(request.toolName, mcpServers)
  /**
   * 目标路径的显示（round 86，013）：会话根内 → 工作区相对路径；根外 / 判不出根 → 原样。
   * 会话根与工具卡 / 文件树 / 附件同一个来源（`useWorkbenchRoot` 读的是 `sessionRootPathOf` 那份真根），
   * 转换本身也只有一条实现（`displayPath` → `relativeInRoot`）。绝对路径留在 tooltip 里。
   */
  const { rootPath } = useWorkbenchRoot()
  const shownPath = request.path === null ? null : displayPath(request.path, rootPath)

  return (
    <div
      data-testid="approval-card"
      data-tool={request.toolName}
      data-workspace={workspace ?? ''}
      role="group"
      aria-label={`${title}：等待审批`}
      className="animate-message-in flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-surface-border bg-secondary px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
        <span className="text-b2 text-ink">{title}</span>
        <span className="ml-auto rounded-badge bg-(--fill-selected) px-1.5 py-0.5 text-c2 text-warning">
          等待审批
        </span>
      </div>

      {shownPath === null ? null : (
        // tooltip 里始终是**绝对路径原文**（决策面：到底动哪个文件）；卡面上是收窄后的相对路径
        <Tooltip label={request.path ?? ''} side="bottom" align="start">
          <span
            data-testid="approval-target"
            tabIndex={0}
            className="min-w-0 truncate rounded-button-sm font-mono text-c1 text-ink-secondary"
          >
            {shownPath}
          </span>
        </Tooltip>
      )}

      {detail === null ? null : (
        <pre
          data-testid="approval-detail"
          data-kind={detail.kind}
          className="max-h-40 overflow-auto rounded-control bg-surface px-2 py-1 font-mono text-c1 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]"
        >
          {detail.kind === 'move-to' ? `→ ${detail.text}` : detail.text}
        </pre>
      )}

      {scope === null && !(destructive && rememberable) ? null : (
        <p
          data-testid="approval-scope"
          data-kind={risk?.code ?? 'workspace-ask'}
          className="rounded-control bg-(--fill-selected) px-2 py-1 text-c1 text-warning"
        >
          {scope}
          {destructive && rememberable ? (
            <>
              {scope === null ? null : ' '}
              点击永久允许后，此工具在当前工作区内的后续操作不再逐次询问；仅放行此工具，工作区之外仍按区外权限处理。
            </>
          ) : null}
        </p>
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
        {rememberable ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="approval-allow-session"
            onClick={() => onDecide('session')}
          >
            本会话允许
          </Button>
        ) : null}
        {rememberable ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="approval-allow-forever"
            onClick={() => onDecide('forever')}
          >
            永久允许
          </Button>
        ) : null}
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
