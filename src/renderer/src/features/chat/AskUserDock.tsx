import { cn } from '@renderer/components/ui/cn'
import { AskUserCard, type AskUserCardProps } from './AskUserCard'
import { askUserCallKey, type AskUserCallIdentity } from './ask-user-ui'

export type AskUserDockRequest = AskUserCallIdentity & AskUserCardProps

export interface AskUserDockProps {
  requests: readonly AskUserDockRequest[]
}

/**
 * 提问停靠区（round 82 调整）。
 *
 * 三条硬口径：
 *   - **不铺技术标签**：原先每条调用上方常显「问题调用 N」+ 折叠的「调用详情」（会话 / 轮次 /
 *     调用），用户口径要的是提问本身。编号与三元组不再进可见层；调用身份仍留在
 *     `data-call-key` 与 item 的 `aria-label` 里 —— 多条待答调用仍各自可辨、全部可访问。
 *   - **自身不设 max-height / overflow-y-auto**：这两个约束会形成"卡里再滚一层"的嵌套滚动，
 *     把当前题裁在可视区外、主操作要滚才点得到。当前题因此自然撑开、完整展示；
 *     真放不下（极小窗口 / 超长题）由外层停靠区滚动兜底（见 ChatPage 的停靠区夹高），
 *     不在这里用 `overflow-hidden` 或隐藏滚动条糊过去。
 *   - **一条调用一张卡**：多题分页在卡内（见 AskUserCard），这里只叠卡片。
 */
export function AskUserDock({ requests }: AskUserDockProps): React.JSX.Element {
  const open = requests.length > 0
  return (
    <div
      data-testid="ask-user-dock"
      data-open={open ? 'true' : 'false'}
      className={cn(
        'grid min-h-0 min-w-0 shrink-0 transition-[grid-template-rows] duration-(--motion-main) ease-main motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        {open ? (
          <section
            aria-label="待回答的工具调用"
            className="mx-auto flex w-full min-w-0 max-w-(--chat-input-max-width) flex-col gap-2 pb-2 [overflow-wrap:anywhere]"
          >
            {requests.map(({ threadId, runId, toolCallId, ...cardProps }) => {
              const key = askUserCallKey({ threadId, runId, toolCallId })
              return (
                <section
                  key={key}
                  data-testid="ask-user-dock-item"
                  data-call-key={key}
                  aria-label={`待回答的提问：${toolCallId}`}
                  className="min-w-0"
                >
                  <AskUserCard {...cardProps} />
                </section>
              )
            })}
          </section>
        ) : null}
      </div>
    </div>
  )
}
