import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { HighlighterCore } from 'shiki/core'

/**
 * 代码块：Shiki 高亮 + 标题行（语言 + 复制）。
 *
 * Shiki 选型（T7 裁决）：css-variables 主题（配色不写死在这里，只吐 var(--shiki-*)，
 * 由 styles/markdown.css 映到 --Syntax-*）+ JS 引擎（不引 oniguruma wasm，避免打包问题）
 * + 只注册少量常用语言（js/ts/tsx/json/css/html/python/bash/markdown/yaml；
 * 其余语言按纯文本出，不硬套）。
 *
 * ## PB-042（R16「代码块首帧空白」）：第一帧就必须是成品，不许「先空壳/纯文本、后填高亮」
 *
 * 修复前的时序（线上探针实证，`.superpowers/dev-verify/20261020-0.2.1/cyrus/r16-timeline.json`）：
 *   1. 流式第一片只到 "```ts\n"（围栏开了、代码正文还没到）：react-markdown 已经给出
 *      `<pre><code class="language-ts"></code></pre>`，CodeBlock 立刻挂出 code-block 壳子 ——
 *      `data-highlighted="false"`、`pre > code` 的 innerHTML **为空**。这一帧就是「首帧空白」；
 *   2. 高亮在 effect 里走异步链：`loadHighlighter()`（动态 import shiki/core + engine + 语言包）
 *      `.then(codeToHtml).then(setHtml)`，要等 promise 落定，约 58ms 后才把高亮 HTML 填进去。
 *
 * 修复的两条（判据不放宽：**首次插入 DOM 时就要有非空 shiki 结构**）：
 *   - **渲染前同步拿到高亮**：高亮器就绪后 `codeToHtml` 本来就是同步的。现在保留一个模块级
 *     「已就绪单例」+ 模块级结果缓存，render 里直接同步取（缓存命中零等待）。取不到时先**不挂**
 *     code-block，等就绪后重算再挂 —— 于是 code-block 第一次插入 DOM 就带 shiki 结构；
 *     模块 import 时就开始预热高亮器（正常远早于第一条代码块），把这段等待压到接近 0。
 *   - **空围栏不上屏**：`code === ''` 是围栏刚开、正文还没到，此刻没有任何内容可高亮（shiki 对
 *     空代码只会吐一个空的 `<span class="line">`，不含任何 token 结构）。那一帧挂出去就是空壳，
 *     所以不落 DOM；等正文到了再按上一条同步高亮渲染。
 *
 * 高亮加载失败 / 语言没打包时仍按纯文本回落（`data-highlighted="false"`，内容绝不能丢）——
 * 这两条路径本来就没有 shiki 结构可出，不属于「首帧空白」。
 */
export interface CodeBlockProps {
  code: string
  /** 围栏标注的语言；未知/未注册时按纯文本渲染 */
  language?: string
}

let highlighterPromise: Promise<HighlighterCore> | null = null
/** 高亮器就绪后的单例：有它才能「渲染前同步高亮」（PB-042 的核心前提）。 */
let readyHighlighter: HighlighterCore | null = null
/** 加载失败标记：失败后本轮窗口按纯文本回落，绝不把代码块挂起不放（内容不能丢）。 */
let highlighterFailed = false

/** 全局单例：语言/主题只加载一次，后面每次高亮都同步（模块级缓存，随窗口生命周期）。
    加载失败就把缓存清掉（下次再试），不然一次失败会让后面所有代码块都回不去高亮。 */
function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] =
      await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])

    const highlighter = await createHighlighterCore({
      themes: [createCssVariablesTheme({ name: 'css-variables', variablePrefix: '--shiki-' })],
      langs: [
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/bash.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/yaml.mjs')
      ],
      engine: createJavaScriptRegexEngine()
    })
    readyHighlighter = highlighter
    return highlighter
  })().catch((error: unknown) => {
    highlighterPromise = null
    highlighterFailed = true
    throw error
  })
  return highlighterPromise
}

/**
 * 打包进高亮器的语言 id + 别名（**与 loadHighlighter 的 langs 导入保持同步**；别名取自各
 * lang 模块的 `aliases`）。为什么要这张同步表：语言没打包时不该等 Shiki 加载完才知道「不支持」，
 * 那会把纯文本兜底也拖成挂起、甚至让代码块迟迟不出。
 */
const HIGHLIGHTED_LANGUAGES = new Set<string>([
  // javascript.mjs
  'javascript',
  'js',
  'cjs',
  'mjs',
  // typescript.mjs
  'typescript',
  'ts',
  'cts',
  'mts',
  // tsx.mjs
  'tsx',
  // json.mjs / css.mjs / html.mjs
  'json',
  'css',
  'html',
  // python.mjs
  'python',
  'py',
  // bash.mjs（name 是 shellscript）
  'shellscript',
  'bash',
  'sh',
  'shell',
  'zsh',
  // markdown.mjs
  'markdown',
  'md',
  // yaml.mjs
  'yaml',
  'yml'
])

/**
 * PB-041 P0-B：Shiki 高亮结果模块级缓存（lang+code → html）。
 * 组件重挂时惰性初始化直接从缓存取，不再出现「纯文本 → 高亮」整块替换的闪帧。
 * 上限 500 条，超出按插入序淘汰最旧（够大、不会无界增长）。
 */
const HIGHLIGHT_CACHE = new Map<string, string>()
const HIGHLIGHT_CACHE_LIMIT = 500

function cacheKey(language: string, code: string): string {
  return `${language}\u0000${code}`
}

function readCache(key: string): string | undefined {
  const hit = HIGHLIGHT_CACHE.get(key)
  if (hit !== undefined) {
    // 命中即刷新为最新（LRU 的读提升）
    HIGHLIGHT_CACHE.delete(key)
    HIGHLIGHT_CACHE.set(key, hit)
  }
  return hit
}

function writeCache(key: string, html: string): void {
  HIGHLIGHT_CACHE.delete(key)
  HIGHLIGHT_CACHE.set(key, html)
  if (HIGHLIGHT_CACHE.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value
    if (oldest !== undefined) HIGHLIGHT_CACHE.delete(oldest)
  }
}

interface ResolvedHighlight {
  /** 高亮 HTML；null = 走纯文本回落（没标语言 / 没打包 / 高亮失败） */
  html: string | null
  /**
   * true = 语言已打包、高亮器还在加载：**先别挂 DOM**（挂出去就是没高亮的首帧，正是 PB-042）。
   * 就绪后 effect 会触发一次重算，届时同步高亮再挂。
   */
  pending: boolean
}

/**
 * 解析这一帧的高亮（PB-042：渲染期同步完成）。
 *
 * 高亮器就绪时 `codeToHtml` 是同步的，所以这里能给出「这一次 render 就能用」的 HTML；
 * 结果同时写回模块级缓存（幂等：StrictMode 的重复 render 第二次直接命中缓存，不会重复高亮）。
 */
function resolveHighlight(language: string | undefined, code: string): ResolvedHighlight {
  // 没标语言 / 语言没打包：没有 shiki 结构可出，按纯文本渲染（旧行为，内容不丢）
  if (language === undefined || !HIGHLIGHTED_LANGUAGES.has(language)) {
    return { html: null, pending: false }
  }
  const key = cacheKey(language, code)
  const cached = readCache(key)
  if (cached !== undefined) return { html: cached, pending: false }
  const highlighter = readyHighlighter
  if (highlighter === null) {
    // 还在加载 → 先不挂；加载失败 → 不挂起，按纯文本回落
    return { html: null, pending: !highlighterFailed }
  }
  if (!highlighter.getLoadedLanguages().includes(language)) {
    // 语言表漂了（上面同步表和实际打包的语言不一致）：兜底纯文本，不挂起
    return { html: null, pending: false }
  }
  try {
    const html = highlighter.codeToHtml(code, { lang: language, theme: 'css-variables' })
    writeCache(key, html)
    return { html, pending: false }
  } catch (cause) {
    console.warn('[kyclaw] 代码高亮失败，按纯文本呈现', cause)
    return { html: null, pending: false }
  }
}

// PB-042：模块加载即预热高亮器（静态 import 链在 App 首屏就求值，正常远早于第一条代码块）。
// vitest 里不预热：每个 spec 文件都会重新求值本模块，预热只会给聚焦/全量测试添动态 import 开销。
if (import.meta.env.MODE !== 'test') {
  void loadHighlighter().catch(() => undefined)
}

export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  /** 只用来在「高亮器就绪 / 加载失败」后触发一次重算（render 里不读它）。 */
  const [, setHighlightRevision] = useState(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // 语言没打包就不必拉高亮器；空围栏也先拉起来，正文到达时已经就绪（把等待压到 0）
    if (language === undefined || !HIGHLIGHTED_LANGUAGES.has(language)) return
    if (readyHighlighter !== null || highlighterFailed) return
    let alive = true
    loadHighlighter()
      .then(() => {
        if (alive) setHighlightRevision((value) => value + 1)
      })
      .catch((cause: unknown) => {
        // 高亮失败不该吃掉内容：留给下面的纯文本回落
        console.warn('[kyclaw] 代码高亮失败，按纯文本呈现', cause)
        if (alive) setHighlightRevision((value) => value + 1)
      })
    return () => {
      alive = false
    }
  }, [language])

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch (cause) {
      console.warn('[kyclaw] 复制代码失败', cause)
    }
  }

  // 空围栏（正文还没到）不上屏：挂出去就是「首帧空白」的壳子，见文件头 PB-042 第 2 条
  if (code === '') return null
  const { html, pending } = resolveHighlight(language, code)
  // 高亮器还在加载：先不挂，等它就绪后这一帧直接就是高亮结构（PB-042 第 1 条）
  if (pending) return null

  return (
    <div
      data-testid="code-block"
      data-language={language ?? ''}
      data-highlighted={html ? 'true' : 'false'}
      className="code-block"
    >
      <div className="code-block-head">
        <span data-testid="code-language">{language ?? 'text'}</span>
        <button
          type="button"
          data-testid="code-copy"
          onClick={() => {
            void copy()
          }}
          className="flex items-center gap-1 rounded-control px-2 py-0.5 transition-colors duration-(--motion-fast) hover:bg-hover hover:text-ink-secondary"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {html ? (
        <div className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
