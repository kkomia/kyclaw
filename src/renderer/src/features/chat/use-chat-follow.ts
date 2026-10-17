/**
 * 聊天区滚动跟随（动效 B · doc §2.1）：把 dsh-claude-style 的「弹簧跟随」搬成纯函数 + hook。
 *
 * 参数（doc 原文）：ω=28 s⁻¹、ζ=1（临界阻尼）、力上限 24000 px/s²、速度上限 2400 px/s、
 * 子步 1ms、帧 Δt 夹 [16.7, 64]ms；贴底判定 25px；离目标 >1200px 先跳到 target∓1200 再滑完；
 * |target-x|≤0.5px 且 |v|≤10px/s 落定。
 *
 * 关闭（`chatScroll=false`）或减弱（`reduced`）时直接写 scrollTop（P1b 原行为，零动画）。
 * 用户主动上滚 = reader-hold；回到贴底阈值内才恢复跟随；程序自己写的 scrollTop 不当用户滚动。
 */
import { useEffect, useRef, type RefObject } from 'react'

export const CHAT_FOLLOW = {
  omega: 28,
  zeta: 1,
  maxAccel: 24_000,
  maxSpeed: 2_400,
  lead: 1_200,
  stickPx: 25,
  settlePx: 0.5,
  settleVelocity: 10,
  dtMinMs: 16.7,
  dtMaxMs: 64,
  subStepMs: 1
} as const

export interface FollowState {
  position: number
  velocity: number
}

export interface FollowStepResult extends FollowState {
  done: boolean
}

/** 一帧弹簧积分（纯函数；test 直接喂帧） */
export function stepFollow(
  state: FollowState,
  target: number,
  dtMs: number,
  options: Partial<typeof CHAT_FOLLOW> = {}
): FollowStepResult {
  const opts = { ...CHAT_FOLLOW, ...options }
  const dt = Math.min(Math.max(dtMs, opts.dtMinMs), opts.dtMaxMs)
  let position = state.position
  let velocity = state.velocity

  // 远距离：先跳到 target∓lead（远距离不拖尾），再像弹簧一样滑完
  const distance = target - position
  if (Math.abs(distance) > opts.lead) {
    position = target - Math.sign(distance) * opts.lead
    velocity = 0
  }

  let remaining = dt
  while (remaining > 0) {
    const step = Math.min(opts.subStepMs, remaining)
    remaining -= step
    const seconds = step / 1000
    const accel = Math.min(
      Math.max(
        opts.omega * opts.omega * (target - position) - 2 * opts.zeta * opts.omega * velocity,
        -opts.maxAccel
      ),
      opts.maxAccel
    )
    velocity = Math.min(Math.max(velocity + accel * seconds, -opts.maxSpeed), opts.maxSpeed)
    position += velocity * seconds
  }

  const done =
    Math.abs(target - position) <= opts.settlePx && Math.abs(velocity) <= opts.settleVelocity
  if (done) {
    return { position: target, velocity: 0, done: true }
  }
  return { position: Math.max(0, position), velocity, done: false }
}

/** 贴底判定（doc：普通容器 25px） */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = CHAT_FOLLOW.stickPx
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/**
 * 聊天区跟随 hook。
 * @param viewRef 滚动容器
 * @param tail 内容签名（每来一帧新内容变一次）
 * @param enabled `chatScroll`；false/reduced 时瞬时贴底，行为与 P1b 一致
 */
export function useChatFollow({
  viewRef,
  tail,
  enabled
}: {
  viewRef: RefObject<HTMLDivElement | null>
  tail: string
  enabled: boolean
}): { onScroll: () => void } {
  const stickyRef = useRef(true)
  const stateRef = useRef<FollowState>({ position: 0, velocity: 0 })
  const frameRef = useRef<number | null>(null)
  const lastWrittenRef = useRef(0)
  const lastFrameAtRef = useRef(0)

  const cancel = (): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return undefined
    const target = view.scrollHeight - view.clientHeight

    // 关闭/减弱：直接到目标（P1b 原行为，零动画）
    if (!enabled) {
      if (stickyRef.current) {
        view.scrollTop = target
        lastWrittenRef.current = view.scrollTop
      }
      return undefined
    }

    if (!stickyRef.current) return undefined
    cancel()
    stateRef.current.position = view.scrollTop
    stateRef.current.velocity = 0
    lastFrameAtRef.current = 0

    const tick = (now: number): void => {
      const container = viewRef.current
      if (container === null) {
        frameRef.current = null
        return
      }
      const goal = container.scrollHeight - container.clientHeight
      const dt = lastFrameAtRef.current === 0 ? CHAT_FOLLOW.dtMinMs : now - lastFrameAtRef.current
      lastFrameAtRef.current = now
      const next = stepFollow(stateRef.current, goal, dt)
      stateRef.current = next
      container.scrollTop = next.position
      lastWrittenRef.current = container.scrollTop
      if (next.done) {
        frameRef.current = null
        return
      }
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)

    return () => cancel()
  }, [tail, enabled, viewRef])

  useEffect(() => cancel, [])

  const onScroll = (): void => {
    const view = viewRef.current
    if (view === null) return
    const nearBottom = isNearBottom(view.scrollTop, view.scrollHeight, view.clientHeight)
    // 动画自己写的 scrollTop：不算用户滚动（差值 ≤1.5px 让位）
    const userScrolled = Math.abs(view.scrollTop - lastWrittenRef.current) > 1.5
    if (userScrolled && frameRef.current !== null) {
      cancel()
    }
    stickyRef.current = nearBottom
    if (!nearBottom) cancel()
  }

  return { onScroll }
}
