import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 对话初始页的品牌标题（round 59）：空会话时输入框居中，标题在它上面居中偏上
 * （居中由 ChatPage 那三格弹性分配做出来 —— 消息区与页脚下面的 welcome-spacer 等分剩余高度）。
 *
 * 形态取参考里最简的一版（Kimi Code）：品牌名一行大字，`ky` 用主文字色、`claw` 用强调色
 * （--accent-text）；下面一行次级品牌语，同一个字族、次要层级。
 * **不加任何多余小字 / 提示 / 菜单**（用户口径：首页必须简洁）。
 *
 * 动效（都不硬切）：
 *   - 进场：整块淡入 + 6px 上浮 —— 既有 `animate-message-in`（主档 .3s / CLP ease-out）；
 *     输入框那一侧由 ChatPage 的页脚用同一套动画、晚 80ms 起步（标题先落，输入框跟上来）。
 *   - 离场：`.trace-fold` 的 grid-template-rows 1fr → 0fr 收合（与过程块同一套配方，
 *     主档 .3s / --clp-ease-out）—— 首条消息发出切常规布局时标题淡出收起。
 *
 * 出现过就不再卸载（与 TraceFold 的 everOpened / ProjectList 的会话折叠同一套口径）：
 * 挂载时就有历史消息的会话（压根没有初始页）根本不渲染它。
 */
export function WelcomeHero({ active }: { active: boolean }): React.JSX.Element | null {
  // render 期按 props 调 state（React 文档认可的写法；不走 effect 就没有级联渲染）
  const [everActive, setEverActive] = useState(active)
  if (active && !everActive) setEverActive(true)
  if (!everActive) return null

  return (
    <div
      data-testid="welcome-hero"
      data-open={active ? 'true' : 'false'}
      className={cn('trace-fold shrink-0', active && 'animate-message-in')}
    >
      <div className="trace-fold-in">
        <div className="px-4 pb-8 text-center">
          <h1 data-testid="welcome-title" className="welcome-title font-semibold text-ink">
            ky<span className="text-accent-text">claw</span>
          </h1>
          <p className="pt-3 text-b2 text-ink-tertiary">帮你把活干完</p>
        </div>
      </div>
    </div>
  )
}
