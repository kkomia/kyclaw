import { useCallback, useEffect, useState } from 'react'
import {
  AtSign,
  Paperclip,
  Plug,
  Plus,
  Shield,
  ShieldAlert,
  Sparkles,
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
import { fetchThreadContext } from '@renderer/lib/usage-api'
import {
  contextTokensFor,
  contextWindowOf,
  effectiveEffortId,
  formatTokens,
  isProbedFresh,
  probedKeyOf,
  thinkingEffortsOf,
  visionOf
} from '@shared/models'
import type { ProbedModelSpec } from '@shared/models'
import type { Workspace, WorkspaceMode } from '@shared/settings'
import type { UsageThreadContext } from '@shared/usage'
import { withDefaultProvider } from '@shared/providers'
import { formatBytes } from './composer-attachments'
import type { PendingAttachment } from './composer-attachments'
import type { ReferenceKind } from './reference-markers'

/**
 * Composer 的控件族（round 7，用户实拍 #10 图4/图5/图7/图8/图10）：
 *   - `PlusMenu`：＋菜单（添加文件 / 引用技能▸ / 引用插件▸ / 引用上下文）——round 13 起技能子菜单
 *     只列**插件装进来的技能**（内置技能默认就暴露给 agent，不再出现）；
 *   - `PermissionChip`：权限两档（每次询问 / 完全访问）——**只走引擎既有两档**，
 *     放开方向（full）沿用设置页那套确认框语义；写走 `workspace:set-mode` 通道（不弱化 T13）；
 *     round 13：无描边（hover / 展开只铺灰底），「完全访问」用时警示色 + ShieldAlert（不走对勾图标）；
 *   - `ModelChip`：模型切换（只列 T8 已配置的 provider，含 isDefault 语义；不带小字说明）；
 *     round 41：弹层底部摊开上下文占用 / 分解 / 缓存 / 阈值（与 hover 卡同源）；
 *   - `PendingChips`：附件 / 引用 chip 行（可移除）。
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
   * 可引用的技能 = **插件装进来的技能**（round 13：内置技能默认就暴露给 agent，不再进这个菜单；
   * 空列表时菜单里给一条禁用说明）。
   */
  skills: ReadonlyArray<{ dir: string; name: string }>
  /** 打开菜单时拉一次数据（技能的安装状态可能在别处刚变过；挂载时另有一次，见 Composer） */
  onOpenMenu?: () => void
}

export function PlusMenu({
  onAddFile,
  onReference,
  contextLabel,
  plugins,
  skills,
  onOpenMenu
}: PlusMenuProps): React.JSX.Element {
  const items: MenuEntry[] = [
    {
      id: 'add-file',
      label: '添加文件',
      icon: <Paperclip />,
      testId: 'composer-add-file',
      onSelect: () => onAddFile()
    },
    { id: 'sep-1', type: 'separator' },
    {
      id: 'skills',
      type: 'submenu',
      label: '引用技能',
      icon: <Sparkles />,
      testId: 'composer-ref-skills',
      items:
        skills.length === 0
          ? [{ id: 'empty', label: '还没有安装技能', disabled: true }]
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
      icon: <AtSign />,
      testId: 'composer-ref-context',
      disabled: contextLabel === null,
      onSelect: () => {
        if (contextLabel !== null) onReference({ kind: '上下文', label: contextLabel })
      }
    }
  ]

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
  /** 当前会话的工作区根（判不出时调用方不渲染本 chip） */
  workspace: Workspace
  onNotice: (notice: ComposerNotice | null) => void
}

const MODE_LABELS: Record<WorkspaceMode, string> = {
  ask: '每次询问',
  full: '完全访问'
}

export function PermissionChip({ workspace, onNotice }: PermissionChipProps): React.JSX.Element {
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
      selected: workspace.mode === 'ask',
      testId: 'composer-permission-ask',
      onSelect: () => {
        if (workspace.mode !== 'ask') apply('ask')
      }
    },
    {
      id: 'full',
      label: MODE_LABELS.full,
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
            className={cn(
              'inline-flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-control px-2 text-b2 transition-colors duration-(--motion-fast) ease-main hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none',
              full ? 'text-warning' : 'text-ink-secondary hover:text-ink data-[state=open]:text-ink'
            )}
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
  /** 当前会话（上下文环按这条会话的 usage 取数；null = 不取，环停在空态） */
  threadId?: string | null
  onNotice: (notice: ComposerNotice | null) => void
}

/** 上下文环（round 18，图3）：模型名左侧 16px 小环；超过阈值时整环转警示色 */
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
 * 上下文明细的取数口径（一处算、两处用：hover 明细卡与模型弹层里的「上下文」区块）：
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
 * 上下文明细卡的正文（round 41）：hover 明细卡与模型弹层里的「上下文」区块共用同一份
 * 布局与文案（口径只此一份）。数据没到时给骨架占位——不闪一个假的 0% 出来（有过渡不硬切）。
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
  pct,
  onCommit
}: {
  model: string
  /** round 22：该模型的实测元数据（probed 优先；没有就注册表） */
  probed?: ProbedModelSpec
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
  const window = contextWindowOf(model, probed)
  return (
    <div data-testid="model-context-slider" className="flex w-56 flex-col gap-2">
      <div className="flex items-baseline justify-between text-c1">
        <span data-testid="model-context-pct" className="text-ink">
          {draft}%
        </span>
        <span className="text-ink-tertiary tabular-nums">
          ≈ {formatTokens(contextTokensFor(model, draft, probed))} / {formatTokens(window)}
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
 * 模型 chip（round 8 形态；round 18 重做内容；round 41 把上下文摊到弹层里）：
 *   - 触发器 = [上下文环] + 模型名（无描边文字按钮）；
 *   - 浮窗**上下两截**（用户图1）：上=模型列表（当前项勾选）；下（分隔线之后）=「思考强度」「对话长度」
 *     两个二级项（右侧显示当前档 + chevron）；
 *   - 思考强度按注册表（shared/models.ts）动态给挡位——选中即落 settings.modelPrefs 并按
 *     agent.ts 的口径真透传（能传的模型才列多档，传不了的如实只有「默认」）；
 *   - 对话长度 = 官方上下文长度 × 10%–100%（滑块，松手即存）；阈值 = 同一根滑块；
 *   - 弹层底部 = **上下文明细区块**（round 41：已用 %、~已用/~总量、进度条、分解、缓存命中率、阈值）：
 *     点开弹层就能看全，不用去 hover；与 hover 明细卡同源（同一个 ContextCardBody）；
 *   - hover 触发器 = 同一张暗色明细卡（行为不变）。
 */
export function ModelChip({ threadId = null, onNotice }: ModelChipProps): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const modelPrefs = useSettingsStore((state) => state.settings.modelPrefs)
  const probedModels = useSettingsStore((state) => state.settings.probedModels)
  const modelCapabilities = useSettingsStore((state) => state.settings.modelCapabilities)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const saveModelPrefs = useSettingsStore((state) => state.saveModelPrefs)
  const [pending, setPending] = useState(false)
  const [context, setContext] = useState<UsageThreadContext | null>(null)
  /** 取数失败的那条会话（服务没起来 / 还没记录）：没数据时不再给骨架，如实画 0% */
  const [failedThreadId, setFailedThreadId] = useState<string | null>(null)

  const current = providers.find((provider) => provider.isDefault) ?? providers[0]
  const prefKey = current === undefined ? '' : `${current.id}/${current.model}`
  const pref = modelPrefs[prefKey]
  // round 22：该模型的实测元数据（probed 优先；没有/字段缺就回落注册表）
  const probed =
    current === undefined ? undefined : probedModels[probedKeyOf(current.id, current.model)]
  const effortId = effectiveEffortId(current?.model, pref?.thinkingEffort, probed)
  const pct = Math.min(100, Math.max(10, Math.round(pref?.contextPct ?? 100)))
  const windowTokens = contextTokensFor(current?.model, pct, probed)

  const refreshContext = useCallback((): void => {
    if (threadId === null || threadId === '') return
    void fetchThreadContext(threadId).then(
      (next) => setContext(next),
      // 取不到（服务没起来 / 还没记录）：记下这条会话取不到，卡里如实画 0%，不打扰输入
      () => setFailedThreadId(threadId)
    )
  }, [threadId])
  useEffect(() => {
    refreshContext()
  }, [refreshContext])

  /** round 22：菜单打开且实测缓存缺失/过期（>24h）→ 后台重抓一次（不闪、不阻塞菜单） */
  const refreshModelMeta = useCallback((): void => {
    if (current === undefined) return
    if (isProbedFresh(probedModels[probedKeyOf(current.id, current.model)])) return
    void useSettingsStore.getState().probeModels(current.id)
  }, [current, probedModels])

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
  /** 明细卡的一份口径（hover 卡与弹层区块共用同一份数据与文案） */
  const contextStats: ContextStats = {
    usedPct,
    usedInput,
    windowTokens,
    overThreshold,
    baseline,
    messageTokens,
    lastHitRate,
    todayHitRate,
    thresholdPct: pct
  }
  /** 数据还没到（刚打开弹层 / 刚换会话 / 上一次还没回）：给骨架，不闪假 0% */
  const contextPending =
    threadId !== null && threadId !== '' && threadContext === null && failedThreadId !== threadId

  const savePrefs = (patch: { thinkingEffort?: string; contextPct?: number }): void => {
    if (current === undefined) return
    const next = { ...modelPrefs, [prefKey]: { ...pref, ...patch } }
    onNotice(null)
    saveModelPrefs(next).catch((error: unknown) => {
      onNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
    })
  }

  const select = (id: string): void => {
    if (id === current?.id) return
    setPending(true)
    onNotice(null)
    saveProviders(withDefaultProvider(providers, id)).then(
      () => setPending(false),
      (error: unknown) => {
        setPending(false)
        onNotice({ tone: 'danger', text: error instanceof Error ? error.message : String(error) })
      }
    )
  }

  const efforts = thinkingEffortsOf(current?.model, probed)
  const effortLabel = efforts.find((effort) => effort.id === effortId)?.label ?? '默认'

  const items: MenuEntry[] = [
    ...providers.map((provider) => ({
      id: provider.id,
      label: provider.model === '' ? provider.id : provider.model,
      selected: provider.isDefault,
      // 模块 2：视觉模型给一个小标记（不解释后端；判据 = 用户覆盖 > 注册表 > false）
      trailing: visionOf(provider.model, modelCapabilities[provider.model])
        ? VISION_MARK
        : undefined,
      testId: `composer-model-${provider.id}`,
      onSelect: select
    })),
    { id: 'split', type: 'separator' },
    {
      id: 'efforts',
      type: 'submenu',
      label: '思考强度',
      testId: 'model-efforts',
      trailing: effortLabel,
      items: efforts.map((effort) => ({
        id: effort.id,
        label: effort.label,
        selected: effort.id === effortId,
        testId: `model-effort-${effort.id}`,
        onSelect: () => savePrefs({ thinkingEffort: effort.id })
      }))
    },
    {
      id: 'context',
      type: 'submenu',
      label: '对话长度',
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
              pct={pct}
              onCommit={(nextPct) => savePrefs({ contextPct: nextPct })}
            />
          )
        }
      ]
    },
    // round 41：上下文占用 / 构成分解 / 缓存 / 阈值——**点开弹层就能看全**（不再只藏在 hover 卡里）。
    // 与 hover 卡同一份口径、同一份文案（ContextCardBody）；只读，不参与键盘导航。
    { id: 'split-usage', type: 'separator' },
    {
      id: 'context-usage',
      type: 'custom',
      content: (
        <div data-testid="model-context-card" className="w-72">
          <ContextCardBody stats={contextStats} loading={contextPending} />
        </div>
      )
    }
  ]

  const label = current === undefined ? '' : current.model === '' ? current.id : current.model

  return (
    <Menu
      trigger={
        // 无描边的文字按钮（round 8 用户实拍：默认不要那个圆角框线；hover / 展开时才铺灰底）。
        // 尺寸与 ＋ 按钮同高（h-8 = 32px，进得了 48px 工具条）；data-state 由 Radix 的 asChild 落到这里。
        // round 18：模型名左侧是上下文环（hover 出明细卡）。
        <button
          type="button"
          data-testid="composer-model"
          disabled={pending}
          className="inline-flex h-8 max-w-44 shrink-0 items-center gap-1.5 rounded-control px-2 text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none"
        >
          {current === undefined ? null : (
            <Tooltip
              side="top"
              align="start"
              className="w-72 p-3"
              label={
                <div data-testid="context-card" className="text-left">
                  <ContextCardBody stats={contextStats} loading={contextPending} />
                </div>
              }
            >
              <span data-testid="context-ring" className="inline-flex shrink-0" tabIndex={-1}>
                <ContextRing percent={usedPct} warning={overThreshold} />
              </span>
            </Tooltip>
          )}
          <span className="truncate">{label}</span>
        </button>
      }
      items={items}
      side="top"
      align="start"
      onOpenChange={(open) => {
        if (open) {
          refreshContext()
          // round 22：顺带看一眼实测元数据是不是缺/过期（后台抓，不挡菜单）
          refreshModelMeta()
        }
      }}
    />
  )
}

export interface PendingChipsProps {
  attachments: readonly PendingAttachment[]
  onRemoveAttachment: (id: string) => void
}

/**
 * 附件 chip 行：数据（名字/大小）直接印在 chip 上，× 移除；没有内容时整行不渲染。
 * round 14：引用不再走这里（改为输入框内联标记 + 镜像 pill，见 reference-markers.ts）。
 * 模块 2：图片把回形针换成**缩略图**（发送前就能确认是哪张）；PDF 额外印一截页数（数据，不是说明小字）。
 */
export function PendingChips({
  attachments,
  onRemoveAttachment
}: PendingChipsProps): React.JSX.Element | null {
  if (attachments.length === 0) return null

  return (
    <div data-testid="composer-pending" className="flex flex-wrap items-center gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          data-testid={`composer-attachment-${attachment.name}`}
          className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline pl-2.5 text-c1 text-ink-secondary"
        >
          {attachment.image === undefined ? (
            <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
          ) : (
            <img
              data-testid={`composer-attachment-thumb-${attachment.name}`}
              src={attachment.image.url}
              alt=""
              aria-hidden="true"
              className="size-5 shrink-0 rounded-control object-cover"
            />
          )}
          <span className="min-w-0 truncate">{attachment.name}</span>
          {attachment.pdf === undefined ? null : (
            <span className="shrink-0 text-ink-tertiary">
              {attachment.pdf.truncated
                ? `${attachment.pdf.pages} 页（已截断）`
                : `${attachment.pdf.pages} 页`}
            </span>
          )}
          <span className="shrink-0 text-ink-tertiary">{formatBytes(attachment.size)}</span>
          <button
            type="button"
            aria-label={`移除 ${attachment.name}`}
            onClick={() => onRemoveAttachment(attachment.id)}
            className="mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
