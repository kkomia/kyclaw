import { useEffect, useState } from 'react'
import { Segmented } from '@renderer/components/ui/segmented'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  caretMotionSchema,
  messageEnterSchema,
  motionModeSchema,
  revealMotionSchema,
  statusPaintSchema,
  type CaretMotion,
  type MessageEnter,
  type MotionMode,
  type MotionSettings,
  type RevealMotion,
  type StatusPaint
} from '@shared/settings'
import './motion-settings.css'

/**
 * 设置 →「动效」栏（task-58）：照抄 DSH claude-style 的「动画效果」面板
 * （规格见 `.superpowers/handover/dsh-motion-design.md` §1，截图
 * `.superpowers/chat-aesthetics/refs/dsh-motion-settings.png`）。
 *
 * 结构（rank 升序，行式）：
 *   5  动画效果（标题 + 说明 + 三档 segmented：随系统 / 减弱 / 总是）
 *   10 聊天区滚动动画（switch + 说明「滚动展示助手消息并进行可读性优化」）
 *   15 状态行动画（switch）
 *   16 精确状态行（subRow：紧跟 15、无分隔线；状态行动画关时灰掉）
 *   17 状态画法（二选一预览卡：扫光 / 渐变流动，demo「正在检出当前工作树」）
 *   20 光标动画（二选一预览卡：开 / 关，demo「Hello World!」）
 *   40 新文字淡入（二选一预览卡：淡入 / 直接出现，demo「新到的字先淡后实」）
 *   50 消息气泡动画（switch）
 *   51 气泡出场（二选一预览卡：在原地长出来 / 从输入框飞上来，demo 两句气泡）
 *
 * 数据：9 个键都在 `shared/settings` 的 `motionSettingsSchema` 里（默认值 = 用户截图选择）；
 * 每次改动都发 `settings:update` 的 `{ motion: {...} }` 补丁（主进程真相，UI 乐观更新由 store 统一做）。
 * 行为接线（滚动/状态行/光标/淡入/气泡）在 task B（tabbar-dev）——本组件只负责设置面板与 demo 预览。
 *
 * demo 全部是 CSS 循环动画（不引依赖）：
 *   - 面板按 `mode` + 系统 `prefers-reduced-motion` 解析出 effective reduced（与 B 的
 *     `lib/motion.ts` 同语义）；reduced 时 demo 根 `data-motion="reduced"` → 定格 + 行下备注
 *     （`motionStillNote` 原文），**选择仍可改**（值照存）；
 *   - 深浅两套走现有 token（`--bg-*` / `--text-*` / `--border-*` / `--accent`），不写死颜色。
 */

const MODE_LABELS: Record<MotionMode, string> = {
  system: '随系统',
  reduced: '减弱',
  always: '总是'
}

const PAINT_LABELS: Record<StatusPaint, string> = {
  sweep: '扫光',
  wash: '渐变流动'
}

const CARET_LABELS: Record<CaretMotion, string> = {
  typing: '开',
  off: '关'
}

const REVEAL_LABELS: Record<RevealMotion, string> = {
  on: '淡入',
  off: '直接出现'
}

const MESSAGE_ENTER_LABELS: Record<MessageEnter, string> = {
  grow: '在原地长出来',
  flight: '从输入框飞上来'
}

/** 「减弱」时的固定说明（doc 的 `motionStillNote` 原文） */
const MOTION_STILL_NOTE = '动画设为「减弱」时这一项不生效，卡片只显示定格画面。'

/** 系统 prefers-reduced-motion（jsdom / 老浏览器没有 matchMedia 时按 false） */
function useSystemReduce(): boolean {
  const [reduce, setReduce] = useState(() => {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (event: MediaQueryListEvent): void => setReduce(event.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return reduce
}

/** 一行：左标题（+说明），右控件；行间分隔与 subRow 由 CSS 管 */
function Row({
  title,
  description,
  children,
  sub = false,
  testId
}: {
  title: string
  description?: string
  children: React.ReactNode
  /** subRow：无上分隔线、与上一行贴紧（精确状态行用） */
  sub?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <div data-testid={testId} className={cn('motion-row', sub && 'motion-row--sub')}>
      <div className="motion-row__text">
        <p className="motion-row__title">{title}</p>
        {description === undefined ? null : <p className="motion-row__desc">{description}</p>}
      </div>
      {children}
    </div>
  )
}

/** 预览卡：二选一（选中描边 accent；呼吸间距按 doc §1.2） */
function PreviewCard({
  testId,
  label,
  selected,
  onSelect,
  children,
  disabled = false
}: {
  testId: string
  label: string
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      data-testid={testId}
      data-active={selected ? 'true' : 'false'}
      disabled={disabled}
      onClick={onSelect}
      className={cn('motion-preview-card', selected && 'motion-preview-card--active')}
    >
      {children}
    </button>
  )
}

/** 一行二选一预览卡（状态画法 / 光标 / 淡入 / 气泡出场共用） */
function PreviewRow({
  title,
  testId,
  reduced,
  children
}: {
  title: string
  testId: string
  reduced: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="motion-row motion-row--block">
      <p className="motion-row__title">{title}</p>
      <div
        role="radiogroup"
        aria-label={title}
        className="motion-demo-grid"
        data-motion={reduced ? 'reduced' : 'full'}
      >
        {children}
      </div>
      {reduced ? (
        <p data-testid={`${testId}-still`} className="motion-row__note">
          {MOTION_STILL_NOTE}
        </p>
      ) : null}
    </div>
  )
}

/* ── demo ①：状态画法（扫光 / 渐变流动）───────────────────────────────────── */
function StatusPaintDemo({ paint }: { paint: StatusPaint }): React.JSX.Element {
  return (
    <span className="motion-demo-status">
      <span className="motion-demo-status__base">正在检出当前工作树</span>
      <span
        aria-hidden="true"
        className={cn(
          'motion-demo-status__paint',
          paint === 'sweep' ? 'motion-demo-status__paint--sweep' : 'motion-demo-status__paint--wash'
        )}
      >
        正在检出当前工作树
      </span>
    </span>
  )
}

/* ── demo ②：光标（打字 + 滑动光标 / 直接出现）────────────────────────────── */
function CaretDemo({ caret }: { caret: CaretMotion }): React.JSX.Element {
  return (
    <span className="motion-demo-caret">
      <span
        aria-hidden="true"
        className={cn(
          'motion-demo-caret__text',
          caret === 'typing' ? 'motion-demo-caret__text--typing' : 'motion-demo-caret__text--off'
        )}
      >
        Hello World!
      </span>
      {caret === 'typing' ? <span aria-hidden="true" className="motion-demo-caret__bar" /> : null}
    </span>
  )
}

/* ── demo ③：新文字淡入（逐字淡入 / 直接出现）─────────────────────────────── */
function RevealDemo({ reveal }: { reveal: RevealMotion }): React.JSX.Element {
  const chars = Array.from('新到的字先淡后实')
  return (
    <span className={cn('motion-demo-reveal', reveal === 'on' && 'motion-demo-reveal--on')}>
      {chars.map((char, index) => (
        <span
          key={`${char}-${index}`}
          aria-hidden="true"
          className="motion-demo-reveal__char"
          style={{ '--motion-char-index': index } as React.CSSProperties}
        >
          {char}
        </span>
      ))}
    </span>
  )
}

/* ── demo ④：消息气泡（原地长出来 / 从输入框飞上来）────────────────────────── */
const BUBBLE_SAMPLES = ['帮我给kyclaw点个star', '帮我给kyclaw提个issue']

function BubbleDemo({ enter }: { enter: MessageEnter }): React.JSX.Element {
  return (
    <span className="motion-demo-bubbles">
      {BUBBLE_SAMPLES.map((sample, index) => (
        <span
          key={sample}
          aria-hidden="true"
          className={cn(
            'motion-demo-bubble',
            enter === 'grow' ? 'motion-demo-bubble--grow' : 'motion-demo-bubble--flight'
          )}
          style={{ '--motion-bubble-index': index } as React.CSSProperties}
        >
          {sample}
        </span>
      ))}
    </span>
  )
}

export function MotionSettings(): React.JSX.Element {
  const motion = useSettingsStore((state) => state.settings.motion)
  const update = useSettingsStore((state) => state.update)
  const systemReduce = useSystemReduce()
  // 三档折算（与 B 的 lib/motion.ts 同语义，本面板只用于 demo 定格与备注）：
  const reduced = motion.mode === 'reduced' || (motion.mode === 'system' && systemReduce)

  const patchMotion = (patch: Partial<MotionSettings>): void => {
    void update({ motion: { ...motion, ...patch } })
  }

  return (
    <section
      data-testid="settings-group-motion"
      data-motion={reduced ? 'reduced' : 'full'}
      className="motion-group flex flex-col gap-3"
    >
      {/* 区块标题与 SettingsGroup 同口径：16/600 衬线（task-67 字体统一 P2 收尾） */}
      <h2 className="font-serif text-t2 font-semibold text-ink">动效</h2>
      <div className="motion-panel">
        <Row
          title="动画效果"
          description="请按需调整动画效果。动画会给设备带来渲染压力。"
          testId="motion-row-mode"
        >
          <Segmented
            ariaLabel="动画效果模式"
            className="motion-mode-segmented"
            value={motion.mode}
            onChange={(mode) => patchMotion({ mode })}
            options={motionModeSchema.options.map((mode) => ({
              value: mode,
              label: MODE_LABELS[mode],
              testId: `motion-mode-${mode}`
            }))}
          />
        </Row>

        <Row
          title="聊天区滚动动画"
          description="滚动展示助手消息并进行可读性优化"
          testId="motion-row-chat-scroll"
        >
          <Switch
            checked={motion.chatScroll}
            onCheckedChange={(checked) => patchMotion({ chatScroll: checked })}
            label="聊天区滚动动画"
            data-testid="motion-chat-scroll"
          />
        </Row>

        <Row title="状态行动画" testId="motion-row-status-line">
          <Switch
            checked={motion.statusLine}
            onCheckedChange={(checked) => patchMotion({ statusLine: checked })}
            label="状态行动画"
            data-testid="motion-status-line"
          />
        </Row>

        <Row title="精确状态行" sub testId="motion-row-precise-status">
          <Switch
            checked={motion.preciseStatus}
            onCheckedChange={(checked) => patchMotion({ preciseStatus: checked })}
            label="精确状态行"
            disabled={!motion.statusLine}
            data-testid="motion-precise-status"
          />
        </Row>

        <PreviewRow title="状态画法" testId="motion-row-status-paint" reduced={reduced}>
          {statusPaintSchema.options.map((paint) => (
            <PreviewCard
              key={paint}
              testId={`motion-status-paint-${paint}`}
              label={PAINT_LABELS[paint]}
              selected={motion.statusPaint === paint}
              disabled={!motion.statusLine}
              onSelect={() => patchMotion({ statusPaint: paint })}
            >
              <StatusPaintDemo paint={paint} />
            </PreviewCard>
          ))}
        </PreviewRow>

        <PreviewRow title="光标动画" testId="motion-row-caret" reduced={reduced}>
          {caretMotionSchema.options.map((caret) => (
            <PreviewCard
              key={caret}
              testId={`motion-caret-${caret}`}
              label={CARET_LABELS[caret]}
              selected={motion.caret === caret}
              onSelect={() => patchMotion({ caret })}
            >
              <CaretDemo caret={caret} />
            </PreviewCard>
          ))}
        </PreviewRow>

        <PreviewRow title="新文字淡入" testId="motion-row-reveal" reduced={reduced}>
          {revealMotionSchema.options.map((reveal) => (
            <PreviewCard
              key={reveal}
              testId={`motion-reveal-${reveal}`}
              label={REVEAL_LABELS[reveal]}
              selected={motion.reveal === reveal}
              onSelect={() => patchMotion({ reveal })}
            >
              <RevealDemo reveal={reveal} />
            </PreviewCard>
          ))}
        </PreviewRow>

        <Row title="消息气泡动画" testId="motion-row-chat-send">
          <Switch
            checked={motion.chatSend}
            onCheckedChange={(checked) => patchMotion({ chatSend: checked })}
            label="消息气泡动画"
            data-testid="motion-chat-send"
          />
        </Row>

        <PreviewRow title="气泡出场" testId="motion-row-message-enter" reduced={reduced}>
          {messageEnterSchema.options.map((enter) => (
            <PreviewCard
              key={enter}
              testId={`motion-message-enter-${enter}`}
              label={MESSAGE_ENTER_LABELS[enter]}
              selected={motion.messageEnter === enter}
              disabled={!motion.chatSend}
              onSelect={() => patchMotion({ messageEnter: enter })}
            >
              <BubbleDemo enter={enter} />
            </PreviewCard>
          ))}
        </PreviewRow>
      </div>
    </section>
  )
}
