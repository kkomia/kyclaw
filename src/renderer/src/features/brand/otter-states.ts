/**
 * 像素海獭（brand mark）· 聊天状态灯规格表。
 *
 * 2026-10-18「状态海獭同步 v4-pixel」：状态灯从 v5 时代 32×32 旧 sprite sheet 换成
 * **v4-pixel 设计语言的 32 原生栅格**（inline SVG，3 帧 / 4 帧 sprite strip）。
 * 资产在设计侧 `.superpowers/brand/otter-v4-pixel/chat-states/`，产品副本
 * `features/brand/otter-v4/chat-{idle,think,type}.svg`（与欢迎页/关于页/splash 的 48 栅格
 * `otter-{animated,static}.svg` 同一套色板、1 px 墨描边、无手）。
 *
 * 为什么是 32 栅格：输入卡右上角的落位固定 32 CSS px（`Composer.tsx` 的 size={32} 与
 * `.composer-otter` 均不改），32 原生 = 1×，DPR 1/2/3 都是整数倍设备像素；48 栅格在这个槽里
 * 只能 2/3 缩放（非整数，线宽会 1/2 px 不均）。同风格简化见设计目录 README。
 *
 * 动效口径：帧与帧之间是离散 steps（无补间、无亚像素）。
 *   - idle  3 帧 / 4 s：**沿用 otter-animated 的现有时间轴**（光标闪一下 + 眨一次眼）——
 *     若按 80–120 ms/帧 均匀跑，32 px 状态灯会 2 秒眨 4 次，读成抽搐；brief 明确允许沿用。
 *   - think 4 帧 × 120 ms = 480 ms：星点呼吸；眼睛上望 + 头微侧是**静态姿态**，静止也读得出。
 *   - type  4 帧 × 90 ms = 360 ms：纸页第一行逐帧变长、光标右移；头部 1 px 起伏。
 * `reducedFrame` = `prefers-reduced-motion`（或父层 `paused`）时定格的那一帧：
 *   idle A（睁眼 + 光标亮）/ think C（星点十字）/ type D（最长一行）。
 */
export type PixelOtterState = 'idle' | 'think' | 'type'

/**
 * 允许的显示尺寸（**32 栅格的整数倍**：32/64/96/128/192/256/512）。
 * 输入卡状态灯固定 32（1×）；其它尺寸是整数倍最近邻放大，不会糊。
 */
export type PixelOtterSize = 32 | 64 | 96 | 128 | 192 | 256 | 512

export interface PixelOtterStateSpec {
  /** 帧数（sprite strip 横向格数） */
  frames: number
  /** 名义帧步进（ms）：think/type 是均匀帧长；idle 的 CSS 走显式时间轴，见 periodMs */
  frameMs: number
  /** 一轮周期（ms） */
  periodMs: number
  /** true = infinite（三态都是常驻循环） */
  loop: boolean
  /** reduced-motion / 父层 paused 下的静态帧号 */
  reducedFrame: number
}

export const OTTER_STATES: Record<PixelOtterState, PixelOtterStateSpec> = {
  idle: { frames: 3, frameMs: 120, periodMs: 4000, loop: true, reducedFrame: 0 },
  think: { frames: 4, frameMs: 120, periodMs: 480, loop: true, reducedFrame: 2 },
  type: { frames: 4, frameMs: 90, periodMs: 360, loop: true, reducedFrame: 3 }
}

/** chat 输入卡状态灯使用的三态（设计稿 §5.2：idle / 思考 / 工具打字） */
export type ChatMascotState = 'idle' | 'think' | 'type'

/** chat 状态灯三态 → 品牌动画状态（状态推导见 chat-mascot-state.ts；现在一一对应） */
export const CHAT_MASCOT_STATE: Record<ChatMascotState, PixelOtterState> = {
  idle: 'idle',
  think: 'think',
  type: 'type'
}
