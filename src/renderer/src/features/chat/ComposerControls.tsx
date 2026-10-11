import { useState } from 'react'
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
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { Workspace, WorkspaceMode } from '@shared/settings'
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
 *   - `PendingChips`：附件 / 引用 chip 行（可移除）。
 * 图标按钮 hover 铺灰底（Fills-F1）= 图10 口径；不给说明性小字（雷点 2）。
 */
export interface ComposerNotice {
  tone: 'danger' | 'warning'
  text: string
}

/** 图标按钮（composer 内统一形态：32px、**圆形** hover 底 —— round 15 用户实拍：不要圆角方框） */
const ICON_TRIGGER_CLASS =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none'

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
  onNotice: (notice: ComposerNotice | null) => void
}

export function ModelChip({ onNotice }: ModelChipProps): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const [pending, setPending] = useState(false)

  const current = providers.find((provider) => provider.isDefault) ?? providers[0]

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

  const items: MenuEntry[] = providers.map((provider) => ({
    id: provider.id,
    label: provider.model === '' ? provider.id : provider.model,
    selected: provider.isDefault,
    testId: `composer-model-${provider.id}`,
    onSelect: select
  }))

  const label = current === undefined ? '' : current.model === '' ? current.id : current.model

  return (
    <Menu
      trigger={
        // 无描边的文字按钮（round 8 用户实拍：默认不要那个圆角框线；hover / 展开时才铺灰底）。
        // 尺寸与 ＋ 按钮同高（h-8 = 32px，进得了 48px 工具条）；data-state 由 Radix 的 asChild 落到这里。
        <button
          type="button"
          data-testid="composer-model"
          disabled={pending}
          className="inline-flex h-8 max-w-44 shrink-0 items-center rounded-control px-2 text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none"
        >
          <span className="truncate">{label}</span>
        </button>
      }
      items={items}
      side="top"
      align="start"
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
          <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
          <span className="min-w-0 truncate">{attachment.name}</span>
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
