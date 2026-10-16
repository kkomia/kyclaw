/**
 * markdown 预览（接线薄壳）：渲染交给 `dsh-media/markdown-body.tsx` —— 与本仓聊天区同一套
 * markdown 口径（react-markdown + remark-gfm + 既有 CodeBlock），另加**数学（KaTeX）**与
 * **前置 YAML frontmatter 字段列表**两块（DSH markdown 文档体的移植）。
 *
 * 复用点与口径（与改前一致的部分）：
 *   - 正文样式仍是聊天区那一套（内容树带 `markdown-body` 类，样式在 `styles/markdown.css`）；
 *   - 代码块仍由 `features/chat/parts/CodeBlock.tsx` 接管（Shiki 高亮 + 复制）；
 *   - 不解析原始 HTML（仓库没装 rehype-raw），**天然没有 XSS 面**，不需要额外消毒；
 *   - 内容来自现有的文本通道（64KB 上限 + 截断提示沿用），本组件只管画。
 */
import { DshMarkdownBody } from './dsh-media/markdown-body'

export function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-testid="file-preview-markdown" className="min-w-0 px-3 py-2">
      <DshMarkdownBody text={text} />
    </div>
  )
}
