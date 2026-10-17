import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 对话初始页的品牌标题（round 59）：空会话时输入框竖直居中、标题在它正上方居中。
 *
 * 挂法（round 59 用户实拍修正："输入框有些偏下"）：标题**绝对定位在页脚（输入框那一格）之上**
 * —— `absolute inset-x-0 bottom-full`，`pb-6` 只留出与输入框之间的间距：整块**不占布局高度**。
 * 上下两格（消息区 + welcome-spacer）因此等分剩余高度，输入框是真·竖直居中（此前标题是流内元素，
 * 把输入框整体压下标题高度的一半）。页脚那格由 ChatPage 加 `relative` 当挂点；`pointer-events-none`
 * 让这块盖在消息区上的区域不吞点击。
 *
 * 标题形态对齐 KIMI `<Code>`：品牌名带尖括号，**括号用强调色**（`text-accent-text`，P0 起 = 陶土橙
 * `--link`/`--accent-text`；token 自动跟随）、中间的 `kyclaw` 用主文字色。
 * tagline（章程 §9.2/D-25，用户 2026-10-18 拍板）：英文禅意 **`What needs doing, done.`**，
 * 衬线 16/1.6（`welcome-tagline`，阅读声部）、次墨色；下面保留一行中文小字「本地运行，文件不出这台机器」
 * （sans 12、三级可读档 —— 它是承载信息的小字，不是 caption 装饰档）。
 * **不加任何多余小字 / 提示 / 菜单**（用户口径：首页必须简洁）。
 *
 * 动效（都不硬切）：
 *   - 进场：整块淡入 + 6px 上浮 —— 既有 `animate-message-in`（主档 .3s / CLP ease-out）；
 *     输入框那一侧由 ChatPage 的页脚用同一套动画、晚 80ms 起步（标题先落，输入框跟上来）。
 *   - 离场：切 `animate-fade-out`（快档 .15s）——绝对定位没有高度可收合，收合那套用不上；
 *     两个动画的首尾状态都是 opacity 1 → 0，换类不跳帧（不硬切）。reduced-motion 由全站
 *     兜底规则把时长压到 0.01ms（**不加** animate-none：那会让标题停在可见态）。
 *
 * 出现过就不再卸载（离场要过渡）：挂载时就有历史消息的会话（压根没有初始页）根本不渲染它；
 * 离场后留在 DOM 里（opacity 0 + pointer-events-none，不占高度、不影响布局）。
 */
export function WelcomeHero({ active }: { active: boolean }): React.JSX.Element | null {
  // render 期按 props 调 state（React 文档认可的写法；不走 effect 就没有级联渲染）
  const [everActive, setEverActive] = useState(active)
  if (active && !everActive) setEverActive(true)
  if (!everActive) return null

  return (
    <div
      data-testid="welcome-hero"
      data-active={active ? 'true' : 'false'}
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-full px-4 pb-6 text-center',
        active ? 'animate-message-in' : 'animate-fade-out'
      )}
    >
      <h1 data-testid="welcome-title" className="welcome-title font-semibold text-ink">
        <span className="text-accent-text">&lt;</span>
        kyclaw
        <span className="text-accent-text">&gt;</span>
      </h1>
      <p data-testid="welcome-tagline" className="welcome-tagline pt-3 text-ink-secondary">
        What needs doing, done.
      </p>
      <p data-testid="welcome-local-note" className="pt-1 text-c1 text-ink-tertiary-readable">
        本地运行，文件不出这台机器
      </p>
    </div>
  )
}
