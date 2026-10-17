import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@renderer/components/ui/button'

/**
 * 流报错卡（Review Focus #2：流中断 / 供应商错误）。
 * - 任何流错误都落在这里：错误原文 + 重试（重发上一条用户消息，见 ChatPage 的 retry）；
 * - 401 类（Key 缺/失效）额外给一条去设置页的指引 —— 设置页的模型组在 T8，这里只指向入口。
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

export function ErrorCard({ error, onRetry }: ErrorCardProps): React.JSX.Element {
  return (
    <div
      data-testid="error-card"
      role="alert"
      className="animate-fade-in flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline border-l-2 border-l-danger bg-(--bg-primary) px-4 py-3"
    >
      <div className="flex items-center gap-2 font-sans text-b2 font-semibold text-ink">
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-danger" />
        这一轮没有完成
      </div>
      <p data-testid="error-message" className="text-c1 break-all text-ink-secondary">
        {error.message}
      </p>
      {isAuthError(error) ? (
        <p data-testid="error-auth-hint" className="text-c1 text-ink-secondary">
          模型密钥可能缺失或失效，请到
          <Link to="/settings" className="text-accent-text underline">
            设置
          </Link>
          里检查模型与 Key。
        </p>
      ) : null}
      <div>
        <Button size="sm" variant="ghost" data-testid="error-retry" onClick={onRetry}>
          重试
        </Button>
      </div>
    </div>
  )
}
