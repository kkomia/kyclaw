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
  /**
   * 「清空重来」= 现状语义：服务端 truncate 掉失败那条助手消息及其之后 + 客户端 regenerate。
   * 保留 testid `error-retry`（既有用例与闸门语义不变）。
   */
  onRetry: () => void
  /**
   * PB-035 B′：「保留内容再试」——不清空、不 truncate、不 regenerate，新起一轮，
   * 新回复追加在旧内容之后（见 retry-keep.ts）。只有 `preservedRecords > 0` 时才提供。
   */
  onRetryKeep?: () => void
  /** 失败轮里用户看得见的记录条数（非空正文 + 工具调用）；0 = 什么都没产出来 */
  preservedRecords?: number
  /** PB-038：启动失败态把主按钮文案换成「重启应用」（默认仍是「再跑一次」） */
  retryLabel?: string
  retryDisabled?: boolean
  /** PB-038：主按钮上方的一句口径（如「重启后会重新加载内核」） */
  retryHint?: string
  /** PB-038：重启被退出守卫拒绝/失败时的可读提示（role=alert） */
  retryNote?: string | null
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
 *
 * 只在文件内用（不 export）：`react-refresh/only-export-components` 要求组件文件只导出组件；
 * 这个纯函数没有跨文件消费者，留在本文件里即可。
 */
function describeError(error: Error): string {
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

export function ErrorCard({
  error,
  onRetry,
  onRetryKeep,
  preservedRecords = 0,
  retryLabel,
  retryDisabled = false,
  retryHint,
  retryNote = null
}: ErrorCardProps): React.JSX.Element {
  // PB-035 B′：失败轮已经有产出 → 给"保留/清空"两条路；什么都没产出 → 只留一个按钮（没有分叉的必要）
  const keepAvailable = onRetryKeep !== undefined && preservedRecords > 0
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
      {/*
        PB-035 B′ 顺序按 Gwen 的 720 规格（§2）：**说明 → 主按钮 → 详情**。
        理由：说明解释两条路各自的后果，应紧贴主按钮 8px；「详情」是第三层信息放最后，
        破坏性的「清空重来」在 DOM/Tab 顺序上也落到最后（主按钮 → summary → 清空重来）。
      */}
      {keepAvailable ? (
        <p
          data-testid="error-preserve-note"
          className="min-w-0 break-words text-c1 text-ink-tertiary"
        >
          已产生 {preservedRecords} 条记录：
          <span className="whitespace-nowrap">「保留内容再试」</span>会保留
          {preservedRecords === 1 ? '它' : '它们'}并接着跑；
          <span className="whitespace-nowrap">「清空重来」</span>会清空
          {preservedRecords === 1 ? '它' : '它们'}重跑。
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {keepAvailable ? (
          <Button size="sm" variant="ghost" data-testid="error-retry-keep" onClick={onRetryKeep}>
            保留内容再试
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="error-retry"
            onClick={onRetry}
            disabled={retryDisabled}
          >
            {retryLabel ?? '再跑一次'}
          </Button>
        )}
      </div>
      {retryHint === undefined ? null : (
        <p data-testid="error-retry-hint" className="min-w-0 break-words text-c1 text-ink-tertiary">
          {retryHint}
        </p>
      )}
      {retryNote === null ? null : (
        <p
          data-testid="error-retry-note"
          role="alert"
          className="min-w-0 break-words text-c1 text-warning"
        >
          {retryNote}
        </p>
      )}
      <details data-testid="error-details" className="min-w-0 text-c1 text-ink-tertiary">
        <summary className="inline-flex min-h-6 cursor-pointer items-center select-none">
          详情
        </summary>
        <pre
          data-testid="error-raw"
          className="mt-1 max-w-full min-w-0 overflow-x-hidden font-mono break-all whitespace-pre-wrap text-ink-secondary"
        >
          {error.message}
        </pre>
        {/* 有产出时「清空重来」收进详情里：破坏性动作多一步（展开详情）且排在最后 */}
        {keepAvailable ? (
          <div className="mt-2 flex min-w-0">
            <Button
              size="sm"
              variant="ghost"
              data-testid="error-retry"
              onClick={onRetry}
              className="text-ink-tertiary"
            >
              清空重来
            </Button>
          </div>
        ) : null}
      </details>
    </div>
  )
}
