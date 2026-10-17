import {
  Fragment,
  isValidElement,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClassAttributes,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CitationContextsContext,
  CitationHintsContext,
  EMPTY_CITATION_HINTS
} from '../citation-hints'
import {
  citationContextsFromText,
  citationKey,
  citationLabel,
  decodeHtmlEntities,
  safeHttpUrl,
  type CitationHint
} from '../citations'
import { CitationChip } from './CitationChip'
import { CodeBlock } from './CodeBlock'
import { MarkdownSourceProvider, MarkdownTable } from './MarkdownTable'
import { splitBlocks } from './markdown-blocks'

/**
 * 助手消息的文本 part：markdown（react-markdown + remark-gfm）。
 *
 * 代码块在这里从 `<pre>` 那一层接管（react-markdown 把围栏代码给成 pre > code）：
 * 换成自绘的 CodeBlock（语言标注 + 复制 + Shiki），行内 code 单独出样式。
 * 表格同理从 `table` 那一层接管：整张表套进圆角外壳 + 横向滚动口，复制 / 下载见 MarkdownTable.tsx
 * ——每个 Markdown 实例都把**自己吃进去的源文本**交给它（`MarkdownSourceProvider`），
 * 导出的是这段 Markdown 原文而不是页面上的字。**流式期间那两个按钮由 CSS 收起**
 * （祖先的 `data-streaming`），所以整篇渲染与分块渲染的 DOM 仍然逐字节一致。
 * 这一层接管**只在回复流里开**（`TextPartProps.tables`）：计划卡 / 记忆页 / 轨迹详情的表格
 * 走基础组件表，渲染结果与改动前一个字节都不差。
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
  /**
   * 表格外壳与复制 / 下载（0.1.3 · 007）：**只在回复流里开**。
   *
   * 默认按调用点判：回复流那条（Message.tsx）一直显式传 `streaming`，另外三处宿主
   * （计划卡 / 记忆页 / 轨迹详情）只传 `text` —— 那三处保持原样（表格仍是 react-markdown 的
   * 默认元素，不套外壳、不出按钮），这个扩展不去改别处的外观。
   * 要显式收口就传 `tables`（显式优先）；之后若想让回复流也写明白，加一位即可，不必动默认逻辑。
   */
  tables?: boolean
  /**
   * 本轮已完成 web_search / fetch 工具结果建立的已知来源 allowlist（0.1.3 网页引用）。
   *
   * **键存在即授权**：只有 citationKey 命中这里的数字链接才渲染角标；未命中的保持普通
   * 安全外链。只有 `Message.tsx` 会传；其它宿主（计划卡 / 记忆页 / 轨迹详情）没有工具
   * 上下文，数字链接一律按普通链接显示（不能凭正文 URL 自称来源）。
   */
  knownSources?: ReadonlyMap<string, CitationHint>
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

/** 链接文本的纯文字（模型可能把数字套进 `**` / `*`；角标只认数字本身） */
function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children)
  return ''
}

const UNSAFE_LINK_SCHEME = /^(?:javascript|data|vbscript):/i

/** 普通链接兜底也不放行带凭据的 http(s)（host 会遮住凭据，用户看不出点去哪） */
const CREDENTIALED_HTTP = /^https?:\/\/[^/?#]*@/i

/**
 * Markdown 的 `a` 覆盖：数字文本 + 安全 http(s) **且**命中本轮已知来源 → 引用角标；
 * 其余保持普通外链。
 *
 * P0 provenance：正文 URL 本身不授权来源。未命中 allowlist 的数字链接走下面的普通
 * `<a>`（仍然是安全外链），既不出角标，也不进来源面板。
 *
 * 危险协议不落成可点击链接（react-markdown 默认也会清洗，这里再兜一层）；带凭据的 http(s)
 * 同样不落成链接（host 遮住凭据，用户看不出点去哪）。相对路径 / mailto 等普通链接行为不变。
 * 数字文本到非 http(s) 目标时也按普通链接处理，不冒充网页来源。
 */
function MarkdownLink({
  href,
  title,
  children
}: ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  const knownSources = useContext(CitationHintsContext)
  const citationContexts = useContext(CitationContextsContext)
  const label = citationLabel(plainText(children))
  const url = label === undefined ? undefined : safeHttpUrl(href)
  const key = url === undefined ? undefined : citationKey(url)
  if (label !== undefined && url !== undefined && key !== undefined && knownSources.has(key)) {
    return (
      <CitationChip
        label={label}
        url={url}
        title={title ?? undefined}
        hint={knownSources.get(key)}
        context={citationContexts.get(key)}
      />
    )
  }

  const raw = href?.trim() ?? ''
  // 实体编码的协议（`javascript&colon;…`）解码后再判，别让普通链接兜底绕过清洗
  const decoded = decodeHtmlEntities(raw)
  if (decoded === '' || UNSAFE_LINK_SCHEME.test(decoded) || CREDENTIALED_HTTP.test(decoded)) {
    return <span>{children}</span>
  }
  return (
    <a href={decoded} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  pre: PreBlock,
  code: ({ children }) => (
    <code data-testid="inline-code" className="font-mono">
      {children}
    </code>
  ),
  a: MarkdownLink
}

/**
 * 回复流那一份组件表：只多了 `table`（其余逐字相同）。
 *
 * 两个表都是模块级常量 —— `components` 的身份在两条渲染路上都稳定，react-markdown 不会因为
 * "传了个新对象"而重建；别处宿主用上面那份（表格保持默认元素），见 TextPartProps.tables。
 */
const MARKDOWN_COMPONENTS_WITH_TABLES: Components = {
  ...MARKDOWN_COMPONENTS,
  table: MarkdownTable
}

/**
 * markdown 正文（按 text 值 memo）。
 *
 * 这是全链路上最贵的一层（解析 + 子树协调 + CodeBlock/Shiki 的调度）：`text` 没变就整棵跳过。
 * 表格的源文本就是这一份 `text` —— 整篇渲染时 `node.position` 的偏移与它同源。
 */
const MarkdownBody = memo(function MarkdownBody({
  text,
  tables
}: {
  text: string
  tables: boolean
}): React.JSX.Element {
  return (
    <MarkdownSourceProvider source={text}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={tables ? MARKDOWN_COMPONENTS_WITH_TABLES : MARKDOWN_COMPONENTS}
      >
        {text}
      </Markdown>
    </MarkdownSourceProvider>
  )
})

/**
 * 流式期间的一块（同样按 text 值 memo）。
 *
 * 与 `MarkdownBody` 是同一个东西，分开只为**稳定组件类型**：`blocks.map` 里现写匿名组件会让
 * memo 每次都换类型、整棵重挂，等于白切。
 *
 * 表格源文本是**这一块**的文本（偏移与块同源，切出来的字节与全文里那一段相同）；
 * 块 text 不变 → 这个组件根本不重渲染 → 表里已画好的部分也不会每帧重挂。
 */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  tables
}: {
  text: string
  tables: boolean
}): React.JSX.Element {
  return (
    <MarkdownSourceProvider source={text}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={tables ? MARKDOWN_COMPONENTS_WITH_TABLES : MARKDOWN_COMPONENTS}
      >
        {text}
      </Markdown>
    </MarkdownSourceProvider>
  )
})

/**
 * 流式正文：按硬边界分块，每块一个 memo 化的 markdown 实例（只有最后一块每帧重解析）。
 *
 * 分不开（null）就整篇一块 —— 退化成一级优化的行为，不会出错。
 */
const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  tables
}: {
  text: string
  tables: boolean
}): React.JSX.Element {
  const blocks = splitBlocks(text)
  if (blocks === null) return <MarkdownBody text={text} tables={tables} />
  return (
    <>
      {blocks.map((block, index) => (
        // key = 下标：边界集合只增不减，所以同一块的 key 稳定、相邻两帧的块能对上（memo 才命中）。
        // 块之间补一个 '\n' 文本节点：整篇一次性渲染时 react-markdown 就会在块级元素之间吐一个，
        // 不补的话流式期间与最终排版差一个换行（见 text-part-blocks.spec.tsx 的逐字节比对）。
        <Fragment key={index}>
          {index === 0 ? null : '\n'}
          <MarkdownBlock text={block} tables={tables} />
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

export function TextPart({
  text,
  streaming,
  tables,
  knownSources
}: TextPartProps): React.JSX.Element {
  const live = streaming ?? false
  // 回复流判据：调用点显式传了 `streaming`（Message.tsx 那条）＝ 聊天正文；显式 `tables` 优先
  const withTables = tables ?? streaming !== undefined
  const shown = useCadencedText(text, live)
  const sources = knownSources ?? EMPTY_CITATION_HINTS
  // 工具结果缺 title/snippet 时的兜底：按 markdown 原文算引用所在句子（流式每帧文本变化才重算）
  const citationContexts = useMemo(() => citationContextsFromText(text, sources), [text, sources])
  /**
   * P1b 配方 1：每个流式 chunk 到达时给**最后一块**补一次 120ms 淡入。
   * 为什么不用 class：分块渲染的稳定前缀块会原地复用（round 73 的 DOM 逐字节约定），
   * 换 class/重挂都会破坏"流式与整篇同构"；这里用 Web Animations 只挂临时效果，不动 DOM。
   * 节流 120ms：真实 token 流比 120ms 密，连续重启会闪，按令牌节拍每 120ms 只补一次。
   */
  const markdownRef = useRef<HTMLDivElement>(null)
  const lastChunkFadeRef = useRef(0)
  useEffect(() => {
    if (!live) return
    const last = markdownRef.current?.lastElementChild
    if (last === null || last === undefined || typeof last.animate !== 'function') return
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    const now = performance.now()
    if (now - lastChunkFadeRef.current < 120) return
    lastChunkFadeRef.current = now
    // 时长读角色令牌（motion.css）；拿不到时退回配方里的 120ms，保证不退化成 0
    const token = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--motion-feedback')
    )
    last.animate([{ opacity: 0.4 }, { opacity: 1 }], {
      duration: Number.isFinite(token) && token > 0 ? token : 120,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'none'
    })
  }, [shown, live])
  return (
    <CitationHintsContext.Provider value={sources}>
      <CitationContextsContext.Provider value={citationContexts}>
        <div
          ref={markdownRef}
          data-testid="message-text"
          // 阅读**车道**语义（外层 lane 仍是 reading）；2026-10-18 用户实拍后正文拉丁+数字
          // 统一 UI 声部（--font-ui）——font-serif 会再次引入 Sitka 数字/英文与中文黑体混排。
          data-font-role="reading"
          data-streaming={live ? 'true' : undefined}
          className="markdown-body font-sans"
        >
          {live ? (
            <StreamingMarkdown text={shown} tables={withTables} />
          ) : (
            <MarkdownBody text={shown} tables={withTables} />
          )}
          {/* 流刚开始、还没有内容时：光标单独出一个（有内容时由 CSS 伪元素跟在最后一段后面） */}
          {live && text === '' ? (
            <span data-testid="streaming-cursor" className="streaming-cursor" aria-hidden="true" />
          ) : null}
        </div>
      </CitationContextsContext.Provider>
    </CitationHintsContext.Provider>
  )
}
