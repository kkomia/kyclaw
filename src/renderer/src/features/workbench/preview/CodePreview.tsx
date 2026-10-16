/**
 * 代码预览（接线薄壳）：渲染交给 `dsh-media/code-body.tsx` —— 高亮与复制仍走聊天区那份
 * `features/chat/parts/CodeBlock.tsx`（Shiki 单例 + css-variables 主题），本轮补的是
 * DSH 文档侧的**代码文本体验**：源码行号（默认开、不进复制内容）与**自动换行开关**（缺省开）。
 *
 * 语言清单没有新增：来这里的一定是 `modes.ts` 那张表里认得的语言 id；高亮失败时 CodeBlock
 * 自己退回纯文本（那条路不画行号，见 `dsh-media/code-body.tsx` 头注）。
 * 内容来自现有的文本通道（64KB 上限 + "只显示前面一部分"的提示仍在外层 TextBody 里）。
 */
import { DshCodeBody } from './dsh-media/code-body'

export function CodePreview({
  text,
  language
}: {
  text: string
  language: string
}): React.JSX.Element {
  return (
    <div data-testid="file-preview-code" className="min-w-0">
      <DshCodeBody text={text} language={language} />
    </div>
  )
}
