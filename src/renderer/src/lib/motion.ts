/**
 * 动效 B · 用户可配层（task-59）。
 *
 * 设计来源：`.superpowers/handover/dsh-motion-design.md` §0/§3（dsh-claude-style 插件设置页
 * 的 9 个键与默认值，用户截图里选择的就是这一套）。**设置模型已由 task-58（A）落地**：
 * `@shared/settings` 的 `MotionSettings` / `defaultMotionSettings()` / `MotionMode`
 * （mode = system | reduced | always），本文件只做「读 + 折算 + 组件统一入口」。
 *
 * 约定：
 *   - 组件**不散落读 `mode`/matchMedia**；一律 `useEffectiveMotion()` 拿折算后的开关。
 *   - `mode=system` 跟随 `prefers-reduced-motion`；`reduced` 一律减弱；`always` 忽略系统。
 *   - 原先 P1b 的 `--motion-*` 角色令牌/配方不变；这里只加「用户可配层」的门控。
 */
import { useSyncExternalStore } from 'react'
import {
  defaultMotionSettings,
  motionSettingsSchema,
  type MotionMode,
  type MotionSettings
} from '@shared/settings'
import { useSettingsStore } from './settings-store'

export type { MotionMode, MotionSettings } from '@shared/settings'

/** 折算后的开关（组件只读这个） */
export interface EffectiveMotion {
  reduced: boolean
  chatScroll: boolean
  statusLine: boolean
  preciseStatus: boolean
  statusPaint: MotionSettings['statusPaint']
  caret: MotionSettings['caret']
  reveal: MotionSettings['reveal']
  chatSend: boolean
  /** 减弱/关闭时为 none（不挂任何入场动画） */
  messageEnter: MotionSettings['messageEnter'] | 'none'
}

/** 9 个键的默认值（A 的 defaultMotionSettings()；这里导出给测试/非设置页复用） */
export function defaultMotion(): MotionSettings {
  return defaultMotionSettings()
}

/** 旧/半截 settings 的兜底：整份安全解析失败时逐字段回默认（A 的 migration 已做同一件事） */
export function readMotionSettings(raw: unknown): MotionSettings {
  const parsed = motionSettingsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const defaults = defaultMotionSettings()
  const candidate = (raw ?? {}) as Record<string, unknown>
  const merged = { ...defaults }
  for (const key of Object.keys(defaults) as Array<keyof MotionSettings>) {
    const value = candidate[key]
    if (value !== undefined && motionSettingsSchema.shape[key].safeParse(value).success) {
      // 逐字段校验通过才收（坏枚举/错类型回默认）
      Object.assign(merged, { [key]: value })
    }
  }
  return merged
}

/** mode + 系统辅助偏好 → 是否走「减弱」（唯一的折算入口） */
export function resolveMotionReduced(mode: MotionMode, systemReduced: boolean): boolean {
  if (mode === 'reduced') return true
  if (mode === 'always') return false
  return systemReduced
}

/**
 * 9 键折算：减弱时所有会动的开关一律关掉（说法仍变、caret 回原生、气泡直接站位），
 * `preciseStatus` 也关（避免锁/换词动效）。关闭单项时只影响该项。
 */
export function resolveEffectiveMotion(
  settings: MotionSettings,
  systemReduced: boolean
): EffectiveMotion {
  const reduced = resolveMotionReduced(settings.mode, systemReduced)
  if (reduced) {
    return {
      reduced: true,
      chatScroll: false,
      statusLine: false,
      preciseStatus: false,
      statusPaint: settings.statusPaint,
      caret: 'off',
      reveal: 'off',
      chatSend: false,
      messageEnter: 'none'
    }
  }
  return {
    reduced: false,
    chatScroll: settings.chatScroll,
    statusLine: settings.statusLine,
    preciseStatus: settings.preciseStatus,
    statusPaint: settings.statusPaint,
    caret: settings.caret,
    reveal: settings.reveal,
    chatSend: settings.chatSend,
    messageEnter: settings.chatSend ? settings.messageEnter : 'none'
  }
}

/** 系统 prefers-reduced-motion 的订阅（不散落 matchMedia） */
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

function systemReduceSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCE_QUERY).matches
}

function subscribeSystemReduce(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(REDUCE_QUERY)
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }
  media.addListener?.(onChange)
  return () => media.removeListener?.(onChange)
}

/** 当前系统辅助偏好（hook；matchMedia 变化会重渲染） */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeSystemReduce, systemReduceSnapshot, () => false)
}

/** 组件统一入口：settings.motion（A 已落地）× 系统 reduce → 9 个折算开关 */
export function useEffectiveMotion(): EffectiveMotion {
  const settings = useSettingsStore((state) => state.settings)
  const systemReduced = useSystemReducedMotion()
  return resolveEffectiveMotion(readMotionSettings(settings.motion), systemReduced)
}

/** 非 React 场景（纯函数/测试）的便捷入口：从 AppSettings 形状直接折算 */
export function effectiveMotionOf(
  settings: { motion?: unknown } | null | undefined,
  systemReduced: boolean
): EffectiveMotion {
  return resolveEffectiveMotion(readMotionSettings(settings?.motion), systemReduced)
}

/**
 * chat 根节点上的 data-*（CSS 门控用；组件统一从这里取，避免各写一份）。
 * `data-motion` 让 chat-motion.css 在 mode=reduced 时也走静态终态（不依赖 OS 媒体查询）；
 * mode=always → `full`（CSS 在 @media reduce 里对 `[data-motion='full']` 重声明动画）。
 */
export function motionDataAttributes(motion: EffectiveMotion): Record<string, string> {
  return {
    'data-motion': motion.reduced ? 'reduced' : 'full',
    'data-chat-scroll': motion.chatScroll ? 'on' : 'off',
    'data-chat-reveal': motion.reveal,
    'data-status-line': motion.statusLine ? 'on' : 'off',
    'data-status-paint': motion.statusPaint,
    'data-chat-send': motion.chatSend ? 'on' : 'off',
    'data-message-enter': motion.messageEnter
  }
}
