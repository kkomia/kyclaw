import type { PendingAttachment } from './composer-attachments'

/**
 * 输入卡重挂前后过桥的那一小包内容（round 76）。
 *
 * 为什么需要：会话实例就绪那一下，ChatPage 会把会话组件**换 key 重挂**（按 activeId 分挂，
 * "换会话 = 换一挂"是既有口径），而输入卡的草稿、附件与焦点都在组件内部 state 里 —— 重挂就没了。
 * 用户可能已经在冷启动那一段（几百毫秒到一两秒）里敲了半句、甚至拖进一个文件，不能让他白敲：
 * 这一包就是那一段的过桥。取用一次即清，不会流到别处。
 *
 * 边界（刻意收得很窄）：**只在"会话还没就绪"的那一挂上留**（Composer 的 `pending` 非空）——
 * 那一挂注定会因为 activeId 到位而重挂。普通换会话（真 id → 另一个真 id）不经过这里：
 * 那种情况的草稿该跟着那一挂一起消失（既有口径：换会话清草稿），不会被带进新会话。
 */
export interface ComposerCarryover {
  /** 重挂前输入框里的草稿 */
  text: string
  /** 重挂前已经收下的附件（还没发出去的那些） */
  attachments: PendingAttachment[]
  /** 重挂前焦点就在输入框里（那就把焦点还回去；只有空白草稿也照样还） */
  focused: boolean
}

let carryover: ComposerCarryover | null = null

/** 卸载前留一手（只该在"会话未就绪"那一挂上调用，见模块头注） */
export function keepComposerCarryover(value: ComposerCarryover): void {
  carryover = value
}

/** 取走（读一次就清）：没有就是 null */
export function takeComposerCarryover(): ComposerCarryover | null {
  const value = carryover
  carryover = null
  return value
}

/** 测试用：清掉过桥的那一包（模块级状态不随 render 重置） */
export function resetComposerCarryover(): void {
  carryover = null
}
