/**
 * 等待行 / 状态行（P1b 配方 4 + 动效 B §2.2/§2.3）：
 *   - `submitted` 且本轮还没有 assistant 正文时出现；
 *   - 三点按 `--motion-dot` 错开弹跳（statusLine 关/reduced 时静止不渲染点）；
 *   - 文字 = 精确/粗粒度状态词（`deriveStatusWord`），1s 锁、10s 超时；
 *   - 画法按 `statusPaint`：sweep（`.trace-live` 扫光）/ wash（`.trace-wash` 渐变流动）；
 *   - 换词动画 `.chat-swap`（150 + 50ms/±8px/blur2），statusLine 关时静态直切。
 */
import type { ChatStatus, UIMessage } from 'ai'
import { cn } from '@renderer/components/ui/cn'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { useStatusWord } from '../status-line'

export interface WaitingLineProps {
  status: ChatStatus
  messages: readonly UIMessage[]
  className?: string
}

export function WaitingLine({ status, messages, className }: WaitingLineProps): React.JSX.Element {
  const motion = useEffectiveMotion()
  const { word } = useStatusWord({
    status,
    messages,
    precise: motion.preciseStatus,
    enabled: motion.statusLine
  })
  const paint = motion.statusLine
    ? motion.statusPaint === 'wash'
      ? 'trace-wash'
      : 'trace-live'
    : undefined

  return (
    <div
      data-testid="waiting-line"
      role="status"
      aria-live="polite"
      data-status-paint={motion.statusPaint}
      className={cn('chat-waiting text-c1 text-ink-tertiary', className)}
    >
      {motion.statusLine ? (
        <span className="chat-waiting-dots" aria-hidden="true">
          <span className="chat-waiting-dot" />
          <span className="chat-waiting-dot" />
          <span className="chat-waiting-dot" />
        </span>
      ) : null}
      <span key={word} className={cn(paint, motion.statusLine && 'chat-swap')}>
        {word}
      </span>
    </div>
  )
}
