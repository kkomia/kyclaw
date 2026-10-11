/**
 * markdown 预览（`.md` / `.markdown`）：**复用聊天区的 markdown 渲染器**，不另起一套。
 *
 * 复用点与口径：
 *   - `TextPart` 吃的就是字符串（react-markdown + remark-gfm），文件预览拿到文本直接喂进去即可；
 *   - 它不解析原始 HTML（仓库没装 rehype-raw），**天然没有 XSS 面**，不需要额外消毒；
 *   - 表格 / 引用 / 代码块的样式都在 `styles/markdown.css`（`.markdown-body`），代码块自带横向滚动。
 *
 * 内容来自现有的文本通道（64KB 上限 + 截断提示沿用），本组件只管画。
 */
import { TextPart } from '@renderer/features/chat/parts/TextPart'

export function MarkdownPreview({ text }: { text: string }): React.JSX.Element {
  return (
    <div data-testid="file-preview-markdown" className="min-w-0 px-3 py-2">
      <TextPart text={text} />
    </div>
  )
}
