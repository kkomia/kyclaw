import {
  Fragment,
  isValidElement,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClassAttributes,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { splitBlocks } from './markdown-blocks'

/**
 * 助手消息的文本 part：markdown（react-markdown + remark-gfm）。
 *
 * 代码块在这里从 `<pre>` 那一层接管（react-markdown 把围栏代码给成 pre > code）：
 * 换成自绘的 CodeBlock（语言标注 + 复制 + Shiki），行内 code 单独出样式。
 * 流式光标的样式钩在 `data-streaming` 上（CSS 伪元素，细竖线；见 styles/markdown.css）。
 *
 * ## round 73：流式正文的两级优化（流畅度 P0）
 *
 * 问题（本仓库探针实测，见 `__tests__/_r73-stream-perf.spec.tsx`）：原先每个 delta 都把**累积全文**
 * 交给 markdown 全量重解析。一条 485 行 / 12KB 的长回复按 294 条 delta 推完，屏幕内容变了 294 次
 * = 294 次全量解析 + 294 次整棵子树协调 + 294 次 Shiki 重排高亮。探针实测（同一台机器）：
 * 单拍处理最坏 71~122ms、每帧渲染均值 19~27ms、整条流累计渲染 6.6~9.4s，而屏幕一秒最多画 60 帧
 * —— 绝大多数那次解析的结果**没人看得到**。
 *
 * 两条硬口径（用户拍板，别退化成 ② 而不是 ①）：
 *   ① 流式**期间**内容仍要肉眼可见地增长 —— 不是"憋到最后一次性出现"；
 *   ② 流式**结束**那一刻就是最终样子 —— 节流绝不能留下旧内容。
 *
 * 两级手段（不引新依赖，React 19 原生手段）：
 *
 * **一级 · 按帧合流**（`useCadencedText`）：内容先落在 ref 上，一帧只把**最新那一份**交给 markdown
 * （`requestAnimationFrame` + `startTransition`）。同帧到达的 N 条 delta 合成一次渲染；rAF 回调总取
 * ref 里的最新全文，所以每一帧画的都是"到这一帧为止的全部内容"（①）；`streaming` 为假时**不走
 * 节流**，直接以 props 的 `text` 渲染（②）——同一帧内"最后一条 delta + 结束"也一定是终态。
 *
 * **二级 · 按块增量**（`StreamingMarkdown` + `markdown-blocks.ts`）：合流把"每秒解析次数"压到帧率，
 * 但每次仍是**全量**解析 —— 探针拆解显示 12KB 样本一次全量渲染约 58~70ms（jsdom；解析+建元素那截
 * 与真实引擎同量级），一帧 16.7ms 的量级根本不够。所以流式期间再把正文按**硬边界**切成块，
 * 每块一个 `memo` 化的 markdown 实例：稳定前缀块 text 不变 → 整棵跳过，每帧只重解析**最后一块**
 * （样本里约 20 行 / 500 字节）。实测每帧渲染均值从 19~27ms 降到 0.97~1.41ms。
 *
 * 不做第三级（比如把长表格再切行）的理由：切点越细，与"整篇一次性解析"的语义差异面越大，
 * 而流结束时是按整篇重画的（见下），任何差异都会变成结束时的一次重排。切点只留**确定安全**的那几类。
 *
 * **结束时的整篇重画**：`streaming` 为假时 `TextPart` 走的是 `MarkdownBody`（整篇一个实例）——
 * 于是"最终样子"与 round 73 之前**逐字节相同**（`text-part-blocks.spec.tsx` 用逐字节比对钉住），
 * 分块渲染只活在流式期间。
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

/**
 * markdown 正文（按 text 值 memo）。
 *
 * 这是全链路上最贵的一层（解析 + 子树协调 + CodeBlock/Shiki 的调度）：`text` 没变就整棵跳过。
 */
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }): React.JSX.Element {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  )
})

/**
 * 流式期间的一块（同样按 text 值 memo）。
 *
 * 与 `MarkdownBody` 是同一个东西，分开只为**稳定组件类型**：`blocks.map` 里现写匿名组件会让
 * memo 每次都换类型、整棵重挂，等于白切。
 */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  )
})

/**
 * 流式正文：按硬边界分块，每块一个 memo 化的 markdown 实例（只有最后一块每帧重解析）。
 *
 * 分不开（null）就整篇一块 —— 退化成一级优化的行为，不会出错。
 */
const StreamingMarkdown = memo(function StreamingMarkdown({
  text
}: {
  text: string
}): React.JSX.Element {
  const blocks = splitBlocks(text)
  if (blocks === null) return <MarkdownBody text={text} />
  return (
    <>
      {blocks.map((block, index) => (
        // key = 下标：边界集合只增不减，所以同一块的 key 稳定、相邻两帧的块能对上（memo 才命中）。
        // 块之间补一个 '\n' 文本节点：整篇一次性渲染时 react-markdown 就会在块级元素之间吐一个，
        // 不补的话流式期间与最终排版差一个换行（见 text-part-blocks.spec.tsx 的逐字节比对）。
        <Fragment key={index}>
          {index === 0 ? null : '\n'}
          <MarkdownBlock text={block} />
        </Fragment>
      ))}
    </>
  )
})

/**
 * 流式期间按帧合流的正文；非流式直接返回 props 的 text（不经过任何延迟）。
 *
 * 返回值的形状只有两种：`streaming ? shown : text` —— ②的保证就落在这一行上：
 * 只要 `streaming` 变假，这一次渲染画的一定是最终文本，跟 `shown` 里还剩什么无关。
 *
 * `shown` 与 text 的"对得上"判定：一条流里的正文只增不减，所以合流值必然是当前 text 的**前缀**；
 * 不是前缀（换了一轮 / 重新生成把正文换掉了）就当它是上一轮留下的，这一帧先按 props 画，
 * 等下一帧再合流。这条判定替代了"在 effect 里同步 state"（那会多一次级联渲染，
 * 也是 `react-hooks/set-state-in-effect` 明令避免的写法）。
 */
function useCadencedText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text)
  /** 待上屏的最新全文（rAF 回调总取它，所以尾边沿不会丢） */
  const pending = useRef(text)
  const frame = useRef<number | null>(null)

  const cancelPending = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [])

  useEffect(() => {
    pending.current = text

    // 非流式：不排帧（返回值直接用 props 的 text，这一拍画的就是终态）
    if (!streaming) {
      cancelPending()
      return
    }

    // 已经画到这一份了：这一帧没有要做的事（顺手撤掉排着的帧，它与 pending 同值）
    if (text === shown) {
      cancelPending()
      return
    }

    // 本帧已排过：只更新 pending（同帧到达的后续 delta 合流进下一次上屏）
    if (frame.current !== null) return

    frame.current = requestAnimationFrame(() => {
      frame.current = null
      // 低优先级提交：这一次重解析不该跟输入/滚动抢主线程（值与当前相同时 React 自己 bail out）
      startTransition(() => setShown(pending.current))
    })
  }, [text, streaming, shown, cancelPending])

  // 卸载：不留排着的帧（回调已经没有接收者）
  useEffect(() => cancelPending, [cancelPending])

  const usable = shown.length <= text.length && text.startsWith(shown)
  return streaming && usable ? shown : text
}

export function TextPart({ text, streaming = false }: TextPartProps): React.JSX.Element {
  const shown = useCadencedText(text, streaming)
  return (
    <div
      data-testid="message-text"
      data-streaming={streaming ? 'true' : undefined}
      className="markdown-body"
    >
      {streaming ? <StreamingMarkdown text={shown} /> : <MarkdownBody text={shown} />}
      {/* 流刚开始、还没有内容时：光标单独出一个（有内容时由 CSS 伪元素跟在最后一段后面） */}
      {streaming && text === '' ? (
        <span data-testid="streaming-cursor" className="streaming-cursor" aria-hidden="true" />
      ) : null}
    </div>
  )
}
