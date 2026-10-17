/**
 * 像素海獭（brand mark）· 状态规格表。
 *
 * 唯一来源：`.superpowers/handover/pixel-otter-logo/assets/subsets/launch-v2/manifest.json`
 * 的 `states` 组（设计稿 **v4：32×32 栅格**、圆脸/胡须/8 色；显示尺寸全部为 32 的整数倍）。
 * 产品只接三处落点（输入卡右上角 / 欢迎页报头 / splash），只带这 6 个状态；
 * 帧数 / 每帧时长 / loop / reduced 静态帧在这里与 manifest 一一对应。
 *
 * 动效口径：80–120ms/帧；`reducedFrame` = `prefers-reduced-motion` 时显示的静态帧号
 * （think 是 #2 —— 三点气泡最长的那帧，静态也能读出「在想」）。
 */
export type PixelOtterState = 'idle' | 'loading' | 'float' | 'wave' | 'think' | 'type'

/**
 * 允许的显示尺寸（**32 栅格的整数倍**：32/64/96/128/192/256/512）。
 * v4 起**最小 32、弃 24**（24 在 32 栅格下只剩 0.75×，辨识度低且非整数倍）。
 * 由浏览器最近邻缩放（整数倍优先，见 PixelOtter 的 pickSheetVariant）。
 */
export type PixelOtterSize = 32 | 64 | 96 | 128 | 192 | 256 | 512

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
}

export const OTTER_STATES: Record<PixelOtterState, PixelOtterStateSpec> = {
  idle: { frames: 8, frameMs: 120, loop: true, reducedFrame: 0 },
  loading: { frames: 6, frameMs: 80, loop: true, reducedFrame: 0 },
  float: { frames: 6, frameMs: 120, loop: true, reducedFrame: 0 },
  // 设计稿：wave 6 帧 ×100ms、播 2 遍（≈1.2s）后由调用方切回 float
  wave: { frames: 6, frameMs: 100, loop: false, reducedFrame: 0, iterations: 2 },
  think: { frames: 6, frameMs: 120, loop: true, reducedFrame: 2 },
  type: { frames: 4, frameMs: 80, loop: true, reducedFrame: 0 }
}

/** chat 输入卡状态灯使用的三态（设计稿 §5.2：idle / 思考 / 工具打字） */
export type ChatMascotState = 'idle' | 'think' | 'type'

/** chat 状态灯三态 → 品牌动画状态（状态推导见 chat-mascot-state.ts） */
export const CHAT_MASCOT_STATE: Record<ChatMascotState, PixelOtterState> = {
  idle: 'idle',
  think: 'think',
  type: 'type'
}
