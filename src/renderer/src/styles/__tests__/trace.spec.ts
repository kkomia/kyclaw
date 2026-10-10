import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 过程块样式契约（round 6，对照《对话UI-工具链与显示口径 v0.1》§4.1/§6）：
 *   - 折叠 = 容器级 grid-template-rows 0fr ↔ 1fr **双向过渡**（禁条件渲染硬切，雷点 3/5）；
 *   - 内容层 = opacity + blur + translateY + visibility 四件套；
 *   - 时长/缓动全部走 token（--motion-* / --duration-* / --clp-ease-*），不落裸字面值；
 *   - reduced-motion 三层里的第二层（本域 none !important）与第一层（全局兜底）都要在。
 */
function readSource(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

const css = readSource('../tailwind.css')

describe('trace 折叠容器：grid-rows 双向过渡', () => {
  it('静息 0fr、展开 1fr', () => {
    expect(css).toMatch(/\.trace-fold \{\s*display: grid;\s*grid-template-rows: 0fr;/)
    expect(css).toMatch(/\.trace-fold\[data-open='true'\] \{\s*grid-template-rows: 1fr;/)
  })

  it('两个方向各有一条 transition，且时长/缓动全部走 token', () => {
    expect(css).toMatch(
      /\.trace-fold \{[\s\S]*?transition: grid-template-rows var\(--motion-main\) var\(--clp-ease-out\);/
    )
    expect(css).toMatch(
      /\.trace-fold\[data-open='true'\] \{[\s\S]*?transition: grid-template-rows var\(--duration-shift\) var\(--clp-ease-close\);/
    )
  })

  it('内容层：静息 blur + opacity + translateY + visibility:hidden；展开四值归位', () => {
    expect(css).toMatch(/\.trace-fold-in \{\s*overflow: hidden;\s*min-height: 0;/)
    expect(css).toMatch(/\.trace-fold-in \{[\s\S]*?filter: blur\(10px\);/)
    expect(css).toMatch(/\.trace-fold-in \{[\s\S]*?transform: translateY\(-6px\);/)
    expect(css).toMatch(/\.trace-fold-in \{[\s\S]*?visibility: hidden;/)
    expect(css).toMatch(/\.trace-fold\[data-open='true'\] > \.trace-fold-in \{[\s\S]*?opacity: 1;/)
    expect(css).toMatch(
      /\.trace-fold\[data-open='true'\] > \.trace-fold-in \{[\s\S]*?filter: blur\(0\);/
    )
    expect(css).toMatch(
      /\.trace-fold\[data-open='true'\] > \.trace-fold-in \{[\s\S]*?visibility: visible;/
    )
  })
})

describe('trace 流光字（进行中行的替代表达，文档 .ch-live）', () => {
  it('background-clip: text + 循环时长走 --duration-loop-slow', () => {
    expect(css).toMatch(/\.trace-live \{[\s\S]*?background-clip: text;/)
    expect(css).toMatch(
      /\.trace-live \{[\s\S]*?animation: trace-shimmer var\(--duration-loop-slow\) linear infinite;/
    )
    expect(css).toContain('@keyframes trace-shimmer')
  })
})

describe('reduced-motion 三层', () => {
  it('第二层（本域）：折叠过渡整档停、流光还原成普通灰字', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.trace-fold,\s*\.trace-fold-in \{\s*transition: none !important;/
    )
    expect(css).toMatch(
      /\.trace-live \{\s*animation: none !important;\s*background: none;\s*color: var\(--text-tertiary\);/
    )
  })

  it('第一层（全局兜底）仍在（0.01ms 而不是 0：状态照样变，只是看不出过程）', () => {
    expect(css).toMatch(/animation-duration:\s*0?\.01ms\s*!important/)
    expect(css).toMatch(/transition-duration:\s*0?\.01ms\s*!important/)
  })
})
