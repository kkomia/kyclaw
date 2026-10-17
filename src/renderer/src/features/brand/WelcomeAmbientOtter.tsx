/**
 * welcome 初始页右上角的**氛围小海獭**（rev3 第四落点，用户原话"这个位置的海獭还没有"）。
 *
 * 位置/尺寸（task-49 + manifest.usage.ambientWelcome）：页面内容区右上角 absolute 内缩
 * 12px（<900 8px，<720 整个隐藏）；宽窗 32 / 窄窗 24（CSS 覆盖 `--otter-size`）。
 * 只有 `idle` 一档；纯装饰：`aria-hidden` + `pointer-events:none`，不参与布局、不吃点击。
 *
 * 生命周期：hero（空会话初始页）时在场；首条消息发出（hero 结束）后 **150ms 淡出再卸载**
 * （不硬切；同一挂里 ChatHeader 的状态灯这时才接棒，见 ChatHeader 的 `useWelcomeHeroVisible`）。
 * 切回空会话（hero 重新成立）时重新挂上。
 *
 * 实现纪律：不在 effect 里同步 setState（本仓 react-hooks/set-state-in-effect 是 error）——
 * 重新挂载走 render 期条件派生；离场只用一个 150ms 定时器（回调里 setState 是允许的）。
 */
import { useEffect, useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { PixelOtter } from './PixelOtter'

/** 离场淡出时长（与 CSS 的 transition 同档；淡完才卸载） */
export const AMBIENT_OTTER_FADE_MS = 150

export function WelcomeAmbientOtter({ active }: { active: boolean }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(active)

  // hero 重新成立（例如切回一个空会话）→ 立刻重新挂上（render 期派生，不触发级联渲染）
  if (active && !mounted) setMounted(true)

  useEffect(() => {
    if (active || !mounted) return
    const timer = setTimeout(() => setMounted(false), AMBIENT_OTTER_FADE_MS)
    return () => clearTimeout(timer)
  }, [active, mounted])

  if (!mounted) return null

  return (
    <div
      data-testid="welcome-ambient-otter"
      data-active={active ? 'true' : 'false'}
      aria-hidden="true"
      className={cn(
        'welcome-ambient-otter',
        active ? 'opacity-100' : 'pointer-events-none opacity-0'
      )}
    >
      <PixelOtter state="idle" size={32} title="kyclaw" />
    </div>
  )
}
