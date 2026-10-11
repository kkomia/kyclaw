import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { MemoryPanel } from '@renderer/features/memory/MemoryPage'
import { UsagePanel } from '@renderer/features/usage/UsagePage'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fontTierSchema, themeModeSchema, type FontTier, type ThemeMode } from '@shared/settings'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { AboutSettings } from './AboutSettings'
import { ArchiveSettings } from './ArchiveSettings'
import { ModelSettings } from './ModelSettings'
import { TracingSettings } from './TracingSettings'
import { WorkspaceSettings } from './WorkspaceSettings'
import { findSettingsSection, settingsSectionFromPath, SETTINGS_SECTIONS } from './sections'

/**
 * 设置页（T5 起「外观」，T8 起「模型」；UI 返工 R1 改成栏目页）：
 * 左列由 SettingsNav 给（返回 + 栏目菜单），这里只渲染**当前栏目**的内容。
 * 栏目表在 sections.ts（唯一来源），URL 是 /settings/:section；脏值回落默认栏。
 * T17 起多了「追踪」（Langfuse）与「关于」（版本与更新）两栏；round 20 多了「归档」一栏。
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
        {/* 记忆 / 用量（round 5 去重）：设置是唯一导航源——面板直接复用独立页的实现（MemoryPanel /
            UsagePanel），不再套一层分组卡（面板自带 round 5 的 ≤2 层口径），版式与其他组同一内容列。 */}
        {meta.id === 'memory' ? (
          <div data-testid="settings-group-memory" className="flex flex-col gap-3">
            <MemoryPanel />
          </div>
        ) : null}
        {meta.id === 'usage' ? (
          <div data-testid="settings-group-usage" className="flex flex-col gap-3">
            <UsagePanel />
          </div>
        ) : null}
        {/* round 20：归档（查看 / 搜索 / 取消归档；数据与实现见 features/settings/ArchiveSettings.tsx） */}
        {meta.id === 'archived' ? (
          <SettingsGroup title="归档" testId="settings-group-archived">
            <ArchiveSettings />
          </SettingsGroup>
        ) : null}
        {/* 追踪 / 关于（T17）：都是显式配置项；两组各一行状态文字，不套框线（雷点 v1 的第 7 条） */}
        {meta.id === 'tracing' ? (
          <SettingsGroup title="Langfuse" testId="settings-group-tracing">
            <TracingSettings />
          </SettingsGroup>
        ) : null}
        {meta.id === 'about' ? (
          <SettingsGroup title="版本与更新" testId="settings-group-about">
            <AboutSettings />
          </SettingsGroup>
        ) : null}
      </div>
    </div>
  )
}
