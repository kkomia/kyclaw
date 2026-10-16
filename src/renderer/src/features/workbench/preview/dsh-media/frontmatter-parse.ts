/**
 * frontmatter 原文 → 字段表的解析（纯函数，单测直接打；组件在 `frontmatter-fields.tsx`）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter-fields.tsx` 的 `parseFields`：
 * 字符串值显示**解析后的值**（折行/多行字符串读作整段），其它标量、列表、映射与别名保持**原文**；
 * YAML 非法或顶层不是映射时给 `undefined`（调用方拿它决定"显示原文块"）。
 *
 * 拆成独立文件的原因：`react-refresh/only-export-components` —— 组件文件只导出组件，
 * 解析函数放这里（顺带让"解析器单独一块"的懒加载边界更清楚）。
 */
import { isMap, isNode, isScalar, parseDocument } from 'yaml'

/** 一条顶层字段；`block` 标记"值是一段原文 YAML"（集合或别名），与标量分样式。 */
export interface FrontmatterField {
  key: string
  value: string
  block: boolean
}

/**
 * 把 frontmatter 原文解析成顶层字段表。
 * @param source 两个分隔符之间的 YAML 原文。
 * @returns 字段表；空文档给 `[]`；YAML 非法或顶层不是映射给 `undefined`。
 */
export function parseFrontmatterFields(source: string): readonly FrontmatterField[] | undefined {
  const parsed = parseDocument(source)
  if (parsed.errors.length > 0) return undefined
  if (parsed.contents === null) return []
  if (!isMap(parsed.contents)) return undefined
  return parsed.contents.items.map(({ key, value }) => ({
    key: nodeText(source, key),
    value: nodeText(source, value),
    block: isNode(value) && !isScalar(value)
  }))
}

/**
 * 一个节点的显示文本：字符串标量给解析值（折行/多行读作整段），其余给原文。
 * @param source frontmatter 原文（取节点原文切片用）。
 * @param node yaml 包解析出的节点（类型面是 unknown，逐层判类型）。
 * @returns 显示文本。
 */
function nodeText(source: string, node: unknown): string {
  if (isScalar(node) && typeof node.value === 'string') return node.value.trimEnd()
  if (!isNode(node)) return ''
  const [start, end] = node.range ?? [0, 0]
  const indent = start - source.lastIndexOf('\n', start - 1) - 1
  return source
    .slice(start, end)
    .replace(new RegExp(`\\n {0,${indent}}`, 'gu'), '\n')
    .trimEnd()
}
