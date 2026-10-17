/**
 * 消息气泡入场（动效 B · doc §2.6）：从 Composer 输入卡的真实 rect 飞到消息气泡原位。
 *
 * 首版范围（doc 推荐）：**不做插件幽灵层 / 45% morph / 150ms 交棒**，直接让真实气泡自己从
 * 输入卡位置飞到目标位（400ms、弹簧 ζ=.75/ω=7.5 采样成 linear WAAPI keyframes、起点 scale .6），
 * 语义≈「从输入框飞上来」的 80%；`messageEnter='grow'` 时走 CSS 的 320ms scale0→1（origin 右下）。
 *
 * 量不到 rect（切窗、空会话、刚启动）→ `animateSendFlight` 返回 null，调用方退 CSS grow 或不动。
 */
export const SEND_FLIGHT_MS = 400
/** grow 的 CSS 侧时长（chat-motion.css 同时写 320ms；这里给测试/JS 兜底共用） */
export const SEND_GROW_MS = 320

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

interface ComposerRectMemory {
  rect: RectLike
}

/** 提交那一刻量到的 Composer 卡 rect（模块级：Composer.submit → Message layout effect 读） */
let composerRectMemory: ComposerRectMemory | null = null

export function rememberComposerRect(rect: RectLike | DOMRect | null): void {
  composerRectMemory =
    rect === null
      ? null
      : {
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          }
        }
}

/** 取走一次（避免下一条消息复用旧位置）；取不到回 null */
export function takeComposerRect(): RectLike | null {
  const memory = composerRectMemory
  composerRectMemory = null
  return memory?.rect ?? null
}

/** 测试用：清空记忆 */
export function resetComposerRectMemory(): void {
  composerRectMemory = null
}

export interface FlightGeometry {
  dx: number
  dy: number
  startScale: number
}

/** Composer 卡 → 气泡目标位（纯函数；dx/dy 是"从目标看起点"的偏移） */
export function planSendFlight(composer: RectLike, bubble: RectLike): FlightGeometry {
  return {
    dx: composer.left - bubble.left,
    dy: composer.top - bubble.top,
    startScale: 0.6
  }
}

/** 阻尼弹簧阶跃响应（ζ=.75、ω=7.5 rad/s），归一化到 t=1 时刚好 1 */
export function springProgressAt(seconds: number): number {
  const zeta = 0.75
  const omega = 7.5
  const omegaD = omega * Math.sqrt(1 - zeta * zeta)
  const decay = Math.exp(-zeta * omega * seconds)
  const value =
    1 -
    decay * (Math.cos(omegaD * seconds) + ((zeta * omega) / omegaD) * Math.sin(omegaD * seconds))
  const end =
    1 -
    Math.exp(-zeta * omega * 0.4) *
      (Math.cos(omegaD * 0.4) + ((zeta * omega) / omegaD) * Math.sin(omegaD * 0.4))
  return end <= 0 ? 1 : Math.max(0, Math.min(1, value / end))
}

/**
 * 采样成 linear keyframes（WAAPI 不能直接写弹簧曲线；插件原文也是采样）。
 * 终点强制 transform none，避免末帧残留 1e-6 的位移。
 */
export function flightKeyframes(geometry: FlightGeometry, samples = 10): Keyframe[] {
  const keyframes: Keyframe[] = []
  for (let index = 0; index <= samples; index += 1) {
    const offset = index / samples
    if (index === samples) {
      keyframes.push({ offset: 1, transform: 'none', opacity: 1 })
      continue
    }
    const progress = springProgressAt(offset * (SEND_FLIGHT_MS / 1000))
    const scale = geometry.startScale + (1 - geometry.startScale) * progress
    const x = geometry.dx * (1 - progress)
    const y = geometry.dy * (1 - progress)
    keyframes.push({
      offset,
      transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`,
      opacity: (0.82 + 0.18 * progress).toFixed(3)
    })
  }
  return keyframes
}

/**
 * 让真实气泡从 Composer 位置飞到原位。
 * @returns Animation（已开始）或 null（没 rect / 不支持 WAAPI → 调用方退回 grow/无动画）
 */
export function animateSendFlight(bubble: HTMLElement): Animation | null {
  if (typeof bubble.animate !== 'function') return null
  const composer = takeComposerRect()
  if (composer === null) return null
  const rect = bubble.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const geometry = planSendFlight(composer, {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  })
  return bubble.animate(flightKeyframes(geometry), {
    duration: SEND_FLIGHT_MS,
    easing: 'linear',
    fill: 'none'
  })
}
