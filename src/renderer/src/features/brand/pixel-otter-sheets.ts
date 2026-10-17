/**
 * 像素海獭 sprite sheet 档位表（v4 / 32×32 栅格；task-65）。
 *
 * 从 PixelOtter.tsx 抽出来（react-refresh 要求组件文件只导出组件）：
 * 每状态的 sheet 倍率 → 浅/深两层 URL（浅深同规格、只有像素色板不同）。
 * `cell` = 32 × 倍率（sheet 单帧像素边长）；请求尺寸按「选 ≤size 的最大 cell」挑档，
 * 没有更小的就用最小档（浏览器最近邻缩放）。splash 不走这里（index.html 内联 base64）。
 */
import type { PixelOtterState } from './otter-states'

import idleLight from '@renderer/assets/pixel-otter/sheets/light/otter-idle.sheet.png'
import idleDark from '@renderer/assets/pixel-otter/sheets/dark/otter-idle.sheet.png'
import loadingLight from '@renderer/assets/pixel-otter/sheets/light/otter-loading.sheet@4x.png'
import loadingDark from '@renderer/assets/pixel-otter/sheets/dark/otter-loading.sheet@4x.png'
import float3xLight from '@renderer/assets/pixel-otter/sheets/light/otter-float.sheet@3x.png'
import float3xDark from '@renderer/assets/pixel-otter/sheets/dark/otter-float.sheet@3x.png'
import float4xLight from '@renderer/assets/pixel-otter/sheets/light/otter-float.sheet@4x.png'
import float4xDark from '@renderer/assets/pixel-otter/sheets/dark/otter-float.sheet@4x.png'
import wave3xLight from '@renderer/assets/pixel-otter/sheets/light/otter-wave.sheet@3x.png'
import wave3xDark from '@renderer/assets/pixel-otter/sheets/dark/otter-wave.sheet@3x.png'
import wave4xLight from '@renderer/assets/pixel-otter/sheets/light/otter-wave.sheet@4x.png'
import wave4xDark from '@renderer/assets/pixel-otter/sheets/dark/otter-wave.sheet@4x.png'
import thinkLight from '@renderer/assets/pixel-otter/sheets/light/otter-think.sheet.png'
import thinkDark from '@renderer/assets/pixel-otter/sheets/dark/otter-think.sheet.png'
import typeLight from '@renderer/assets/pixel-otter/sheets/light/otter-type.sheet.png'
import typeDark from '@renderer/assets/pixel-otter/sheets/dark/otter-type.sheet.png'

export interface SheetVariant {
  /** sheet 单帧像素边长（32 × 倍率） */
  cell: number
  light: string
  dark: string
}

export const SHEET_VARIANTS: Record<PixelOtterState, readonly SheetVariant[]> = {
  // 输入卡状态灯：32 = 1x，1:1 最清晰（更大尺寸由浏览器最近邻放大）
  idle: [{ cell: 32, light: idleLight, dark: idleDark }],
  think: [{ cell: 32, light: thinkLight, dark: thinkDark }],
  type: [{ cell: 32, light: typeLight, dark: typeDark }],
  loading: [{ cell: 128, light: loadingLight, dark: loadingDark }],
  // 欢迎页 logo：96 = @3x（1:1）、128 = @4x（1:1）；其它尺寸就近
  float: [
    { cell: 96, light: float3xLight, dark: float3xDark },
    { cell: 128, light: float4xLight, dark: float4xDark }
  ],
  wave: [
    { cell: 96, light: wave3xLight, dark: wave3xDark },
    { cell: 128, light: wave4xLight, dark: wave4xDark }
  ]
}

/** 选档：最大的 cell ≤ size（整数倍放大）；都比 size 大就用最小档（缩小采样） */
export function pickSheetVariant(state: PixelOtterState, size: number): SheetVariant {
  const variants = SHEET_VARIANTS[state]
  const fitting = variants.filter((variant) => variant.cell <= size)
  return fitting.length > 0 ? fitting[fitting.length - 1] : variants[0]
}
