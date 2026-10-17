import { PanelRightClose, Send, Sparkles } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'

/**
 * Office 右侧 AI 面板 v1（A3，`office-ui-redesign-spec` §6.1/§7-A3）。
 *
 * **诚实占位**：真实 AI 编辑能力还没接（等后续专门任务），所以这里只做结构与文案，
 * 不做任何假动作——3 个建议 chip、composer、发送按钮全部 disabled；不发送请求、不写文档、
 * 不产生"假装在思考"的动效。面板只在 shell 侧（iframe 右边），不新增任何 postMessage 协议；
 * 面内 ribbon 的 AI 按钮仍是 A2 的禁用占位（跨面没有通道，A3 不动它）。
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

/** 三个建议 chip 的示例文案（disabled；不产生任何动作/回调） */
const AI_SUGGESTIONS = ['总结这份文档', '润色选中的段落', '检查错别字'] as const

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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {/*
            诚实说明：占位面板不读内容、不产生修改。
            P3（章程 §9.7-6）：唯一允许 accent 的装饰面 —— 左侧 2px 陶土橙线；其余 chrome 不引 accent。
          */}
          <div
            data-testid="office-ai-placeholder"
            className="flex flex-col gap-2 border-l-2 border-l-(--accent) pl-3"
          >
            <p className="text-b2 text-ink-secondary">
              AI 编辑能力将在后续版本接入。当前可以先用主对话处理文档内容。
            </p>
            <p className="text-c1 text-ink-tertiary">
              此面板是占位：不会读取文档内容，也不会产生任何修改。
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {/* 装饰眉题按章程改为正常大小写 11/500 三级灰（中文不做全大写、也不额外拉字距） */}
            <p className="text-[11px] font-medium text-ink-tertiary">试试这些</p>
            <div className="flex flex-col items-stretch gap-2">
              {AI_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  data-testid="office-ai-chip"
                  disabled
                  title="AI 编辑能力接入后可用"
                  className="flex items-center gap-2 rounded-control border-(length:--hairline-width) border-hairline px-3 py-2 text-left text-b2 text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{suggestion}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* composer：disabled 占位（输入框 + 发送都不接任何动作） */}
        <div className="flex shrink-0 flex-col gap-2 border-t border-hairline p-3">
          <div className="flex items-end gap-2 rounded-control border-(length:--hairline-width) border-hairline bg-(--bg-secondary) px-2 py-1.5">
            <textarea
              data-testid="office-ai-composer"
              rows={2}
              disabled
              aria-label="AI 指令（即将接入）"
              placeholder="AI 编辑能力接入后可用"
              className="min-h-0 w-full resize-none bg-transparent text-b2 text-ink placeholder:text-ink-tertiary disabled:cursor-not-allowed"
            />
            <button
              type="button"
              data-testid="office-ai-send"
              disabled
              aria-label="发送（即将接入）"
              title="AI 编辑能力接入后可用"
              className="flex size-7 shrink-0 items-center justify-center rounded-badge bg-(--fill-disabled) text-ink-tertiary disabled:cursor-not-allowed"
            >
              <Send aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
