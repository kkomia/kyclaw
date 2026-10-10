import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fontTierSchema, themeModeSchema, type FontTier, type ThemeMode } from '@shared/settings'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { McpSettings } from './McpSettings'
import { ModelSettings } from './ModelSettings'
import { WorkspaceSettings } from './WorkspaceSettings'
import { findSettingsSection, settingsSectionFromPath, SETTINGS_SECTIONS } from './sections'

/**
 * 设置页（T5 起「外观」，T8 起「模型」；UI 返工 R1 改成栏目页）：
 * 左列由 SettingsNav 给（返回 + 栏目菜单），这里只渲染**当前栏目**的内容。
 * 栏目表在 sections.ts（唯一来源），URL 是 /settings/:section；脏值回落默认栏。
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

/** 还没接内容的栏目：给一句中性空态（雷点 2：不写"还没做"这类研发口吻，也不解释排期） */
const EMPTY_SECTIONS = new Set(['memory', 'usage'])

/** 栏目卡片组：组用底色分层（不描边），组内控件自己带一条 hairline —— 避免近距多层框线 */
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
      <h2 className="text-b2 text-ink-secondary">{title}</h2>
      <div className="rounded-panel bg-secondary p-4">{children}</div>
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

function AppearanceOptions(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  return (
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
  )
}

export function SettingsPage(): React.JSX.Element {
  const section = settingsSectionFromPath(useLocation().pathname)
  const meta = findSettingsSection(section) ?? SETTINGS_SECTIONS[0]

  return (
    <div
      data-testid="settings-page"
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
      <h1 className="text-t1 font-medium text-ink">{meta.label}</h1>

      {/* key = 栏目：切栏目时内容重挂一次 -> 进场动效跟着走（不硬切） */}
      <div key={meta.id} className="animate-page-in flex flex-col gap-6">
        {meta.id === 'appearance' ? (
          <SettingsGroup title="主题与字号" testId="settings-group-appearance">
            <AppearanceOptions />
          </SettingsGroup>
        ) : null}
        {meta.id === 'model' ? (
          <SettingsGroup title="模型" testId="settings-group-model">
            <ModelSettings />
          </SettingsGroup>
        ) : null}
        {meta.id === 'workspaces' ? (
          <SettingsGroup title="工作区" testId="settings-group-workspaces">
            <WorkspaceSettings />
          </SettingsGroup>
        ) : null}
        {meta.id === 'tools' ? (
          <SettingsGroup title="工具与 MCP" testId="settings-group-tools">
            <McpSettings />
          </SettingsGroup>
        ) : null}
        {EMPTY_SECTIONS.has(meta.id) ? (
          <SettingsGroup title={meta.label} testId={meta.groupTestId}>
            <p className="text-b2 text-ink-secondary">暂无可调整的设置</p>
          </SettingsGroup>
        ) : null}
      </div>
    </div>
  )
}
