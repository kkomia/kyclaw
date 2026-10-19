import { PanelRightClose, Sparkles } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'

/**
 * Office 右侧 AI 面板 v1（A3，`office-ui-redesign-spec` §6.1/§7-A3）。
 *
 * **诚实空态**（PB-020 E4）：真实 AI 编辑能力还没接，不渲染任何假按钮（没有 disabled chip /
 * 输入框 / 发送键），只说明「尚未接入、不会读改文档」。入口开合与收起把手保留。
 *
 * 开合归 shell：面板自己渲染收起按钮；收起后由 OfficePage 在画布右缘给一个窄「AI」把手。
 * 宽度走 `--office-ai-panel-width`（320），开合只动 width/opacity（`--motion-main` 300ms
 * settle）；`prefers-reduced-motion` 压到 0.01ms（spec §3.2：不是 0，保 transitionend）。
 */
export interface OfficeAiPanelProps {
  /** 生效展开（= 用户手动偏好 && !自动收起，由 OfficePage 用 store 纯函数算好传进来） */
  open: boolean
  /** 是否因内容区过窄被自动收起（只用于 aria/标题文案，不改变 open 语义） */
  autoCollapsed?: boolean
  /** 用户点「收起」（只翻 store 的手动偏好；自动收起状态不受影响） */
  onCollapse: () => void
}

export function OfficeAiPanel({
  open,
  autoCollapsed = false,
  onCollapse
}: OfficeAiPanelProps): React.JSX.Element {
  return (
    <aside
      id="office-ai-panel"
      data-testid="office-ai-panel"
      data-open={open ? 'true' : 'false'}
      data-auto-collapsed={autoCollapsed ? 'true' : 'false'}
      aria-label="AI 助手"
      aria-hidden={open ? undefined : true}
      inert={!open}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden border-hairline bg-(--bg-primary)',
        // 收起时连左缘 1px 也让出来（width:0 + border-box 仍会占 1px 边框线，留一条发丝边不好看）
        open ? 'border-l' : 'border-l-0',
        // 折叠只动宽度/透明度；reduced-motion 压到 0.01ms（不是 0，保 transitionend）
        'transition-[width,opacity] duration-(--motion-main) ease-in-out motion-reduce:[transition-duration:0.01ms]',
        open ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
      style={{ width: open ? 'var(--office-ai-panel-width)' : '0px' }}
    >
      {/* 内容固定面板宽：折叠动画期间文字不重排（宽度由外层裁） */}
      <div
        className="flex h-full min-h-0 flex-col"
        style={{ width: 'var(--office-ai-panel-width)' }}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <Sparkles
            aria-hidden="true"
            className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
          />
          <h2 className="min-w-0 flex-1 truncate text-b2 font-semibold text-ink">AI 助手</h2>
          <span className="shrink-0 rounded-badge border-(length:--hairline-width) border-hairline px-1.5 py-0.5 text-c2 text-ink-tertiary">
            即将接入
          </span>
          <button
            type="button"
            data-testid="office-ai-collapse"
            aria-label="收起 AI 助手"
            title="收起 AI 助手"
            onClick={onCollapse}
            className="no-drag flex size-6 shrink-0 items-center justify-center rounded-badge text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover hover:text-ink"
          >
            <PanelRightClose aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-4 text-center">
          {/* PB-020 E4：诚实空态——能力未接入就不给假按钮（不给 disabled chip / 输入框） */}
          <div data-testid="office-ai-placeholder" className="flex flex-col items-center gap-2">
            <Sparkles aria-hidden="true" className="size-5 text-ink-tertiary" />
            <p className="text-b2 text-ink-secondary">AI 编辑能力尚未接入</p>
            <p className="max-w-56 text-c1 leading-relaxed text-ink-tertiary">
              当前版本不会读取文档内容，也不会产生任何修改。接入后这里会提供总结、润色与校对。
            </p>
          </div>
        </div>
      </div>
    </aside>
  )
}
