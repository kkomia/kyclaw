/**
 * 代码预览（认得出语言的代码文件）：**复用聊天区那套高亮**，渲染端不另起一套。
 *
 * 复用点与口径：
 *   - 组件就是 `features/chat/parts/CodeBlock.tsx`（shiki 单例 + css-variables 主题 + 只读渲染），
 *     语言清单也在它那儿 —— 这里**不新增语言**，只把后缀映到它已有的语言 id（见 `modes.ts`）；
 *   - 只读、保留空白、横向滚动都在它的样式里（`styles/markdown.css` 的 `.code-block-body` 是
 *     `overflow-x: auto`），行号/编辑能力一概没有 —— 这是预览，不是编辑器；
 *   - 语言没打包的扩展名由 `previewModeOf` 挡在外面（回落现有 `<pre>` 纯文本），所以到这里
 *     `language` 一定是高亮器认得的那几个之一；万一高亮失败，CodeBlock 自己退回纯文本；
 *   - 内容来自现有的文本通道（64KB 上限 + "只显示前面一部分"的提示仍在外层 TextBody 里）。
 */
import { CodeBlock } from '@renderer/features/chat/parts/CodeBlock'

export function CodePreview({
  text,
  language
}: {
  text: string
  language: string
}): React.JSX.Element {
  return (
    <div data-testid="file-preview-code" className="min-w-0">
      <CodeBlock code={text} language={language} />
    </div>
  )
}
