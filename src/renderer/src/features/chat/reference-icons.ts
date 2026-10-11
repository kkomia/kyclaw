import { AtSign, FileText, Plug, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReferenceItem } from './reference-markers'

/**
 * 引用 chip 的图标表与可见文本（round 21）：**非组件**常量，单独放 .ts——
 * 组件文件（reference-chip.tsx）只导出组件，保住 react-refresh 的 fast-refresh 边界。
 * 图标按 kind 给：插件 = Plug / 技能 = Sparkles / 上下文 = AtSign / 文件 = FileText。
 */
export const REFERENCE_ICONS: Record<ReferenceItem['kind'], LucideIcon> = {
  技能: Sparkles,
  插件: Plug,
  上下文: AtSign,
  文件: FileText
}

/** chip 的可见文本（多条旧格式用 `；` 串联，与解析口径一致） */
export function referenceLabel(refs: readonly ReferenceItem[]): string {
  return refs.map((ref) => `${ref.kind}：${ref.label}`).join('；')
}
