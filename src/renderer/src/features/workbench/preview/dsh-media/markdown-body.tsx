/**
 * markdown 文档体：**数学（KaTeX）+ 前置 YAML frontmatter**，其余渲染口径与聊天区一致。
 *
 * 上游对照：deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx`（frontmatter 分层）
 * 与 `packages/client/ui-primitives/src/markdown/**`（数学渲染）。
 * 两点刻意的不同：
 *
 * 1) **数学走 react-markdown 生态的标准插件链**（`remark-math` + `rehype-katex` +
 *    `katex` 的官方 CSS），不是上游那套自研渲染管线 —— 本仓的 markdown 渲染器是 react-markdown
 *    （见 `features/chat/parts/TextPart.tsx`），插件链是这条路上维护良好的成熟做法。
 *    **定界符按上游口径补齐**：`$...$` / `$$...$$` 由 `remark-math` 负责；`\(...\)` / `\[...\]`
 *    与同一行的 `$$...$$` 由 `math-compatibility.ts`（上游 `mathCompatibility` 的逐字移植，
 *    micromark 扩展）挂进同一次解析 —— 走 tokenizer 层，**不会误替换代码块/行内代码里的定界符**。
 * 2) **代码块与链接组件的口径复刻聊天区**（`pre` → 既有 `CodeBlock`：Shiki 高亮 + 复制；
 *    行内 code、外链同款）。之所以复刻而不是复用：那份组件表没有对外导出，
 *    而聊天区文件不在本轮可改范围；要收成单一来源得把 `MARKDOWN_COMPONENTS` 提到共享模块。
 *
 * frontmatter 的解析器（yaml）按上游口径**懒加载**：YAML 解析器不进启动分块，加载期间/失败时
 * 显示原文块，正文照常渲染。源文件不被改写。
 */
import { isValidElement, lazy, Suspense, useMemo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock } from '@renderer/features/chat/parts/CodeBlock'
import { splitFrontmatter } from './frontmatter'
import { remarkBackslashMath } from './math-compatibility'
import './dsh-media.css'

/**
 * 插件表是**模块级常量**：react-markdown 按数组身份判断要不要重解析，
 * 每次渲染现造数组会让整棵 markdown 树每帧重解析。
 * 顺序：`remarkGfm` → `remarkMath`（注册 `math()` 与 mdast 侧 handler）→ `remarkBackslashMath`
 * （把 `\(...\)` / `\[...\]` 的 micromark 扩展挂上去，复用同一套 math token）。
 */
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkBackslashMath]
const REHYPE_PLUGINS = [rehypeKatex]

/** 围栏代码 → 既有 CodeBlock（与聊天区同一条接管链：语言标注 + 复制 + Shiki）。 */
function PreBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const child = Array.isArray(children) ? children[0] : children
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    const language = /language-([\w-]+)/.exec(child.props.className ?? '')?.[1]
    const code = String(child.props.children ?? '').replace(/\n$/, '')
    return <CodeBlock code={code} language={language} />
  }
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

/** YAML 分块加载失败时兜底：原文块（正文照常）。 */
function FrontmatterFallback({ fallback }: { source: string; fallback: ReactNode }): ReactNode {
  return fallback
}

const FrontmatterFields = lazy(() =>
  import('./frontmatter-fields').then(
    (module) => ({ default: module.FrontmatterFields }),
    () => ({ default: FrontmatterFallback })
  )
)

/**
 * frontmatter 框：字段表在懒分块里，加载期间显示原文块。
 * @param props `source` 是两个分隔符之间的 YAML 原文。
 * @returns 元数据框；空块收缩成什么都不显示。
 */
function FrontmatterBox({ source }: { source: string }): ReactNode {
  const verbatim = (
    <pre className="dsh-media-frontmatter-source" data-testid="dsh-frontmatter-source">
      {source}
    </pre>
  )
  return (
    <div className="dsh-media-frontmatter" data-testid="file-preview-frontmatter">
      <Suspense fallback={verbatim}>
        <FrontmatterFields source={source} fallback={verbatim} />
      </Suspense>
    </div>
  )
}

/**
 * 一份 markdown 的正文（frontmatter 在上、markdown 在下）。
 * @param props `text` 是全文（frontmatter 由本组件切分）。
 * @returns 带 `markdown-body` 类的内容树（正文样式沿用聊天区那一套）。
 */
export function DshMarkdownBody({ text }: { text: string }): React.JSX.Element {
  const split = useMemo(() => splitFrontmatter(text), [text])
  return (
    <div className="markdown-body" data-testid="dsh-markdown-body">
      {split === undefined ? null : <FrontmatterBox source={split.source} />}
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {split?.body ?? text}
      </Markdown>
    </div>
  )
}
