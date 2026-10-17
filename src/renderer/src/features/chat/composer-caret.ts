/**
 * Composer 自绘 caret 的**纯测量逻辑**（P1b 配方 3）。
 *
 * 为什么用镜像层测：textarea 的原生 caret 无法改颜色/闪频/移动曲线；把它设成
 * `caret-color: transparent`，用与 textarea **同排版**的镜像层（已有，见 Composer 的
 * `composer-mirror`）+ DOM Range 量出选区起点的矩形，再用绝对定位的 2px 竖条画 caret。
 *
 * IME 安全边界（重要）：
 *   - `composition` 期间不画自绘 caret，并把 `caret-color` 交回 auto（原生 caret 用户可见）；
 *   - 含引用 chip（`【引用】…`）时镜像层的文字偏移与 textarea 的原始串不再一一对应，
 *     这档直接回原生 caret（不猜位置，避免中文输入时跳位/吞字）。
 */
export interface ComposerCaretPlacement {
  left: number
  top: number
  height: number
}

/** 什么时候可以画自绘 caret（其余情况回原生 caret / 不可见） */
export function shouldShowComposerCaret(args: {
  focused: boolean
  composing: boolean
  hasReferenceMarkers: boolean
}): boolean {
  return args.focused && !args.composing && !args.hasReferenceMarkers
}

/**
 * 读 motion.css 角色令牌的毫秒值（JS 侧计时用；jsdom/异常时回落到配方值）。
 * 例：输入中暂停闪烁的 400ms = `--motion-flight`（400ms 小元素飞行档）。
 */
export function motionDurationMs(token: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(token)
  )
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 选区矩形 → textarea 内容坐标（减掉滚动，保证内部滚动时 caret 仍贴字） */
export function caretPlacementFromRects(
  selectionRect: { left: number; top: number; height: number },
  textareaRect: { left: number; top: number },
  scrollTop: number
): ComposerCaretPlacement {
  return {
    left: Math.max(0, selectionRect.left - textareaRect.left),
    top: Math.max(0, selectionRect.top - textareaRect.top - scrollTop),
    height: Math.max(1, selectionRect.height)
  }
}

/**
 * 镜像层里「第 offset 个字符」的矩形。
 *
 * 镜像层的文字是 **textarea 原始串**（含 `【引用】` 前缀的隐形占位），所以只在
 * 这段镜像是纯文本（没有 chip）时调用；走 TreeWalker 找文本节点，Range 取首行矩形。
 * 找不到（空串/节点结构变了）返回 null，由调用方回原生 caret。
 */
export function caretRectAtOffset(container: Node, offset: number): DOMRect | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let node = walker.nextNode()
  while (node !== null) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.setEnd(node, remaining)
      // jsdom（单测）没有 Range.getBoundingClientRect；真机 Chromium 有。测不到就回原生 caret。
      if (typeof range.getBoundingClientRect !== 'function') return null
      const rect = range.getBoundingClientRect()
      range.detach()
      if (rect.height > 0 || rect.width > 0) return rect as DOMRect
      return null
    }
    remaining -= length
    node = walker.nextNode()
  }
  return null
}
