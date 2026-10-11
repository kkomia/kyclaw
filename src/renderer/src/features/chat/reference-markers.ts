/**
 * 引用标记（round 14）：`【引用】<kind>：<label>`（kind ∈ 技能 | 插件 | 上下文 | 文件）。
 *
 * 输入侧在**光标处内联插入**标记（用户口径："不要单独取顶格，会失去在输入文本中的位置"），
 * 发送后就是普通文本（模型看到的是原始标记，无额外协议）；气泡与输入框的 chip 层用**同一份解析**
 * 把标记画成内联 chip（round 21：图3 风格——细描边圆角 + 图标 + `kind：label`，`【引用】` 前缀不进
 * 可见层）。旧版把多条引用以 `；` 并在一段里（round 7-13 的发送格式）——解析兼容，展示仍拆成多条。
 * 每段带 `start` / `raw`（round 21）：chip 的 × 删除按段精确替换；输入框覆盖层用 `raw` 做隐形占位，
 * 让 chip 的盒宽**恰等于原文宽度**（盖住底层字形、不挪动后面的字）。
 *
 * label 以空白 / `；` / 文末为界：标记插入时自带尾随空格，光标后面继续打的正文不会被吞进 chip
 * （代价：label 里含空格时尾段只按普通文本渲染，内容不变、复制不变）。
 */
export const REFERENCE_KINDS = ['技能', '插件', '上下文', '文件'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

export interface ReferenceItem {
  kind: ReferenceKind
  label: string
}

export type MessageSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'reference'
      refs: ReferenceItem[]
      /** 段在原文里的起点（round 21：chip 的 × 删除要按段精确移除） */
      start: number
      /** 段的原文（含 `【引用】` 前缀；round 21：不透明覆盖层用它做隐形占位，chip 宽度 = 原文宽度） */
      raw: string
    }

/** 一段标记 = 【引用】 前缀 + 一条或多条 `kind：label`（旧合并格式用 `；` 串联） */
const MARKER =
  /【引用】((?:技能|插件|上下文|文件)：[^\s；]+(?:；(?:技能|插件|上下文|文件)：[^\s；]+)*)/g

/** 文本 → 文本 / 引用段（没有标记时就回一段纯文本） */
export function parseReferenceMarkers(text: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, index) })
    const refs: ReferenceItem[] = match[1].split('；').map((pair) => {
      const at = pair.indexOf('：')
      return { kind: pair.slice(0, at) as ReferenceKind, label: pair.slice(at + 1) }
    })
    segments.push({ kind: 'reference', refs, start: index, raw: match[0] })
    cursor = index + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/** 在光标处插入一段标记 + 尾随一个空格；返回新文本与新光标位（标记之后） */
export function insertReferenceMarker(
  text: string,
  caret: number,
  kind: ReferenceKind,
  label: string
): { text: string; caret: number } {
  return replaceRangeWithMarker(text, caret, caret, kind, label)
}

/**
 * 用标记替换 `[start, end)`（浮窗选中：把触发符+过滤词整段换掉）；返回新文本与新光标位。
 * 越界自动夹回 [0, 长度]，不抛。
 */
export function replaceRangeWithMarker(
  text: string,
  start: number,
  end: number,
  kind: ReferenceKind,
  label: string
): { text: string; caret: number } {
  const safeStart = Math.max(0, Math.min(start, text.length))
  const safeEnd = Math.max(safeStart, Math.min(end, text.length))
  const marker = `【引用】${kind}：${label} `
  return {
    text: text.slice(0, safeStart) + marker + text.slice(safeEnd),
    caret: safeStart + marker.length
  }
}
