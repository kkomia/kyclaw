import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { MemorySpaceEntry } from '@renderer/features/memory/MemoryPage'
import { UsagePanel } from '@renderer/features/usage/UsagePage'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  closeToTrayModeSchema,
  themeModeSchema,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  type CloseToTrayMode,
  type ThemeMode
} from '@shared/settings'
import { useLocation } from 'react-router'
import { AboutSettings } from './AboutSettings'
import { ArchiveSettings } from './ArchiveSettings'
import { ModelSettings } from './ModelSettings'
import { PageTitle } from '@renderer/components/ui/page-chrome'
import { MotionSettings } from './MotionSettings'
import { ReasoningTranslateSettings } from './ReasoningTranslateSettings'
import { RecallSettings } from './RecallSettings'
import { RulesEntry } from './RulesSettings'
import { SettingsGroup } from './SettingsGroup'
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
 *
 * round 48：卡片组抽到 ./SettingsGroup（多了 action 槽，动作在标题行、卡外右端）；「模型」组
 * 自己渲染那个组（它的「新增」就在组标题行，见 ModelSettings）。
 */
const THEME_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色'
}

/** 关闭窗口偏好的三档（0.1.3 托盘驻留；取值来自 shared/settings 的 schema，这里只给文案） */
const CLOSE_MODE_LABELS: Record<CloseToTrayMode, string> = {
  ask: '每次询问',
  tray: '最小化到托盘',
  quit: '直接退出'
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
      <FontSizeRow />
    </div>
  )
}

/** 字号允许的步进（px）：步进器/滑杆都用 1，范围由 shared schema 常量给 */
const FONT_SIZE_STEP = 1

/**
 * 字号（task-69：三档 → 连续数值）：显示「字号 14 px」+ −/+ 步进 + 滑杆（12–18），
 * 改动实时预览（`--ui-scale`）并走 settings:update 落盘；不新增字阶，全 UI 六档按 scale 同步缩放。
 */
function FontSizeRow(): React.JSX.Element {
  const size = useSettingsStore((state) => state.settings.uiFontSize)
  const update = useSettingsStore((state) => state.update)

  const apply = (next: number): void => {
    const clamped = Math.min(
      UI_FONT_SIZE_MAX,
      Math.max(UI_FONT_SIZE_MIN, Math.round(next / FONT_SIZE_STEP) * FONT_SIZE_STEP)
    )
    if (clamped === size) return
    void update({ uiFontSize: clamped })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-b2 text-ink-secondary">字号</span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid="font-size-decrease"
            aria-label="减小字号"
            disabled={size <= UI_FONT_SIZE_MIN}
            onClick={() => apply(size - FONT_SIZE_STEP)}
          >
            −
          </Button>
          <span
            data-testid="font-size-value"
            aria-live="polite"
            className="min-w-14 text-center font-mono text-b2 text-ink tabular-nums"
          >
            {size} px
          </span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="font-size-increase"
            aria-label="增大字号"
            disabled={size >= UI_FONT_SIZE_MAX}
            onClick={() => apply(size + FONT_SIZE_STEP)}
          >
            +
          </Button>
        </div>
      </div>
      <input
        data-testid="font-size-slider"
        type="range"
        aria-label="字号"
        min={UI_FONT_SIZE_MIN}
        max={UI_FONT_SIZE_MAX}
        step={FONT_SIZE_STEP}
        value={size}
        onChange={(event) => apply(Number(event.target.value))}
        className="h-1 w-full cursor-pointer accent-(--accent)"
      />
    </div>
  )
}

/**
 * 关闭窗口行为（0.1.3 托盘驻留）：三档偏好，走 settings:update 的补丁
 * （`closeToTrayMode` 就是渲染端可改的字段之一），随时能改、也能改回「每次询问」。
 * 说明只讲适用范围：Windows / Linux 才有效，macOS 沿 Dock、托盘不可用时不硬藏。
 */
function CloseWindowOptions(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  return (
    <div className="flex flex-col gap-4" title="Windows / Linux 有效；macOS 跟随 Dock。">
      <OptionRow
        label="关闭窗口时"
        options={closeToTrayModeSchema.options.map((mode) => ({
          key: `close-mode-${mode}`,
          label: CLOSE_MODE_LABELS[mode],
          selected: settings.closeToTrayMode === mode,
          onSelect: () => void update({ closeToTrayMode: mode })
        }))}
      />
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const section = settingsSectionFromPath(useLocation().pathname)
  const meta = findSettingsSection(section) ?? SETTINGS_SECTIONS[0]

  return (
    // round 23：外层全宽滚动容器（滚动条贴窗口右缘）+ 内层限宽内容列（口径不变）
    <section
      data-testid="settings-page"
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      {/* task-69 密度收口：页面列 spacing 6→5、内边距 24→20（字号档之外再收一档，避免整页偏大） */}
      <div
        data-testid="settings-page-column"
        className="content-column flex flex-col gap-5 px-(--page-gutter) py-5"
      >
        {/* 页面 h1 走全站统一档（PageTitle：衬线 22/30 × --ui-scale；表单/开关仍是 sans） */}
        <PageTitle data-testid="settings-page-title">{meta.label}</PageTitle>

        {/* key = 栏目：切栏目时内容重挂一次 -> 进场动效跟着走（不硬切） */}
        <div key={meta.id} className="animate-page-in flex flex-col gap-6">
          {meta.id === 'appearance' ? (
            <>
              <SettingsGroup title="主题与字号" testId="settings-group-appearance">
                <AppearanceOptions />
              </SettingsGroup>
              {/* 0.1.3 托盘驻留：关闭窗口行为（三档偏好；win/linux 适用） */}
              <SettingsGroup title="关闭窗口" testId="settings-group-close-window">
                <CloseWindowOptions />
              </SettingsGroup>
            </>
          ) : null}
          {/* task-58：动效（照抄 DSH claude-style「动画效果」面板；9 键模型/默认值在 shared/settings，
            行为接线由 task B 做 —— 本栏只负责设置与 demo 预览） */}
          {meta.id === 'motion' ? <MotionSettings /> : null}
          {meta.id === 'model' ? (
            <>
              {/* round 48：「模型」组的内容自己就是 SettingsGroup（标题行右端带「新增」，见 ModelSettings） */}
              <ModelSettings />
              {/* round 32：思考翻译（思维链是英文时先翻再回显；开关 + 模式 + 翻译服务） */}
              <SettingsGroup title="思考翻译" testId="settings-group-reasoning-translate">
                <ReasoningTranslateSettings />
              </SettingsGroup>
            </>
          ) : null}
          {meta.id === 'workspaces' ? (
            <SettingsGroup title="工作区" testId="settings-group-workspaces">
              <WorkspaceSettings />
            </SettingsGroup>
          ) : null}
          {/* 记忆 / 用量（round 5 去重）：设置是唯一导航源——面板直接复用独立页的实现（MemoryPanel /
            UsagePanel），版式与其他组同一内容列。记忆栏是两张行式卡片（语义召回 + 记忆空间 /
            记忆指令），记忆面板与指令编辑器都开在弹窗里；卡片内部的行间分隔由 `[&>*+*]` 给。 */}
          {meta.id === 'memory' ? (
            <div data-testid="settings-group-memory" className="flex flex-col gap-4">
              <div
                data-testid="memory-card-base"
                className="border-t border-hairline px-0 [&>*+*]:border-t [&>*+*]:border-surface-border [&>*]:py-4"
              >
                <RecallSettings />
                <MemorySpaceEntry />
              </div>
              <div
                data-testid="memory-card-rules"
                className="border-t border-hairline px-0 [&>*]:py-4"
              >
                <RulesEntry />
              </div>
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
    </section>
  )
}
