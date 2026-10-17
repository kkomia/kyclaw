import { useEffect, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { PixelOtter } from '@renderer/features/brand/PixelOtter'
import type { PixelOtterState } from '@renderer/features/brand/otter-states'
import './welcome.css'

/**
 * 对话初始页的报头（2026-10-18 重设计 A · 信笺，task-50；取代 round 59 的「大图在上、字标在下」）。
 *
 * 挂法（round 59 用户实拍修正"输入框有些偏下"的结论不变）：整块**绝对定位在页脚（输入框那一格）
 * 之上** —— `absolute inset-x-0 bottom-full`，`pb-8` 只留出与页脚之间的呼吸；
 * 整块**不占布局高度**，上下两格（消息区 + welcome-spacer）等分剩余高度，输入框因此落在竖直中位。
 * 页脚那格由 ChatPage 加 `relative` 当挂点；`pointer-events-none` 让这块盖在消息区上的区域不吞点击。
 *
 * 形态（A · 信笺，对照 mock `.superpowers/chat-aesthetics/welcome-redesign/mocks/a/index.html`）：
 *   - 报头 lockup：海獭**印章 96**（left）│ 1px 竖线 54（l2）│ `<kyclaw>` 字标 **56**（衬线 600、
 *     字距 -0.028em，尖括号 accent + weight 400）；900 以下 ×0.85（见 welcome.css）；
 *   - 字标下 26px 一条 **552px hairline**（l2），从中间向两边展开（320ms 一次，reduced 直接终态）；
 *   - tagline 17/1.6（衬线、ink-2）；节奏 26/18（报头→线→tagline），靠线分段不靠盒子。
 *   - 海獭保持 wave→float（首挂载 1.2s 后 float；reduced-motion 首帧直接 float 静态）。
 *   - **不引入** mock 里的「空闲」「每次询问」等 UI 文案；task-53 按用户口径删掉了
 *     「本地运行，文件不出这台机器」那一行（连同 .welcome-note 与 8px 间距），不留孤零零的大空。
 *   - 一屏一只：初始页只有报头这只海獭（角落氛围位 + presence 让位逻辑已在 task-53 删除；
 *     header 状态灯在 hero 期间由 welcome.css 的 :has 规则隐起）。
 *
 * 动效：进场仍用既有 `animate-message-in`（淡入 + 4–6px 上浮），页脚晚 80ms 起步；离场切
 * `animate-fade-out`（150ms）——绝对定位没有高度可收合；reduced-motion 由全站兜底压 0.01ms。
 * 出现过就不再卸载（离场要过渡）：挂载时就有历史消息的会话根本不渲染它；离场后留在 DOM 里
 * （opacity 0 + pointer-events-none，不占高度、不影响布局）。
 *
 * 纸感纹理/暖光不在这一块里：铺满内容区的 `.welcome-paper` 由 ChatPage 挂（见 welcome.css §1），
 * 可一键关（--welcome-texture/--welcome-glow）。
 */
/** 首帧就按系统偏好决定（reduced-motion 不播 wave）；jsdom 没有 matchMedia 时按 false */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function WelcomeHero({ active }: { active: boolean }): React.JSX.Element | null {
  // render 期按 props 调 state（React 文档认可的写法；不走 effect 就没有级联渲染）
  const [everActive, setEverActive] = useState(active)
  if (active && !everActive) setEverActive(true)

  // 海獭：首挂载 wave → 1.2s 后 float；reduced-motion 首帧就是 float（静态帧由 CSS 停在 #0）
  const [otterState, setOtterState] = useState<PixelOtterState>(() =>
    prefersReducedMotion() ? 'float' : 'wave'
  )
  useEffect(() => {
    if (!active || prefersReducedMotion()) return
    const timer = setTimeout(() => setOtterState('float'), 1200)
    return () => clearTimeout(timer)
  }, [active])

  if (!everActive) return null

  return (
    <div
      data-testid="welcome-hero"
      data-active={active ? 'true' : 'false'}
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-full px-4 pb-8 text-center',
        active ? 'animate-message-in' : 'animate-fade-out'
      )}
    >
      {/* 报头：印章（96）│ 竖线 │ 字标（56）；装饰性海獭不可点，字标结构保持 `<span>&lt;</span>kyclaw…` 不变 */}
      <div className="welcome-lockup">
        <PixelOtter
          state={otterState}
          size={96}
          paused={!active}
          title="kyclaw"
          className="welcome-otter welcome-seal"
        />
        <span className="welcome-mark-rule" aria-hidden="true" />
        <h1 data-testid="welcome-title" className="welcome-title font-semibold text-ink">
          <span className="welcome-bracket text-accent-text">&lt;</span>
          kyclaw
          <span className="welcome-bracket text-accent-text">&gt;</span>
        </h1>
      </div>
      {/* 报头下 26px 的一条 552px 细线：把「名字」和「一句话」分开（靠线分段，不靠盒子）；
          task-53：细线后只留 tagline（中文小字整行删除，间距回到 26/18 的紧凑节奏） */}
      <div data-testid="welcome-hair" className="welcome-hair" aria-hidden="true" />
      <p data-testid="welcome-tagline" className="welcome-tagline text-ink-secondary">
        What needs doing, done.
      </p>
    </div>
  )
}
