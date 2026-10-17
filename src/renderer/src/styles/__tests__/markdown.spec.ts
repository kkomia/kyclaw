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

describe('markdown.css · P0 三声部与极简配方（2026-10-18）', () => {
  it('正文 = --font-prose（随包 Noto Serif 拉丁 + DSH 黑体中文），数字 lining+tabular；标题仍 --font-reading', () => {
    // 正文块本身：拉丁衬线（书生气）由 --font-prose 给；中文链仍由该 token 逐字回落
    const bodyBlock = /\.markdown-body \{([^}]*)\}/.exec(markdownBody)?.[1] ?? ''
    expect(bodyBlock).toContain('font-family: var(--font-prose);')
    expect(bodyBlock).not.toContain('--font-reading')
    // 数字：lining（等高，不出现 oldstyle）+ tabular（等宽，1111=9999）
    expect(bodyBlock).toContain('font-variant-numeric: lining-nums tabular-nums;')
    // 标题仍走阅读声部（衬线只保留在标题/字标）
    expect(markdownBody).toMatch(
      /\.markdown-body h1,[\s\S]*?\.markdown-body h6 \{[^}]*font-family:\s*var\(--font-reading\)/
    )
    // 行高 1.8（中文阅读下限，章程 §2.4）
    expect(bodyBlock).toContain('line-height: 1.8;')
  })

  it('@font-face 随包 Noto Serif（kyclaw-serif-latin，100–900，swap）', () => {
    expect(markdownBody).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*'kyclaw-serif-latin';[^}]*url\('\.\.\/assets\/fonts\/NotoSerifVariable\.woff2'\)\s*format\('woff2'\);[^}]*font-weight:\s*100 900;[^}]*font-display:\s*swap;/
    )
  })

  it('叙事行宽 = --prose-measure（只压叙事块；代码块/表格可更宽）', () => {
    expect(markdownBody).toMatch(/max-width:\s*var\(--prose-measure\)/)
    expect(markdownBody).toContain('.markdown-body > p')
  })

  it('行内码 .88em + 500 + 代码语义色；代码块 500（不换暗底主题）', () => {
    expect(markdownBody).toMatch(
      /:not\(pre\) > code \{[\s\S]*?color:\s*var\(--code-ink\);[\s\S]*?font-size:\s*0\.88em;[\s\S]*?font-weight:\s*500;/
    )
    expect(markdownBody).toMatch(/\.code-block-body \{[\s\S]*?font-weight:\s*500/)
    // 代码块底仍走语义凹槽，不引入第二套暗底
    expect(markdownBody).toMatch(/\.code-block \{[\s\S]*?background-color:\s*var\(--bg-secondary\)/)
  })

  it('表格数字 lining + tabular-nums（读数/计数不跳动、不出现 oldstyle）', () => {
    expect(markdownBody).toMatch(
      /\.markdown-body th,\s*\n\.markdown-body td \{[\s\S]*?font-variant-numeric:\s*lining-nums tabular-nums/
    )
  })

  it('链接用陶土橙链接档 --link / --link-hover（单一强调色，D-30）', () => {
    expect(markdownBody).toMatch(/\.markdown-body a \{[^}]*color:\s*var\(--link\)/)
    expect(markdownBody).toMatch(/\.markdown-body a:hover \{[^}]*color:\s*var\(--link-hover\)/)
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
