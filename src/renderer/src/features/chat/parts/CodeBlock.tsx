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
 * 高亮是异步的：拿到前先出纯文本，拿到后换成高亮 HTML（同一块位置，不闪空）。
 */
let highlighterPromise: Promise<HighlighterCore> | null = null

/** 全局单例：语言/主题只加载一次，后面每次高亮都同步（模块级缓存，随窗口生命周期）。
    加载失败就把缓存清掉（下次再试），不然一次失败会让后面所有代码块都回不去高亮。 */
function loadHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] =
      await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])

    return createHighlighterCore({
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
  })().catch((error: unknown) => {
    highlighterPromise = null
    throw error
  })
  return highlighterPromise
}

export interface CodeBlockProps {
  code: string
  /** 围栏标注的语言；未知/未注册时按纯文本渲染 */
  language?: string
}

export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!language) return
    let alive = true
    loadHighlighter()
      .then((highlighter) => {
        if (!alive || !highlighter.getLoadedLanguages().includes(language)) return null
        return highlighter.codeToHtml(code, { lang: language, theme: 'css-variables' })
      })
      .then((next) => {
        if (alive && next) setHtml(next)
      })
      .catch((cause) => {
        // 高亮失败不该吃掉内容：留着纯文本，日志里说一声
        console.warn('[kyclaw] 代码高亮失败，按纯文本呈现', cause)
      })
    return () => {
      alive = false
    }
  }, [code, language])

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
