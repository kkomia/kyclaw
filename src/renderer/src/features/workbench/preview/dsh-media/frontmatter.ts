/**
 * 前置 YAML frontmatter 的切分（纯函数，单测直接打）。
 *
 * 逐字移植 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/markdown/frontmatter.ts`（含正则与判定口径）：
 * 只有**第一行**（允许 BOM）的 `---` 才算开块，块结束在第一个 `---` 或 `...` 行；
 * 没有闭合的行就不算 frontmatter（保持 markdown 原文）。**源文件不被改写**，只是渲染分层。
 */

/** frontmatter 的元数据原文 + 其后的 markdown 正文。 */
export interface FrontmatterSplit {
  source: string
  body: string
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u

/**
 * 切出开头的 frontmatter 块（不解析它的 YAML）。
 * @param text markdown 原文；未闭合的开块不算 frontmatter。
 * @returns 元数据原文与剩余正文；没有 frontmatter 时给 `undefined`。
 */
export function splitFrontmatter(text: string): FrontmatterSplit | undefined {
  const match = FRONTMATTER.exec(text)
  if (match === null) return undefined
  return { source: match[1] ?? '', body: text.slice(match[0].length) }
}
