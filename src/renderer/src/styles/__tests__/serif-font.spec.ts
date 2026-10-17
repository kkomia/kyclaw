import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * task-51 · chat 英文「书生气」：随包 Noto Serif（OFL）拉丁衬线契约。
 *
 * 纯源码/文件级断言（不跑浏览器）：
 *   - 只随包一个拉丁衬线字体（D-16 例外），≤80KB，OFL 文本随包 + notices 全文；
 *   - `--font-prose` = 'kyclaw-serif-latin' + DSH 中文链逐字（中文仍黑体）；
 *   - markdown 正文/表格走 --font-prose；数字 lining + tabular（不回退成 oldstyle/proportional）；
 *   - Markdown 标题仍 --font-reading、代码仍 --font-code、UI chrome 仍 --font-ui。
 * 数字字宽/等高实测在 `.superpowers/chat-aesthetics/serif-font/local-render-metrics.json`。
 */
const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')
const readIfExists = (relative: string): string => {
  try {
    return read(relative)
  } catch {
    return ''
  }
}

const FONT_DIR = 'src/renderer/src/assets/fonts'
const FONT_FILE = `${FONT_DIR}/NotoSerifVariable.woff2`
const OFL_FILE = `${FONT_DIR}/OFL-NotoSerif.txt`
const DSH_CJK_CHAIN =
  /'Noto Sans SC',\s*'Source Han Sans SC',\s*'PingFang SC',\s*'Hiragino Sans GB',\s*'Microsoft YaHei',\s*sans-serif/

describe('task-51：随包 Noto Serif（OFL，仅一个拉丁衬线）', () => {
  it('字体文件存在、体积 ≤80KB（D-16 例外只此一个）', () => {
    const stat = statSync(join(ROOT, FONT_FILE))
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(50_000)
    expect(stat.size).toBeLessThanOrEqual(80 * 1024)
    // 目录里只有这一个字体 + 它的 OFL 文本（不许混入 Anthropic/Inter 等）
    const files = readdirSync(join(ROOT, FONT_DIR)).sort()
    expect(files).toEqual(['NotoSerifVariable.woff2', 'OFL-NotoSerif.txt'])
  })

  it('OFL 许可文本随包（OFL-1.1 全文 + 版权行）', () => {
    const ofl = read(OFL_FILE)
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(ofl).toContain('Copyright 2022 The Noto Project Authors')
    expect(ofl).toContain('PERMISSION & CONDITIONS')
  })

  it('THIRD_PARTY_NOTICES 有 Noto Serif 章节 + OFL 全文，且说明随包分发', () => {
    const notices = read('resources/skills/THIRD_PARTY_NOTICES.md')
    expect(notices).toContain('## 8. Noto Serif 可变字体')
    expect(notices).toContain('NotoSerifVariable.woff2')
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(notices).toContain('Noto Project Authors')
    expect(notices).toMatch(/随安装包分发|随渲染端产物/)
    // D-16 边界：不随包 Anthropic 商业字体
    expect(notices).toContain('不包含 Anthropic 商业字体')
  })

  it('代码里不出现 Anthropic 商业字体名（只允许 OFL 随包字体）', () => {
    for (const file of [
      'src/renderer/src/styles/tokens/semantic.css',
      'src/renderer/src/styles/markdown.css',
      'src/renderer/src/features/chat/parts/TextPart.tsx',
      'src/renderer/src/features/chat/parts/ReasoningPart.tsx',
      'src/renderer/src/features/chat/parts/ToolCard.tsx'
    ]) {
      expect(read(file)).not.toContain('Anthropic Serif')
    }
  })
})

describe('task-51：--font-prose 字体栈（拉丁衬线 + DSH 黑体中文链逐字）', () => {
  const semantic = read('src/renderer/src/styles/tokens/semantic.css')

  it('--font-prose 先命中随包 kyclaw-serif-latin，中文段逐字 = DSH 链', () => {
    const token = /--font-prose:\s*([^;]+);/.exec(semantic)?.[1] ?? ''
    expect(token).toContain("'kyclaw-serif-latin'")
    expect(token).toMatch(DSH_CJK_CHAIN)
    // 中文链此前不许插别的字体（衬线只含拉丁，中文必须直接落到 Noto Sans SC）
    expect(token.indexOf("'kyclaw-serif-latin'")).toBeLessThan(token.indexOf("'Noto Sans SC'"))
    // 正文不用系统 Sitka/Georgia（那是标题声部 --font-reading）
    expect(token).not.toContain('Sitka')
    expect(token).not.toContain('Georgia')
  })

  it('markdown.css：@font-face（100–900、swap）+ 正文 --font-prose + lining/tabular', () => {
    const css = read('src/renderer/src/styles/markdown.css')
    expect(css).toMatch(
      /@font-face\s*\{[^}]*font-family:\s*'kyclaw-serif-latin';[^}]*url\('\.\.\/assets\/fonts\/NotoSerifVariable\.woff2'\)\s*format\('woff2'\);[^}]*font-weight:\s*100 900;/
    )
    expect(css).toMatch(/@font-face\s*\{[^}]*font-display:\s*swap;/)
    expect(css).toMatch(/\.font-prose\s*\{[^}]*font-family:\s*var\(--font-prose\);/)
    const bodyBlock = /\.markdown-body \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(bodyBlock).toContain('font-family: var(--font-prose);')
    // 数字：lining（无 oldstyle）+ tabular（1111=9999）
    expect(bodyBlock).toContain('font-variant-numeric: lining-nums tabular-nums;')
    // 标题/代码/表格口径不回退
    expect(css).toMatch(
      /\.markdown-body h1,[\s\S]*?\.markdown-body h6 \{[^}]*font-family:\s*var\(--font-reading\)/
    )
    expect(css).toMatch(/font-family:\s*var\(--font-code\)/)
    expect(css).toMatch(
      /\.markdown-body th,\s*\n\.markdown-body td \{[\s\S]*?font-variant-numeric:\s*lining-nums tabular-nums/
    )
  })

  it('三处落点：正文 / 思考 / 工具过程英文都走 font-prose；UI chrome 不动', () => {
    expect(read('src/renderer/src/features/chat/parts/TextPart.tsx')).toContain(
      'markdown-body font-prose'
    )
    expect(read('src/renderer/src/features/chat/parts/ReasoningPart.tsx')).toContain(
      'font-prose max-h-[268px]'
    )
    const toolCard = read('src/renderer/src/features/chat/parts/ToolCard.tsx')
    expect(toolCard).toContain('font-prose text-c1')
    expect(toolCard).toMatch(/isTechnicalDetail\(shownDetail\)[\s\S]*?font-mono text-c1/)
    // Composer / 按钮 / 侧栏仍是 sans（不因正文改衬线而波及 chrome）
    expect(read('src/renderer/src/features/chat/Composer.tsx')).toMatch(
      /font-sans[^"']*text-b1|text-b1[^"']*font-sans/
    )
    expect(readIfExists('src/renderer/src/features/chat/ErrorCard.tsx')).toMatch(
      /font-sans text-b2 font-semibold/
    )
  })
})
