import { isValidElement, type ClassAttributes, type HTMLAttributes, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

/**
 * 助手消息的文本 part：markdown（react-markdown + remark-gfm）。
 *
 * 代码块在这里从 `<pre>` 那一层接管（react-markdown 把围栏代码给成 pre > code）：
 * 换成自绘的 CodeBlock（语言标注 + 复制 + Shiki），行内 code 单独出样式。
 * 流式光标的样式钩在 `data-streaming` 上（CSS 伪元素，细竖线；见 styles/markdown.css）。
 */
export interface TextPartProps {
  text: string
  streaming?: boolean
}

function PreBlock({
  children
}: ClassAttributes<HTMLPreElement> & HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  const child: ReactNode = Array.isArray(children) ? children[0] : children

  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const language = /language-([\w-]+)/.exec(child.props.className ?? '')?.[1]
    const code = String(child.props.children ?? '').replace(/\n$/, '')
    return <CodeBlock code={code} language={language} />
  }

  // 理论上到不了这（围栏代码必然是 pre > code）；真到了也把内容留住
  return <pre>{children}</pre>
}

const MARKDOWN_COMPONENTS: Components = {
  pre: PreBlock,
  code: ({ children }) => (
    <code data-testid="inline-code" className="font-mono">
      {children}
    </code>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

export function TextPart({ text, streaming = false }: TextPartProps): React.JSX.Element {
  return (
    <div
      data-testid="message-text"
      data-streaming={streaming ? 'true' : undefined}
      className="markdown-body"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
      {/* 流刚开始、还没有内容时：光标单独出一个（有内容时由 CSS 伪元素跟在最后一段后面） */}
      {streaming && text === '' ? (
        <span data-testid="streaming-cursor" className="streaming-cursor" aria-hidden="true" />
      ) : null}
    </div>
  )
}
