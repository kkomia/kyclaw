import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 对话内容层的样式契约（Step 2/3）：
 *   1. styles/markdown.css 被 tailwind.css 引入（唯一入口）；
 *   2. Shiki 的 css-variables 主题变量（--shiki-*）在这里映射到既有 --Syntax-*，
 *      不是写死配色 —— 明暗跟着 data-theme 走；
 *   3. 流式光标：细竖线 + 呼吸动画，且尊重 prefers-reduced-motion。
 */
function readSource(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

const tailwindCss = readSource('../tailwind.css')
const markdownCss = readSource('../markdown.css')
/** 去注释后的正文：断言"没有写死的十六进制配色"时不该把注释里的示例算进去 */
const markdownBody = markdownCss.replace(/\/\*[\s\S]*?\*\//g, '')

describe('markdown.css · Shiki 变量映射', () => {
  it('被样式入口引入', () => {
    expect(tailwindCss).toMatch(/@import\s+'\.\/markdown\.css'/)
  })

  it('--shiki-* → --Syntax-*（不写死配色）', () => {
    const mapping: Array<[string, string]> = [
      ['--shiki-token-comment', '--Syntax-Comment'],
      ['--shiki-token-keyword', '--Syntax-Keyword'],
      ['--shiki-token-constant', '--Syntax-Literal'],
      ['--shiki-token-function', '--Syntax-Mark'],
      ['--shiki-token-string', '--Syntax-String'],
      ['--shiki-token-string-expression', '--Syntax-String'],
      ['--shiki-token-punctuation', '--Syntax-Punctuation'],
      ['--shiki-token-parameter', '--Syntax-Literal'],
      ['--shiki-token-link', '--Syntax-String']
    ]

    for (const [shikiVar, syntaxToken] of mapping) {
      expect(markdownBody).toMatch(
        new RegExp(`${shikiVar}:\\s*var\\(${syntaxToken.replace(/-/g, '\\-')}\\)`)
      )
    }

    expect(markdownBody).toMatch(/--shiki-foreground:\s*var\(--text-primary\)/)
    expect(markdownBody).toMatch(/--shiki-background:\s*transparent/)
  })

  it('正文里没有十六进制字面色（配色只从 token 来）', () => {
    expect(markdownBody).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('markdown.css · 流式光标', () => {
  it('细竖线：2px 宽、背景色画线（不用 border，避免渲染后边框残留）', () => {
    expect(markdownBody).toMatch(/\.markdown-body\[data-streaming='true'\][^{]*::after/)
    expect(markdownBody).toMatch(/width:\s*2px/)
    expect(markdownBody).not.toMatch(/border-right|border-left/)
  })

  it('呼吸动画用工程时长档，并在 reduced-motion 下停用', () => {
    expect(markdownBody).toMatch(/@keyframes kyclaw-cursor-breathe/)
    expect(markdownBody).toMatch(/animation:\s*kyclaw-cursor-breathe\s+var\(--duration-loop-slow\)/)
    expect(markdownBody).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/
    )
  })
})
