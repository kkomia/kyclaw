/**
 * 像素海獭（brand mark）· 状态规格表。
 *
 * 唯一来源：`.superpowers/handover/pixel-otter-logo/assets/subsets/launch-v1/manifest.json`
 * 的 `states` 组（设计稿 rev2：24×24 栅格、外耳、无胡须）。产品 v1 只接三处，
 * 只带这 6 个状态；帧数 / 每帧时长 / loop / reduced 静态帧在这里与 manifest 一一对应。
 *
 * 动效口径：80–120ms/帧；`reducedFrame` = `prefers-reduced-motion` 时显示的静态帧号
 * （think 是 #2 —— 三点气泡最长的那帧，静态也能读出「在想」）。
 */
export type PixelOtterState = 'idle' | 'loading' | 'float' | 'wave' | 'think' | 'type'

/** 产品允许的显示尺寸（24 栅格的整数倍 / 子集里导出过的档；由浏览器最近邻缩放） */
export type PixelOtterSize = 16 | 24 | 32 | 48 | 64 | 96 | 128

export interface PixelOtterStateSpec {
  /** 帧数（sprite sheet 横向格数） */
  frames: number
  /** 每帧时长（ms） */
  frameMs: number
  /** true = infinite；false = 播 `iterations` 遍后停（wave = 2 遍 ≈1.2s） */
  loop: boolean
  /** reduced-motion 下的静态帧号 */
  reducedFrame: number
  /** 非 loop 状态的播放遍数 */
  iterations?: number
  /** 资源倍率：header 用 1x（24→32 最近邻放大）；splash/welcome 用 @4x（96 格） */
  scale: 1 | 4
}

export const OTTER_STATES: Record<PixelOtterState, PixelOtterStateSpec> = {
  idle: { frames: 8, frameMs: 120, loop: true, reducedFrame: 0, scale: 1 },
  loading: { frames: 6, frameMs: 80, loop: true, reducedFrame: 0, scale: 4 },
  float: { frames: 6, frameMs: 120, loop: true, reducedFrame: 0, scale: 4 },
  // 设计稿：wave 6 帧 ×100ms、播 2 遍（≈1.2s）后由调用方切回 float
  wave: { frames: 6, frameMs: 100, loop: false, reducedFrame: 0, iterations: 2, scale: 4 },
  think: { frames: 6, frameMs: 120, loop: true, reducedFrame: 2, scale: 1 },
  type: { frames: 4, frameMs: 80, loop: true, reducedFrame: 0, scale: 1 }
}

/** 设计稿 §5.2：header 右侧只有三个状态；success/error 不进 header（归 toast/错误卡） */
export type ChatMascotState = 'idle' | 'think' | 'type'

/** header 状态 → otter 状态（v1 一一对应） */
export const CHAT_MASCOT_STATE: Record<ChatMascotState, PixelOtterState> = {
  idle: 'idle',
  think: 'think',
  type: 'type'
}
