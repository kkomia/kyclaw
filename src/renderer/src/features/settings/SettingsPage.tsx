import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fontTierSchema, themeModeSchema, type FontTier, type ThemeMode } from '@shared/settings'
import type { ReactNode } from 'react'
import { ModelSettings } from './ModelSettings'

/**
 * 设置页（T5 做「外观」组；T8 落地「模型」组）。
 * 其余四组（工具 / 工作区 / 记忆 / 用量）先把分组结构与占位文案立起来，
 * 各自的任务落地时替换组内内容。
 *
 * 三选/三档的取值直接来自 shared/settings 的 schema（options 顺序就是显示顺序），
 * 免得 UI 里再抄一份字面量、跟落盘校验漂开。
 */
const THEME_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色'
}

const FONT_LABELS: Record<FontTier, string> = {
  small: '小',
  default: '默认',
  large: '大'
}

const PENDING_GROUPS: Array<{ title: string; note: string; testId: string }> = [
  { title: '工具', note: '工具与权限开关尚未接入', testId: 'settings-group-tools' },
  { title: '工作区', note: '授权工作区尚未接入', testId: 'settings-group-workspaces' },
  { title: '记忆', note: '记忆设置尚未接入', testId: 'settings-group-memory' },
  { title: '用量', note: '用量与可观测设置尚未接入', testId: 'settings-group-usage' }
]

function SettingsGroup({
  title,
  testId,
  children
}: {
  title: string
  testId: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section data-testid={testId} className="flex flex-col gap-3">
      <h2 className="text-b1 font-medium text-ink">{title}</h2>
      <div className="rounded-panel border border-hairline p-4">{children}</div>
    </section>
  )
}

/** 一行选项：左边标签，右边一组 chip（选中用 Fills-F2 填充，与导航项同一套"当前项"口径） */
function OptionRow({
  label,
  options
}: {
  label: string
  options: Array<{ key: string; label: string; selected: boolean; onSelect: () => void }>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-b2 text-ink-secondary">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-3">
        {options.map((option) => (
          <Chip
            key={option.key}
            data-testid={option.key}
            aria-pressed={option.selected}
            className={cn(option.selected && 'bg-selected')}
            onClick={option.onSelect}
          >
            {option.label}
          </Chip>
        ))}
      </div>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  return (
    <div
      data-testid="settings-page"
      className="mx-auto flex min-h-0 w-full max-w-(--content-max-width) flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
      <h1 className="text-t1 font-medium text-ink">设置</h1>

      <SettingsGroup title="外观" testId="settings-group-appearance">
        <div className="flex flex-col gap-4">
          <OptionRow
            label="主题"
            options={themeModeSchema.options.map((mode) => ({
              key: `theme-${mode}`,
              label: THEME_LABELS[mode],
              selected: settings.theme === mode,
              onSelect: () => void update({ theme: mode })
            }))}
          />
          <OptionRow
            label="字号"
            options={fontTierSchema.options.map((tier) => ({
              key: `font-${tier}`,
              label: FONT_LABELS[tier],
              selected: settings.fontTier === tier,
              onSelect: () => void update({ fontTier: tier })
            }))}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="模型" testId="settings-group-model">
        <ModelSettings />
      </SettingsGroup>

      {PENDING_GROUPS.map((group) => (
        <SettingsGroup key={group.testId} title={group.title} testId={group.testId}>
          <p className="text-b2 text-ink-tertiary">{group.note}</p>
        </SettingsGroup>
      ))}
    </div>
  )
}
