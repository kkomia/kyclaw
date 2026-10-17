/**
 * 等待行（P1b 配方 4）：`status === 'submitted'` 且这一轮还没有任何 assistant 文本时出现 ——
 * 三点按 `--motion-dot`（500ms）错开弹跳 + 「正在思考…」文字走 `--motion-sweep` 扫光。
 *
 * 之前这个状态是**空白**（只有 composer 的停止键）；现在补一行，既有"在做事"的反馈，
 * 又不提前渲染尚未到达的内容。reduced-motion 下三点静止、文字回到普通灰（chat-motion.css）。
 */
import { cn } from '@renderer/components/ui/cn'

export function WaitingLine({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      data-testid="waiting-line"
      role="status"
      aria-live="polite"
      className={cn('chat-waiting text-c1 text-ink-tertiary', className)}
    >
      <span className="chat-waiting-dots" aria-hidden="true">
        <span className="chat-waiting-dot" />
        <span className="chat-waiting-dot" />
        <span className="chat-waiting-dot" />
      </span>
      <span className="trace-live">正在思考…</span>
    </div>
  )
}
