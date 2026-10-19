import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@renderer/components/ui/button'

/**
 * 流报错卡（Review Focus #2：流中断 / 供应商错误）。
 * - 任何流错误都落在这里：错误原文 + 重试（重发上一条用户消息，见 ChatPage 的 retry）；
 * - 401 类（Key 缺/失效）额外给一条去设置页的指引 —— 设置页的模型组在 T8，这里只指向入口。
 *
 * PB-036（2026-10-19 用户：「报错的那个框，ui也没对齐」）：
 * - 主文案中文可读，**原始错误串收进「详情」**（不删、可展开；是否默认收起等用户确认）；
 * - 卡片内所有行同一左缩进（px-4）与同一栅格；长错误串等宽 + `break-all` 折行不溢出；
 * - 重试按钮热区走 Button sm（26px ≥ 26px），窄档（720）不横向溢出。
 */
export interface ErrorCardProps {
  error: Error
  onRetry: () => void
}

/** 认证类错误：HTTP 401（APICallError.statusCode）或文案里带 key/unauthorized/authentication */
function isAuthError(error: Error): boolean {
  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (statusCode === 401) return true
  return /401|unauthorized|authentication|api[-_ ]?key|密钥/i.test(error.message)
}

/**
 * 给用户看的主文案（中文）；原始串仍保留在详情区。
 * 已经是中文的人话（如「agent 服务未启动」）原样显示，不改写事实。
 */
export function describeError(error: Error): string {
  const message = error.message ?? ''
  if (isAuthError(error)) return '模型密钥缺失或失效，请检查模型与 Key 后重试。'
  if (
    /agent 服务未启动|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|network|timed? ?out/i.test(
      message
    )
  ) {
    return '连接中断：请检查网络或本地服务后重试。'
  }
  if (/\b(429|500|502|503|504)\b|overloaded|rate limit|unavailable/i.test(message)) {
    return '服务暂时不可用，请稍后重试。'
  }
  if (/abort|cancel|aborted/i.test(message)) return '生成已中断，可重试。'
  if (/[\u4e00-\u9fff]/.test(message)) return message
  return '本轮生成失败，可重试。原始信息见下方详情。'
}

export function ErrorCard({ error, onRetry }: ErrorCardProps): React.JSX.Element {
  return (
    <div
      data-testid="error-card"
      role="alert"
      className="animate-fade-in flex min-w-0 flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline border-l-2 border-l-danger bg-(--bg-primary) px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-2 font-sans text-b2 font-semibold text-ink">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <span className="min-w-0">这一轮没有完成</span>
      </div>
      <p data-testid="error-message" className="min-w-0 break-words text-c1 text-ink-secondary">
        {describeError(error)}
      </p>
      {isAuthError(error) ? (
        <p data-testid="error-auth-hint" className="min-w-0 break-words text-c1 text-ink-secondary">
          模型密钥可能缺失或失效，请到
          <Link to="/settings" className="text-accent-text underline">
            设置
          </Link>
          里检查模型与 Key。
        </p>
      ) : null}
      <details data-testid="error-details" className="min-w-0 text-c1 text-ink-tertiary">
        <summary className="cursor-pointer select-none">详情</summary>
        <pre
          data-testid="error-raw"
          className="mt-1 max-w-full min-w-0 overflow-x-hidden font-mono break-all whitespace-pre-wrap text-ink-secondary"
        >
          {error.message}
        </pre>
      </details>
      <div>
        <Button size="sm" variant="ghost" data-testid="error-retry" onClick={onRetry}>
          重试
        </Button>
      </div>
    </div>
  )
}
