/**
 * 代码文档体：行号 + 自动换行开关（高亮/复制仍走既有 CodeBlock）。
 *
 * 上游对照：deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/code/CodeBody.tsx`（薄壳）
 * 与 `packages/client/ui-primitives/src/markdown/CodeBlock.tsx` 的**文档侧体验**：
 * 源码行号（默认开、**不进复制内容**）、顶部工具条上的换行开关（缺省**开**）、
 * 代码坐在面板自己的背景上。
 *
 * 本仓的取舍（三条，都是为了不动聊天区的 `CodeBlock`）：
 *   1) 高亮与复制继续用聊天区那份 `CodeBlock`（Shiki 单例 + 复制按钮 + 语言标注），
 *      **不复制第二套高亮器** —— 预览与聊天区永远同一份语法与配色；
 *   2) 行号用 **CSS 计数器**画（`dsh-media.css`）：Shiki 输出的每一行本来就是
 *      `<span class="line">`，计数器挂在它上面，`::before` 伪元素 + `user-select: none`
 *      保证行号既不被框选、也进不了任何复制路径（复制按钮复制的是原始文本）；
 *      **没有高亮时**（`data-highlighted="false"`，纯文本回落）不画行号 —— 那条路的
 *      `<pre><code>` 没有行元素，硬画会串行；
 *   3) 换行开关放在文档体自己这一行（聊天区的 CodeBlock 头没有位置塞它，而聊天区文件不在本轮可改范围）。
 *      换行只是 CSS（`white-space` / `overflow-wrap`），不改文本。
 */
import { useMemo, useState, type CSSProperties } from 'react'
import { WrapText } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { CodeBlock } from '@renderer/features/chat/parts/CodeBlock'
import './dsh-media.css'

/**
 * 一份代码文档。
 * @param props `text` 是全文（文本通道的有界内容），`language` 是 Shiki 认得的高亮语言 id。
 * @returns 行号 + 换行开关 + 既有高亮代码块。
 */
export function DshCodeBody({
  text,
  language
}: {
  text: string
  language: string
}): React.JSX.Element {
  /** 换行缺省开（上游文档侧口径）；关掉就是横向滚动。 */
  const [wrap, setWrap] = useState(true)
  /** 行号槽宽按总行数给（最少 2ch，与上游同一算法）。 */
  const lineCount = useMemo(() => {
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
    return trimmed === '' ? 1 : trimmed.split('\n').length
  }, [text])
  const action = wrap ? '关闭自动换行' : '自动换行'

  return (
    <div
      className="dsh-media-code"
      data-testid="dsh-code-body"
      data-wrap={wrap ? 'true' : 'false'}
      style={
        {
          '--dsh-code-line-number-width': `${Math.max(2, String(lineCount).length)}ch`
        } as CSSProperties
      }
    >
      <div className="dsh-media-code-bar">
        <Tooltip label={action}>
          <Button
            variant="ghost"
            size="sm"
            data-testid="dsh-code-wrap"
            aria-pressed={wrap}
            icon={<WrapText aria-hidden="true" />}
            onClick={() => setWrap((value) => !value)}
          >
            自动换行
          </Button>
        </Tooltip>
      </div>
      <CodeBlock code={text} language={language} />
    </div>
  )
}
