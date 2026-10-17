import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AtSign,
  ChevronDown,
  Compass,
  ListChecks,
  Paperclip,
  Plug,
  Plus,
  Shield,
  ShieldAlert,
  Sparkles,
  TextQuote,
  X,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { COMPACT_CHIP_PCT } from '@renderer/lib/compact'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { PendingImageTile } from './PendingImageTile'
import { ThinkingEffort } from './ThinkingEffort'
import {
  contextTokensFor,
  contextWindowOf,
  displayNameOf,
  effectiveEffortId,
  formatTokens,
  isProbedFresh,
  overrideKeyOf,
  probedKeyOf,
  thinkingEffortsOf,
  visionOf
} from '@shared/models'
import type { ModelOverride, ProbedModelSpec } from '@shared/models'
import type { Workspace, WorkspaceMode } from '@shared/settings'
import type { UsageThreadContext } from '@shared/usage'
import { providerLabel, registeredModelsOf } from '@shared/providers'
import { formatBytes } from './composer-attachments'
import type { PendingAttachment } from './composer-attachments'
import { PLAN_ENTER_LABEL } from './plan-ui'
import type { ReferenceKind } from './reference-markers'

/**
 * Composer 的控件族（round 7，用户实拍 #10 图4/图5/图7/图8/图10）：
 *   - `PlusMenu`：＋菜单（添加文件 / 引用技能▸ / 引用插件▸ / 引用上下文 / 模式分组）——「引用技能」列
 *     `plugins:overview` 的技能清单（round 64 起内置技能也在这一份里）；子菜单只给名字、不写归属，
 *     归属与分组在插件页的「技能」面板里（免得把内置技能说成「来自插件」）；
 *     round 81：**「进入规划模式」与「任务清单」也收进这一个 ＋**（原先是工具条上两颗常驻按钮）——
 *     不另造第二个模式菜单，权限 chip 照旧留在工具条上；
 *   - `PermissionChip`：权限两档（每次询问 / 完全访问）——**只走引擎既有两档**，
 *     放开方向（full）沿用设置页那套确认框语义；写走 `workspace:set-mode` 通道（不弱化 T13）；
 *     round 13：无描边（hover / 展开只铺灰底），「完全访问」用时警示色 + ShieldAlert（不走对勾图标）；
 *     用户实报（"聊天页面 composer 的权限模式选择按钮不见了"）：**入口永远在** —— 判不出工作区时
 *     不再整块换成另一个链接，而是同一枚 chip + 同一个下拉（菜单里说明 + 一条去设置的真动作）；
 *   - `ContextChip`：上下文环（round 42 二轮从 ModelChip 里拆出来的**独立组件**）——环自己点了开明细卡、
 *     hover 也出同一张卡；与模型名只是相邻，不共用按钮；round 57 起用量 ≥ 80% 时环左边多一枚
 *     「压缩上下文」胶囊（同层兄弟，点即压缩，不用在输入框里打 `/`）；
 *   - `ModelChip`：模型切换（只列 T8 已配置的 provider，含 isDefault 语义；不带小字说明）；
 *     弹层 = 模型列表 + 思考强度 + 对话长度（round 42 二轮起**不含**上下文明细）；
 *   - `PendingChips`：附件 / 引用卡行（可移除；round 42 二轮的摘选是「引用卡」）。
 * 图标按钮 hover 铺灰底（Fills-F1）= 图10 口径；不给说明性小字（雷点 2）。
 */
export interface ComposerNotice {
  tone: 'danger' | 'warning' | 'success'
  text: string
}

/** 图标按钮（composer 内统一形态：32px、**圆形** hover 底 —— round 15 用户实拍：不要圆角方框） */
const ICON_TRIGGER_CLASS =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none'

/** 视觉模型在模型菜单里的小标记（模块 2：自绘、不解释后端——它只是"这个模型能看图"的事实标记） */
const VISION_MARK = '看图'

export interface PlusMenuProps {
  onAddFile: () => void
  /** 选中一条引用：调用方把标记**插到输入框光标处**（round 14；不是顶上挂 chip） */
  onReference: (reference: { kind: ReferenceKind; label: string }) => void
  /** 「引用上下文」的标签（当前工作区目录名）；null = 判不出 → 该条禁用 */
  contextLabel: string | null
  /** 可引用的插件（已启用的 MCP server；空列表时菜单里给一条禁用说明） */
  plugins: ReadonlyArray<{ id: string; name: string }>
  /**
   * 可引用的技能（`plugins:overview` 的 installedSkills：**内置与插件一份清单**，round 64 起内置的
   * office 四件套也在里面；空列表时菜单里给一条禁用说明）。子菜单只列名字——归属与分组在插件页的
   * 「技能」面板里给，这里不写，内置技能就不会被说成「来自插件」。
   */
  skills: ReadonlyArray<{ dir: string; name: string }>
  /**
   * 打开菜单时拉一次数据（技能的可用状态可能在别处刚变过；挂载时另有一次，见 Composer）
   */
  onOpenMenu?: () => void
  /**
   * 模式分组的条目（round 81：常驻的模式按钮收进这一个 ＋ 菜单，不另造第二个模式菜单）。
   * 缺省 / null = 这一挂没有模式入口（会话实例未就绪、权限通道缺失等），菜单里连分组都不出现。
   */
  mode?: ComposerModeMenu | null
}

export interface ComposerModeMenu {
  /** 「进入规划模式」：null = 不给这条（未就绪 / 已在规划模式中）；`disabled` = 正在运行、按不动 */
  plan: { disabled?: boolean; onSelect: () => void } | null
  /** 「任务清单」开合：`expanded` 决定文案是「任务清单」还是「收起任务清单」 */
  tasks: { expanded: boolean; onSelect: () => void } | null
}

export function PlusMenu({
  onAddFile,
  onReference,
  contextLabel,
  plugins,
  skills,
  onOpenMenu,
  mode = null
}: PlusMenuProps): React.JSX.Element {
  const items: MenuEntry[] = [
    {
      id: 'add-file',
      label: '添加文件',
      description: '上传图片、PDF 或文本附件',
      icon: <Paperclip />,
      testId: 'composer-add-file',
      onSelect: () => onAddFile()
    },
    { id: 'sep-1', type: 'separator' },
    {
      id: 'skills',
      type: 'submenu',
      label: '引用技能',
      description: '把已安装技能作为上下文引用',
      icon: <Sparkles />,
      testId: 'composer-ref-skills',
      items:
        skills.length === 0
          ? [{ id: 'empty', label: '还没有可引用的技能', disabled: true }]
          : skills.map((skill) => ({
              id: skill.dir,
              label: skill.name,
              testId: `composer-ref-skill-${skill.dir}`,
              onSelect: () => onReference({ kind: '技能', label: skill.name })
            }))
    },
    {
      id: 'plugins',
      type: 'submenu',
      label: '引用插件',
      description: '把已启用插件的说明带进这一轮',
      icon: <Plug />,
      testId: 'composer-ref-plugins',
      items:
        plugins.length === 0
          ? [{ id: 'empty', label: '没有已启用的插件', disabled: true }]
          : plugins.map((plugin) => ({
              id: plugin.id,
              label: plugin.name,
              testId: `composer-ref-plugin-${plugin.id}`,
              onSelect: () => onReference({ kind: '插件', label: plugin.name })
            }))
    },
    {
      id: 'context',
      label: '引用上下文',
      description: contextLabel === null ? '当前没有可引用的上下文' : contextLabel,
      icon: <AtSign />,
      testId: 'composer-ref-context',
      disabled: contextLabel === null,
      onSelect: () => {
        if (contextLabel !== null) onReference({ kind: '上下文', label: contextLabel })
      }
    }
  ]

  // round 81：模式分组收尾（独立分组，与附件/引用分开）——只有真有条目时才铺分隔线，
  // 免得未就绪的那一挂里菜单末尾挂一条孤零零的分隔线。
  if (mode !== null && (mode.plan !== null || mode.tasks !== null)) {
    items.push({ id: 'sep-mode', type: 'separator' })
    if (mode.plan !== null) {
      items.push({
        id: 'plan',
        label: PLAN_ENTER_LABEL,
        icon: <Compass />,
        description: '先出计划、批准后再动手',
        testId: 'composer-mode-plan',
        disabled: mode.plan.disabled,
        onSelect: () => mode.plan?.onSelect()
      })
    }
    if (mode.tasks !== null) {
      items.push({
        id: 'tasks',
        label: mode.tasks.expanded ? '收起任务清单' : '任务清单',
        icon: <ListChecks />,
        description: mode.tasks.expanded ? '把任务清单收进过程块' : '展开本轮任务进度',
        testId: 'composer-mode-tasks',
        onSelect: () => mode.tasks?.onSelect()
      })
    }
  }

  return (
    <Menu
      trigger={
        <button
          type="button"
          data-testid="composer-plus"
          aria-label="添加或引用"
          className={ICON_TRIGGER_CLASS}
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      }
      tooltip="上传文件和更多工具"
      items={items}
      side="top"
      align="start"
      onOpenChange={(open) => {
        if (open) onOpenMenu?.()
      }}
    />
  )
}

export interface PermissionChipProps {
  /**
   * 当前会话的工作区条目（授权列表里那条）。**null = 判不出**（没有授权工作区 / 多个并列且没
   * 指认默认 / 会话项目的文件夹不在列表里）。
   */
  workspace: Workspace | null
  /** `workspace` 为 null 时下拉里那句原因（为什么现在切不了；去哪儿看菜单里那条动作） */
  reason?: string
  onNotice: (notice: ComposerNotice | null) => void
}

const MODE_LABELS: Record<WorkspaceMode, string> = {
  ask: '每次询问',
  full: '完全访问'
}

/**
 * chip 触发器（两档 chip 与"判不出"那一档**同一个妆**）：h-8、无描边、hover / 展开只铺灰底、
 * 「完全访问」用警示色。两处共用一份，免得"判不出"那档长得像另一个东西。
 */
function permissionTriggerClass(full: boolean): string {
  return cn(
    'inline-flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-control px-2 text-b2 transition-colors duration-(--motion-fast) ease-main hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none',
    full ? 'text-warning' : 'text-ink-secondary hover:text-ink data-[state=open]:text-ink'
  )
}

/**
 * 判不出工作区的那一档（用户实报"权限模式选择按钮不见了"）：入口**不再整块换成别的链接**，
 * 还是同一枚 chip + 同一个下拉。但菜单里不摆可点的档位 —— 目标都没定下来，"切换"无从谈起
 * （切了也不知道在切谁，这正是原实现把入口藏起来的理由）。这里改成**说明 + 指路**：
 * 一句为什么，加一条去设置里指认工作区的真动作 —— 不造假档位，也不让入口静默消失。
 */
function UndecidedPermissionChip({ reason }: { reason: string }): React.JSX.Element {
  return (
    <Menu
      trigger={
        <button
          type="button"
          data-testid="composer-permission"
          className={permissionTriggerClass(false)}
        >
          <Shield aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">权限模式</span>
        </button>
      }
      items={[
        {
          id: 'undecided',
          type: 'custom',
          content: (
            <p
              data-testid="composer-permission-reason"
              className="max-w-52 px-1 text-c1 text-ink-secondary"
            >
              {reason}
            </p>
          )
        },
        { id: 'sep', type: 'separator' },
        {
          id: 'workspace-settings',
          label: '打开工作区设置',
          testId: 'composer-workspace-settings',
          onSelect: () => {
            window.location.hash = '#/settings/workspaces'
          }
        }
      ]}
      side="top"
      align="start"
      tooltip="切换权限模式"
    />
  )
}

/**
 * 权限入口（**永远在**）：判得出工作区 = 两档 chip（每次询问 / 完全访问，写走 `workspace:set-mode`）；
 * 判不出 = 同一枚妆的「权限模式」chip，下拉里只说明 + 指路（见 `UndecidedPermissionChip`）。
 */
export function PermissionChip({
  workspace,
  reason = '会话的工作区还没定下来',
  onNotice
}: PermissionChipProps): React.JSX.Element {
  if (workspace === null) return <UndecidedPermissionChip reason={reason} />
  return <DecidedPermissionChip workspace={workspace} onNotice={onNotice} />
}

function DecidedPermissionChip({
  workspace,
  onNotice
}: {
  workspace: Workspace
  onNotice: (notice: ComposerNotice | null) => void
}): React.JSX.Element {
  const setWorkspaceMode = useSettingsStore((state) => state.setWorkspaceMode)
  const [pending, setPending] = useState(false)
  /** 等确认切到「完全访问」（null = 没有确认框） */
  const [confirming, setConfirming] = useState(false)

  const apply = (mode: WorkspaceMode): void => {
    setPending(true)
    onNotice(null)
    setWorkspaceMode(workspace.path, mode).then(
      () => setPending(false),
      (error: unknown) => {
        setPending(false)
        onNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
      }
    )
  }

  const items: MenuEntry[] = [
    {
      id: 'ask',
      label: MODE_LABELS.ask,
      description: '工作区的写操作每次先问你',
      selected: workspace.mode === 'ask',
      testId: 'composer-permission-ask',
      onSelect: () => {
        if (workspace.mode !== 'ask') apply('ask')
      }
    },
    {
      id: 'full',
      label: MODE_LABELS.full,
      description: '工作区内读写不再逐次询问（移动/删除仍确认）',
      selected: workspace.mode === 'full',
      testId: 'composer-permission-full',
      onSelect: () => {
        // 放开方向先确认（与设置页「完全访问」同一套语义）；收紧方向直切
        if (workspace.mode !== 'full') setConfirming(true)
      }
    }
  ]

  const full = workspace.mode === 'full'
  // 完全访问 = 警示态（round 13 用户实拍）：用 ShieldAlert（不要带对勾的 ShieldCheck）
  const Icon: LucideIcon = full ? ShieldAlert : Shield

  return (
    <>
      <Menu
        trigger={
          // 无描边的文字 chip（round 13 用户实拍：默认不要那个圆角框线；hover / 展开只铺灰底）。
          // 高度与 ＋ 按钮对齐（h-8）；「完全访问」的文字与图标用警示色。
          <button
            type="button"
            data-testid="composer-permission"
            disabled={pending}
            className={permissionTriggerClass(full)}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{MODE_LABELS[workspace.mode]}</span>
          </button>
        }
        items={items}
        side="top"
        align="start"
        tooltip="切换权限模式"
      />
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false)
        }}
        title="开启完全访问？"
        description={`「${workspace.path}」里的读写将不再逐次询问；移动与删除仍然会先问你。`}
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="composer-full-cancel"
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
            <Button
              data-testid="composer-full-confirm"
              onClick={() => {
                setConfirming(false)
                apply('full')
              }}
            >
              开启
            </Button>
          </>
        }
      />
    </>
  )
}

export interface ModelChipProps {
  onNotice: (notice: ComposerNotice | null) => void
}

/** 上下文环（round 18，图3）：16px 小环；超过阈值时整环转警示色（round 42 起是独立组件 ContextChip 的图标） */
function ContextRing({
  percent,
  warning
}: {
  percent: number
  warning: boolean
}): React.JSX.Element {
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      data-warning={warning ? 'true' : undefined}
      className="size-4 shrink-0 -rotate-90"
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-(--fill-active)"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        className={warning ? 'stroke-warning' : 'stroke-ink-secondary'}
      />
    </svg>
  )
}

/**
 * 上下文明细的取数口径（一处算、两处用：环 hover 的明细卡与环点开后的明细卡同源）：
 * 百分比与进度条跟上下文环同源（四舍五入、封顶 100），分解 = 已用 − 基线，
 * 缓存命中率 = 缓存输入 / 输入。**禁止**两处各算一套或各写一份文案。
 */
interface ContextStats {
  /** 已用百分比（环 / 卡 / 弹层同一口径） */
  usedPct: number
  /** 最近一轮输入 token（null = 没有这条会话的数据） */
  usedInput: number | null
  /** 当前对话长度档位换算出的阈值 token（≈ 总量） */
  windowTokens: number
  /** 已用 ≥ 阈值（整环 / 进度条 / 阈值行一起转警示） */
  overThreshold: boolean
  /** 系统提示词 + 工具定义的基线（null = 没有数据） */
  baseline: number | null
  /** 对话消息部分（= 已用 − 基线） */
  messageTokens: number | null
  /** 最近一轮缓存命中率 %（null = 没有数据） */
  lastHitRate: number | null
  /** 今日缓存命中率 %（null = 没有数据） */
  todayHitRate: number | null
  /** 压缩阈值（= 当前对话长度档位 %） */
  thresholdPct: number
}

/**
 * 上下文明细卡的正文（round 41）：环 hover 的卡与环点开后的卡共用同一份布局与文案（口径只此一份）。
 * 数据没到时给骨架占位——不闪一个假的 0% 出来（有过渡不硬切）。
 */
function ContextCardBody({
  stats,
  loading
}: {
  stats: ContextStats
  loading: boolean
}): React.JSX.Element {
  if (loading) {
    return (
      <div data-testid="context-loading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-1 w-full rounded-pill" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-b2">上下文已用 {stats.usedPct}%</span>
        <span className="text-c1 opacity-70 tabular-nums">
          ~{formatTokens(stats.usedInput ?? 0)} / {formatTokens(stats.windowTokens)}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-pill bg-(--fill-active)">
        <div
          className={cn(
            'h-full transition-[width] duration-(--motion-main) ease-main motion-reduce:transition-none',
            stats.overThreshold ? 'bg-warning' : 'bg-(--accent-text)'
          )}
          style={{ width: `${stats.usedPct}%` }}
        />
      </div>
      <div className="flex flex-col gap-0.5 text-c1 opacity-80">
        <span className="flex justify-between gap-3">
          <span>系统提示词 / 工具定义</span>
          <span className="tabular-nums">
            {stats.baseline === null ? '—' : `~${formatTokens(stats.baseline)}`}
          </span>
        </span>
        <span className="flex justify-between gap-3">
          <span>对话消息</span>
          <span className="tabular-nums">
            {stats.messageTokens === null ? '—' : `~${formatTokens(stats.messageTokens)}`}
          </span>
        </span>
      </div>
      <div className="flex justify-between gap-3 text-c1 opacity-80">
        <span>缓存命中率</span>
        <span className="tabular-nums">
          最近一轮 {stats.lastHitRate === null ? '—' : `${stats.lastHitRate}%`} · 今日{' '}
          {stats.todayHitRate === null ? '—' : `${stats.todayHitRate}%`}
        </span>
      </div>
      <div className="text-c1 opacity-60">
        阈值 {stats.thresholdPct}%{stats.overThreshold ? '（已超过）' : ''}
      </div>
    </div>
  )
}

/** 对话长度滑块（二级浮层里的自定义条目）：拖动时只改草稿，松手（或键盘抬手）才落盘 */
function ContextSlider({
  model,
  probed,
  override,
  pct,
  onCommit
}: {
  model: string
  /** round 22：该模型的实测元数据（probed 优先；没有就注册表） */
  probed?: ProbedModelSpec
  /** 用户反馈 003：该模型的手动覆盖（排在实测之前） */
  override?: ModelOverride
  pct: number
  onCommit: (pct: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(pct)
  // props 变了（落盘回来的值 / 换模型）就同步草稿：React 认可的"渲染期调整 state"写法
  const [lastPct, setLastPct] = useState(pct)
  if (pct !== lastPct) {
    setLastPct(pct)
    setDraft(pct)
  }
  const window = contextWindowOf(model, probed, override)
  return (
    <div data-testid="model-context-slider" className="flex w-56 flex-col gap-2">
      <div className="flex items-baseline justify-between text-c1">
        <span data-testid="model-context-pct" className="text-ink">
          {draft}%
        </span>
        <span className="text-ink-tertiary tabular-nums">
          ≈ {formatTokens(contextTokensFor(model, draft, probed, override))} /{' '}
          {formatTokens(window)}
        </span>
      </div>
      <input
        type="range"
        min={10}
        max={100}
        step={5}
        value={draft}
        aria-label="对话长度"
        data-testid="model-context-range"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={() => onCommit(draft)}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
            onCommit(draft)
          }
        }}
        className="h-1 w-full cursor-pointer accent-(--accent)"
      />
    </div>
  )
}

/**
 * 上下文明细的取数（round 42 二轮：从 ModelChip 里拆出来给独立的 `ContextChip` 用）。
 * 口径与 round 41 完全一致（`ContextCardBody` 那份数字），只是取数挪到环自己的组件里。
 *
 * round 57：多一个外部刷新信号 `usageVersion`（上层每轮结束 +1）—— 原来只有"挂载 + 换会话 +
 * 环菜单打开"才取数，轮结束不刷，环与「压缩上下文」按钮会停在上一轮的数字上。版本号只当
 * "该重取了"的信号（值本身不参与请求），换会话同样经由它重取。
 */
function useContextStats(
  threadId: string | null,
  usageVersion = 0
): {
  stats: ContextStats
  pending: boolean
  refresh: () => void
} {
  const providers = useSettingsStore((state) => state.settings.providers)
  const modelPrefs = useSettingsStore((state) => state.settings.modelPrefs)
  const probedModels = useSettingsStore((state) => state.settings.probedModels)
  const modelOverrides = useSettingsStore((state) => state.settings.modelOverrides)
  const [context, setContext] = useState<UsageThreadContext | null>(null)
  /** 取数失败的那条会话（服务没起来 / 还没记录）：没数据时不再给骨架，如实画 0% */
  const [failedThreadId, setFailedThreadId] = useState<string | null>(null)

  const current = providers.find((provider) => provider.isDefault) ?? providers[0]
  const pref = modelPrefs[current === undefined ? '' : `${current.id}/${current.model}`]
  // round 22：该模型的实测元数据（probed 优先；没有/字段缺就回落注册表）；
  // 用户反馈 003：手动覆盖排在最前面（override → probed → 注册表 → 默认）
  const probed =
    current === undefined ? undefined : probedModels[probedKeyOf(current.id, current.model)]
  const override =
    current === undefined ? undefined : modelOverrides[overrideKeyOf(current.id, current.model)]
  const pct = Math.min(100, Math.max(10, Math.round(pref?.contextPct ?? 100)))
  const windowTokens = contextTokensFor(current?.model, pct, probed, override)

  /** 最近一次发起的取数标识（会话 + 轮次号）：晚回的旧响应不许覆盖新一轮的数字 */
  const lastRequest = useRef('')
  const refresh = useCallback((): void => {
    if (threadId === null || threadId === '') return
    const request = `${threadId}\u0000${usageVersion}`
    lastRequest.current = request
    void fetchThreadContext(threadId).then(
      (next) => {
        if (lastRequest.current === request) setContext(next)
      },
      // 取不到（服务没起来 / 还没记录）：记下这条会话取不到，卡里如实画 0%，不打扰输入
      () => {
        if (lastRequest.current === request) setFailedThreadId(threadId)
      }
    )
  }, [threadId, usageVersion])
  // 挂载 / 换会话 / 每轮结束（usageVersion 变）= 上面那个 refresh 换新 → 重取一次
  useEffect(() => {
    refresh()
  }, [refresh])

  // 只认"这条会话自己"的数据（换会话后旧数据立即失效，不闪现到新会话上）
  const threadContext = context !== null && context.threadId === threadId ? context : null
  const usedInput = threadContext?.lastInput ?? null
  const usedPct =
    usedInput === null ? 0 : Math.min(100, Math.round((usedInput / windowTokens) * 100))
  const overThreshold = usedInput !== null && usedInput >= windowTokens
  const baseline = threadContext?.baselineInput ?? null
  const messageTokens = usedInput === null ? null : Math.max(0, usedInput - (baseline ?? 0))
  const lastHitRate =
    threadContext?.lastCachedInput === null ||
    threadContext?.lastCachedInput === undefined ||
    usedInput === null ||
    usedInput === 0
      ? null
      : Math.round((threadContext.lastCachedInput / usedInput) * 100)
  const todayHitRate =
    threadContext === null || threadContext.todayInput === 0
      ? null
      : Math.round((threadContext.todayCachedInput / threadContext.todayInput) * 100)

  return {
    stats: {
      usedPct,
      usedInput,
      windowTokens,
      overThreshold,
      baseline,
      messageTokens,
      lastHitRate,
      todayHitRate,
      thresholdPct: pct
    },
    /** 数据还没到（刚打开 / 刚换会话 / 上一次还没回）：给骨架，不闪假 0% */
    pending:
      threadId !== null && threadId !== '' && threadContext === null && failedThreadId !== threadId,
    refresh
  }
}

export interface ContextChipProps {
  /** 当前会话（上下文按这条会话的 usage 取数；null = 不取，环停在空态） */
  threadId?: string | null
  /**
   * round 57：用量 ≥ `COMPACT_CHIP_PCT` 时在环**左侧**多一枚「压缩上下文」胶囊（点即压缩）。
   * 不给（组件级使用 / 不需要这条入口）就不渲染这枚胶囊，环的表现一字不变。
   */
  onCompact?: () => void
  /** 压缩进行中：胶囊显示「压缩中…」并禁用 */
  compactBusy?: boolean
  /** 压缩不可用（流式 / 等审批）：胶囊可见但不可点（与 `/` 命令行同一口径） */
  compactDisabled?: boolean
  /** 外部取数刷新信号（上层每轮结束 +1）：环与胶囊的数字跟着最新用量走 */
  usageVersion?: number
}

/**
 * 上下文环（round 42 二轮，用户口径："上下文环 和 模型选择是两个组件，不要放在一起"）。
 *
 * 环自己是**独立的目标**：点击 → 弹出明细卡（复用 menu.tsx 的顶层 custom：只读区块，不装 menuitem）；
 * hover → 同一张卡（Tooltip）。它和模型名只是**相邻**：不共用按钮、不互相嵌套在对方弹层里，
 * 也不在一个按钮里（模型名那侧是 ModelChip，见下）。
 *
 * round 57：「压缩上下文」胶囊是环**左边**的兄弟节点（同层、不嵌套；环仍然只干"看用量"这一件事）——
 * 用量够高时出现，点一下就走压缩，不用在输入框里打 `/`（对齐 Kimi Code 桌面版的那枚 chip）。
 * 出现走既有入场过渡（animate-fade-in），消失随条件渲染收起；没有用量数据（取数失败 / 还没记录）
 * 时按 0% 处理 → 不出现。
 */
export function ContextChip({
  threadId = null,
  onCompact,
  compactBusy = false,
  compactDisabled = false,
  usageVersion = 0
}: ContextChipProps): React.JSX.Element {
  const { stats, pending, refresh } = useContextStats(threadId, usageVersion)
  // 没数据 / 还在取数时不出按钮（不闪一个假的"该压缩了"出来）
  const showCompact = onCompact !== undefined && !pending && stats.usedPct >= COMPACT_CHIP_PCT

  return (
    <>
      {showCompact ? (
        <button
          type="button"
          data-testid="composer-compact"
          aria-label="压缩上下文"
          disabled={compactBusy || compactDisabled}
          onClick={() => onCompact?.()}
          className="animate-fade-in inline-flex h-8 shrink-0 items-center rounded-control px-2 text-b2 text-warning transition-colors duration-(--motion-fast) ease-main hover:bg-hover disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none"
        >
          {compactBusy ? '压缩中…' : '压缩上下文'}
        </button>
      ) : null}
      <Menu
        trigger={
          // 32px 圆形 hover 底（与 ＋ / 权限 chip 同一档）；图标本身就是上下文环
          <button
            type="button"
            data-testid="composer-context"
            aria-label="上下文"
            className={ICON_TRIGGER_CLASS}
          >
            <Tooltip
              side="top"
              align="start"
              className="w-72 p-3"
              label={
                <div data-testid="context-card" className="text-left">
                  <ContextCardBody stats={stats} loading={pending} />
                </div>
              }
            >
              <span data-testid="context-ring" className="inline-flex shrink-0" tabIndex={-1}>
                <ContextRing percent={stats.usedPct} warning={stats.overThreshold} />
              </span>
            </Tooltip>
          </button>
        }
        items={[
          {
            id: 'context-usage',
            type: 'custom',
            content: (
              <div data-testid="context-menu-card" className="w-72">
                <ContextCardBody stats={stats} loading={pending} />
              </div>
            )
          }
        ]}
        side="top"
        align="start"
        onOpenChange={(open) => {
          // 点开就重取一次（上一次可能是很久以前；取不到也照常画 0%，不挡弹层）
          if (open) refresh()
        }}
      />
    </>
  )
}

/**
 * 模型 chip（round 8 形态；round 18 重做内容；round 42 二轮把上下文拆走）：
 *   - 触发器 = 模型名（无描边文字按钮；round 42 起**不含**上下文环——环是隔壁的独立组件）；
 *   - 浮窗两截：上=模型列表（当前项勾选）；下（分隔线之后）=「思考强度」「对话长度」
 *     两个二级项（右侧显示当前档 + chevron）；
 *   - 思考强度按注册表（shared/models.ts）动态给挡位——选中即落 settings.modelPrefs 并按
 *     agent.ts 的口径真透传（能传的模型才列多档，传不了的如实只有「默认」）；
 *   - 对话长度 = 官方上下文长度 × 10%–100%（滑块，松手即存）；阈值 = 同一根滑块。
 *
 * 用户反馈 001/002/004（列表这一截改了）：
 *   - 条目从「一条 channel」变成「channel × 它注册的模型」（`registeredModelsOf`）：选中的那一条
 *     写回该 provider 的 `model`，并把 `isDefault` 挪到它 —— 复用既有字段当选择器，
 *     不另造一个全局 currentModel；
 *   - 有歧义时（不止一个通道 / 不止一个模型）每条右侧标出**渠道名**（002）；
 *   - 模型名按展示名显示（004，`displayNameOf`，只影响显示）。
 *
 * 实测元数据的取数（round 22 + 用户反馈 006）：**打开菜单**时若缓存缺失/过期（>24h）后台补一趟；
 * 末尾另有一条**「刷新模型信息」**——不看 TTL，点一次就重试一次（端点刚起来 / Base URL 刚改对 /
 * 上次探测失败都属于这种情况）。
 */
export function ModelChip({ onNotice }: ModelChipProps): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const modelPrefs = useSettingsStore((state) => state.settings.modelPrefs)
  const probedModels = useSettingsStore((state) => state.settings.probedModels)
  const modelOverrides = useSettingsStore((state) => state.settings.modelOverrides)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const saveModelPrefs = useSettingsStore((state) => state.saveModelPrefs)
  const [pending, setPending] = useState(false)

  const current = providers.find((provider) => provider.isDefault) ?? providers[0]
  const prefKey = current === undefined ? '' : `${current.id}/${current.model}`
  const pref = modelPrefs[prefKey]
  // round 22：该模型的实测元数据（probed 优先；没有/字段缺就回落注册表）；
  // 用户反馈 003：手动覆盖排在最前面
  const probed =
    current === undefined ? undefined : probedModels[probedKeyOf(current.id, current.model)]
  const currentOverride =
    current === undefined ? undefined : modelOverrides[overrideKeyOf(current.id, current.model)]
  const effortId = effectiveEffortId(current?.model, pref?.thinkingEffort, probed)
  const pct = Math.min(100, Math.max(10, Math.round(pref?.contextPct ?? 100)))

  /**
   * 模型菜单打开时：实测缓存缺失/过期（>24h）→ 后台重抓一次（不闪、不阻塞菜单）。
   * task-70：「刷新模型信息」手动项已按用户口径去掉；这条自动刷新保留。
   */
  const refreshModelMeta = useCallback((): void => {
    if (current === undefined) return
    if (isProbedFresh(probedModels[probedKeyOf(current.id, current.model)])) return
    void useSettingsStore.getState().probeModels(current.id)
  }, [current, probedModels])

  const savePrefs = (patch: { thinkingEffort?: string; contextPct?: number }): void => {
    if (current === undefined) return
    const next = { ...modelPrefs, [prefKey]: { ...pref, ...patch } }
    onNotice(null)
    saveModelPrefs(next).catch((error: unknown) => {
      onNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * 选一个「channel × 模型」（001）：`isDefault` 挪到这条通道、`model` 写回选的这个
   * —— 既有字段就是选择器，没有第二个"当前模型"的真相来源。
   */
  const select = (providerId: string, model: string): void => {
    if (providerId === current?.id && model === current.model) return
    setPending(true)
    onNotice(null)
    saveProviders(
      providers.map((candidate) =>
        candidate.id === providerId
          ? { ...candidate, model, isDefault: true }
          : { ...candidate, isDefault: false }
      )
    ).then(
      () => setPending(false),
      (error: unknown) => {
        setPending(false)
        onNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
      }
    )
  }

  const efforts = thinkingEffortsOf(current?.model, probed)

  // 有歧义时（多通道 / 多模型）每条右侧标出渠道名 —— 只有一条通道一个模型时不啰嗦，与旧版一模一样
  const pairs = providers.flatMap((provider) =>
    registeredModelsOf(provider).map((model) => ({ provider, model }))
  )
  const showChannelName = providers.length > 1 || pairs.length > providers.length

  const modelItemsByProvider: MenuEntry[] = providers.flatMap((provider) => {
    const items = pairs
      .filter((pair) => pair.provider.id === provider.id)
      .map(({ model }) => {
        const override = modelOverrides[overrideKeyOf(provider.id, model)]
        const selected = provider.isDefault && model === provider.model
        const vision = visionOf(model, probedModels[probedKeyOf(provider.id, model)])
        // 模型名为空（半截配置）时用渠道名当标签，这类条目右侧就不再重复印一遍渠道名
        const label = model === '' ? providerLabel(provider) : displayNameOf(model, override)
        const contextWindow = contextWindowOf(
          model === '' ? null : model,
          probedModels[probedKeyOf(provider.id, model)],
          override
        )
        return {
          id: `${provider.id}\u0000${model}`,
          label,
          icon: <Sparkles />,
          // 只有自定义展示名时把真实 model id 作为副标题（没有自定义就不重复一遍）
          description: model !== '' && label !== model ? model : undefined,
          badge: contextWindow > 0 ? formatTokens(contextWindow) : undefined,
          selected,
          trailing:
            vision || (showChannelName && model !== '') ? (
              <span className="flex items-center gap-2">
                {showChannelName && model !== '' ? <span>{providerLabel(provider)}</span> : null}
                {vision ? <span>{VISION_MARK}</span> : null}
              </span>
            ) : undefined,
          // 同一条通道的当前模型沿用旧 testid（`composer-model-<id>`），其余按模型名区分
          testId:
            model === provider.model
              ? `composer-model-${provider.id}`
              : `composer-model-${provider.id}-${model}`,
          onSelect: () => select(provider.id, model)
        }
      })
    if (items.length === 0) return []
    return [
      {
        id: `provider-${provider.id}`,
        type: 'group' as const,
        label: providerLabel(provider),
        items
      }
    ]
  })

  const items: MenuEntry[] = [
    ...modelItemsByProvider,
    { id: 'split', type: 'separator' },
    {
      id: 'context',
      type: 'submenu',
      label: '对话长度',
      icon: <TextQuote />,
      description: '上下文占模型窗口的比例',
      testId: 'model-context',
      trailing: `${pct}%`,
      items: [
        {
          id: 'slider',
          type: 'custom',
          content: (
            <ContextSlider
              model={current?.model ?? ''}
              probed={probed}
              override={currentOverride}
              pct={pct}
              onCommit={(nextPct) => savePrefs({ contextPct: nextPct })}
            />
          )
        }
      ]
    }
    // round 42 二轮：这里**不再**拼上下文明细区块——那是隔壁 ContextChip 的弹层内容
    // （用户口径："上下文环 和 模型选择是两个组件，不要放在一起"）。menu.tsx 的顶层 custom 保留。
  ]

  // 触发器显示当前模型的展示名（004）；模型名为空（半截配置）时回落渠道名
  const triggerLabel =
    current === undefined
      ? ''
      : current.model === ''
        ? providerLabel(current)
        : displayNameOf(current.model, currentOverride)

  return (
    // task-87：模型名与推理强度是一组（用户：「模型名和推理强度那个地方离得有点远」）——
    // 组内 gap-1（4px，落在要求的 4–6px），组与左侧 ＋/权限、右侧发送保持原父级间距层次。
    <span
      data-testid="composer-model-effort-group"
      className="inline-flex min-w-0 shrink-0 items-center gap-1.5"
    >
      <Menu
        trigger={
          // 无描边的文字按钮（round 8 用户实拍：默认不要那个圆角框线；hover / 展开时才铺灰底）。
          // 尺寸与 ＋ 按钮同高（h-8 = 32px，进得了 48px 工具条）；data-state 由 Radix 的 asChild 落到这里。
          // task-84：与旁边的 ThinkingEffort 触发器同版式（h-8 / px-2 / mono 12 / rounded-control），
          // 两者并排时 top/bottom/height 与文字基线一致；模型名保持「技术读数 = mono」的字体口径。
          <button
            type="button"
            data-testid="composer-model"
            disabled={pending}
            className="inline-flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-control px-2 font-mono text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none"
          >
            <span className="truncate">{triggerLabel}</span>
          </button>
        }
        items={items}
        side="top"
        align="start"
        onOpenChange={(open) => {
          // round 22：打开菜单时看一眼实测元数据是不是缺/过期（后台抓，不挡菜单）
          if (open) refreshModelMeta()
        }}
      />
      <ThinkingEffort
        efforts={efforts}
        effortId={effortId}
        onSelect={(next) => savePrefs({ thinkingEffort: next })}
      />
    </span>
  )
}

export interface PendingChipsProps {
  attachments: readonly PendingAttachment[]
  onRemoveAttachment: (id: string) => void
  /** 0.1.3 / 013 返工：编辑摘选原文（摘要卡展开后的 textarea；发送带的是编辑后的全文） */
  onEditAttachment: (id: string, text: string) => void
  /** round 50：磁贴上的 @ 提及——把 `图片：图N` 引用插进输入框（图片本体仍在附件里，不重复携带载荷） */
  onMentionAttachment: (attachment: PendingAttachment, index: number) => void
}

/** 引用卡的摘要长度（码点）：卡上只铺这么点，完整内容照样原样传出去 */
const QUOTE_SUMMARY_CHARS = 60

/** 摘要：空白压成单空格、按**码点**截（不劈代理对），超了加省略号 */
function quoteSummaryOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const points = [...flat]
  if (points.length <= QUOTE_SUMMARY_CHARS) return flat
  return `${points.slice(0, QUOTE_SUMMARY_CHARS).join('')}…`
}

/**
 * 摘选的「引用」卡（round 42 二轮；0.1.3 / 013 返工加入「查看 / 编辑原文」）。
 *
 * 用户口径：长选区不能把输入框撑开 —— 卡上只铺**截断摘要**（60 码点 + 省略号）+ 字数 +
 * 来源；摘要图标是 `TextQuote`。点摘要行展开后，**完整原文**才出现，并可在 textarea 里直接编辑。
 *
 * 语义（用户要求说清楚）：卡上那行只是展示摘要，**发送时带的是完整原文**（`发送含原文`），
 * 不是摘要。完整原文不铺在折叠态里（卡不撑高），但它一直存在附件状态里，发送路径
 * （composer-attachments 的围栏）与 006 的 metadata 追加段都按当前全文走。
 */
function QuoteCard({
  attachment,
  onRemove,
  onEdit
}: {
  attachment: PendingAttachment
  onRemove: () => void
  onEdit: (text: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const text = attachment.text ?? ''
  const label = attachment.origin ?? attachment.relative ?? attachment.name
  const sourceTitle =
    attachment.originRef ??
    attachment.absolute ??
    attachment.path ??
    attachment.relative ??
    attachment.name
  return (
    <div
      data-testid={`composer-attachment-${attachment.name}`}
      data-quote="true"
      title={sourceTitle}
      className="flex min-w-0 max-w-96 flex-col gap-0.5 rounded-button-lg border-(length:--hairline-width) border-surface-border bg-secondary px-2.5 py-1.5 text-c1"
    >
      <div
        data-testid="composer-quote-card"
        data-quote="true"
        title={sourceTitle}
        className="flex min-w-0 flex-col gap-0.5"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <TextQuote aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
          <span className="shrink-0 rounded-badge bg-(--fill-active) px-1 py-0.5 text-ink-secondary">
            引用
          </span>
          <span className="min-w-0 truncate text-ink">{label}</span>
          {attachment.lines === undefined ? null : (
            <span
              data-testid="composer-quote-lines"
              className="shrink-0 font-mono text-ink-tertiary tabular-nums"
            >
              第 {attachment.lines.start}–{attachment.lines.end} 行
            </span>
          )}
          <button
            type="button"
            aria-label={`移除 ${attachment.name}`}
            onClick={onRemove}
            className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-ink-tertiary">
          <button
            type="button"
            data-testid="composer-quote-toggle"
            aria-expanded={open}
            aria-label={open ? '收起引用原文' : '查看引用原文'}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-button-sm text-left text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none"
          >
            <span data-testid="composer-quote-summary" className="min-w-0 truncate">
              {quoteSummaryOf(text)}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3.5 shrink-0 transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
                open && 'rotate-180'
              )}
            />
          </button>
          <span data-testid="composer-quote-count" className="shrink-0 font-mono tabular-nums">
            共 {[...text].length} 字
          </span>
          <span
            data-testid="composer-quote-send-mode"
            title="发送时带上完整原文，不是摘要"
            className="shrink-0 text-ink-secondary"
          >
            发送含原文
          </span>
        </div>
        {open ? (
          <textarea
            data-testid="composer-quote-original"
            aria-label="引用原文（可编辑）"
            value={text}
            rows={4}
            spellCheck={false}
            onChange={(event) => onEdit(event.target.value)}
            className="mt-1 max-h-40 w-full resize-y rounded-button-sm border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-2 py-1 text-b2 text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text"
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * 附件 chip 行：数据（名字/大小）直接印在 chip 上，× 移除；没有内容时整行不渲染。
 * round 14：引用不再走这里（改为输入框内联标记 + 镜像 pill，见 reference-markers.ts）。
 * 模块 2：图片把回形针换成**缩略图**（发送前就能确认是哪张）；PDF 额外印一截页数（数据，不是说明小字）。
 * round 42 二轮：摘选画成**引用卡**（路径 + 行号 + 摘要 + 字数），整文件仍是原来的 chip。
 * 0.1.3 / 013 返工：引用卡可展开查看 / 编辑原文（折叠态只占两行；发送仍带全文）。
 * round 50：**图片改走磁贴**（PendingImageTile：64px 缩略图 + hover 删除/@ 提及 + 点开放大预览）；
 * 非图片与摘选保持原样（口径不动；round 53 起路径引用的整文件 chip 照旧印名字 + 大小，
 * 完整路径进 `title`——chip 上不铺长路径）。
 */
export function PendingChips({
  attachments,
  onRemoveAttachment,
  onEditAttachment,
  onMentionAttachment
}: PendingChipsProps): React.JSX.Element | null {
  if (attachments.length === 0) return null

  // 图片按**当前顺序**编号（1 基）：磁贴徽章与「提及图片 N」共用这一个数
  const imageIndexes = new Map<string, number>()
  for (const attachment of attachments) {
    if (attachment.image !== undefined) imageIndexes.set(attachment.id, imageIndexes.size + 1)
  }

  return (
    <div data-testid="composer-pending" className="flex flex-wrap items-center gap-2 px-3 pt-3">
      {attachments.map((attachment) => {
        if (attachment.quote === true) {
          return (
            <QuoteCard
              key={attachment.id}
              attachment={attachment}
              onRemove={() => onRemoveAttachment(attachment.id)}
              onEdit={(text) => onEditAttachment(attachment.id, text)}
            />
          )
        }
        if (attachment.image !== undefined) {
          const image = attachment.image
          const index = imageIndexes.get(attachment.id) ?? 1
          return (
            <PendingImageTile
              key={attachment.id}
              attachment={attachment}
              image={image}
              index={index}
              onRemove={() => onRemoveAttachment(attachment.id)}
              onMention={() => onMentionAttachment(attachment, index)}
            />
          )
        }
        return (
          <span
            key={attachment.id}
            data-testid={`composer-attachment-${attachment.name}`}
            // 完整路径放 tooltip（round 53）：路径引用的附件 chip 上只印文件名，hover 才看得出是哪个文件
            title={attachment.absolute ?? attachment.path ?? attachment.relative ?? attachment.name}
            className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline pl-2.5 text-c1 text-ink-secondary"
          >
            <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
            <span className="min-w-0 truncate">{attachment.name}</span>
            {attachment.pdf === undefined ? null : (
              <span className="shrink-0 font-mono text-ink-tertiary tabular-nums">
                {attachment.pdf.truncated
                  ? `${attachment.pdf.pages} 页（已截断）`
                  : `${attachment.pdf.pages} 页`}
              </span>
            )}
            <span className="shrink-0 font-mono text-ink-tertiary tabular-nums">
              {formatBytes(attachment.size)}
            </span>
            <button
              type="button"
              aria-label={`移除 ${attachment.name}`}
              onClick={() => onRemoveAttachment(attachment.id)}
              className="mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
