import { describe, expect, it } from 'vitest'
import { CHAT_FOLLOW, isNearBottom, stepFollow } from '../use-chat-follow'

/** 连续喂帧直到落定（返回帧数与终态） */
function run(
  start: number,
  target: number,
  dt = 16.7,
  maxFrames = 2000
): { frames: number; position: number; velocity: number; done: boolean } {
  let state = { position: start, velocity: 0 }
  for (let frame = 1; frame <= maxFrames; frame += 1) {
    const result = stepFollow(state, target, dt)
    state = { position: result.position, velocity: result.velocity }
    if (result.done)
      return { frames: frame, position: result.position, velocity: result.velocity, done: true }
  }
  return { frames: maxFrames, position: state.position, velocity: state.velocity, done: false }
}

describe('聊天区滚动弹簧（doc §2.1 参数）', () => {
  it('临界阻尼：从 0 追到 1000px 落定到精确值，速度归零', () => {
    const result = run(0, 1000)
    expect(result.done).toBe(true)
    expect(result.position).toBe(1000)
    expect(result.velocity).toBe(0)
    // 不是瞬移：至少 6 帧（100ms）才到
    expect(result.frames).toBeGreaterThanOrEqual(6)
  })

  it('限速：相邻帧位移 ≤ maxSpeed × Δt（大目标也稳速滑过去）', () => {
    let state = { position: 0, velocity: 0 }
    let previous = state.position
    const target = 40_000
    // 第一帧会做 lead 跳（>1200px），从第二帧起检查限速
    state = stepFollow(state, target, CHAT_FOLLOW.dtMaxMs)
    previous = state.position
    for (let frame = 0; frame < 120; frame += 1) {
      state = stepFollow(state, target, CHAT_FOLLOW.dtMaxMs)
      const delta = Math.abs(state.position - previous)
      expect(delta).toBeLessThanOrEqual(CHAT_FOLLOW.maxSpeed * (CHAT_FOLLOW.dtMaxMs / 1000) + 1)
      previous = state.position
    }
  })

  it('大跳追赶：离目标 >1200px 先跳到 target∓1200 再滑完', () => {
    const result = stepFollow({ position: 0, velocity: 0 }, 5000, 16.7)
    expect(result.position).toBeGreaterThan(3000)
    expect(result.position).toBeLessThan(5000)
    // 反向同理（往上回滚）
    const back = stepFollow({ position: 5000, velocity: 0 }, 0, 16.7)
    expect(back.position).toBeLessThan(2000)
  })

  it('帧 Δt 夹在 [16.7, 64]ms（0ms 不除零、超大帧不爆冲）', () => {
    const tiny = stepFollow({ position: 0, velocity: 0 }, 100, 0)
    expect(Number.isFinite(tiny.position)).toBe(true)
    const huge = stepFollow({ position: 0, velocity: 0 }, 100, 10_000)
    expect(Number.isFinite(huge.position)).toBe(true)
    expect(Math.abs(huge.velocity)).toBeLessThanOrEqual(CHAT_FOLLOW.maxSpeed + 1)
  })

  it('贴底 25px 判定（普通容器）', () => {
    expect(isNearBottom(975, 2000, 1000)).toBe(true) // 距离 25
    expect(isNearBottom(974, 2000, 1000)).toBe(false) // 距离 26
    expect(isNearBottom(0, 1000, 1000)).toBe(true)
  })
})
