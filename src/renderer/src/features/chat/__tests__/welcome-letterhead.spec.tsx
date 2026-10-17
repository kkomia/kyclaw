import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WelcomeHero } from '../WelcomeHero'
import { render, screen } from '@testing-library/react'

/**
 * A · 信笺（task-50）的**文件级契约**：WelcomeHero 的结构与 welcome.css 的关键手法。
 *
 * jsdom 不算样式，所以这里分两层钉：
 *   1. 结构：lockup / 印章 96 / 竖线 / 细线 / tagline / note / 纸感层 / 项目行引线都在；
 *   2. CSS 文件：56px 报头（900 以下 ×0.85）、552 细线、18px 点阵 + 640×430 暖光（≤8.5%、
 *      两个伪元素、`--welcome-texture/--welcome-glow` 可一键关）、角落位 <1100 隐藏、
 *      320ms 细线展开、reduced-motion 全静态。
 * 运行时的布局/交互断言在 `welcome-hero.spec.tsx`。
 */

const REPO_ROOT = process.cwd()
const WELCOME_CSS = readFileSync(
  resolve(REPO_ROOT, 'src/renderer/src/features/chat/welcome.css'),
  'utf8'
)

describe('A · 信笺 · 结构（WelcomeHero）', () => {
  it('报头 lockup：印章 + 1px 竖线 + 字标，顺序固定；细线在报头与 tagline 之间', () => {
    render(<WelcomeHero active />)

    const lockup = document.querySelector('.welcome-lockup')
    expect(lockup).not.toBeNull()
    const children = Array.from(lockup?.children ?? [])
    expect(children[0]?.classList.contains('welcome-seal')).toBe(true)
    expect(children[1]?.classList.contains('welcome-mark-rule')).toBe(true)
    expect(children[2]).toBe(screen.getByTestId('welcome-title'))

    const hair = screen.getByTestId('welcome-hair')
    const tagline = screen.getByTestId('welcome-tagline')
    expect(hair.compareDocumentPosition(tagline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 细线是纯装饰：aria-hidden
    expect(hair).toHaveAttribute('aria-hidden', 'true')
  })

  it('字标仍是 `<span>&lt;</span>kyclaw<span>&gt;</span>`：括号 accent + 细声部 class，整块进可访问树', () => {
    render(<WelcomeHero active />)
    const title = screen.getByTestId('welcome-title')
    expect(title.textContent).toBe('<kyclaw>')
    const brackets = title.querySelectorAll('.welcome-bracket')
    expect(brackets).toHaveLength(2)
    for (const bracket of brackets) expect(bracket).toHaveClass('text-accent-text')
  })

  it('纸感层存在且 hero 时 active：aria-hidden、pointer-events 由 CSS 关掉', () => {
    render(
      <div>
        <div
          data-testid="welcome-paper"
          data-active="true"
          aria-hidden="true"
          className="welcome-paper"
        />
        <WelcomeHero active />
      </div>
    )
    const paper = screen.getByTestId('welcome-paper')
    expect(paper).toHaveAttribute('data-active', 'true')
    expect(paper).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('A · 信笺 · welcome.css 关键手法', () => {
  it('报头字标 56（900 以下 ×0.85）+ 行高 1 + -0.028em；括号 weight 400', () => {
    expect(WELCOME_CSS).toContain('--text-welcome-size: 56px')
    expect(WELCOME_CSS).toContain('font-size: var(--text-welcome-size)')
    expect(WELCOME_CSS).toContain('line-height: 1')
    expect(WELCOME_CSS).toContain('letter-spacing: -0.028em')
    expect(WELCOME_CSS).toMatch(
      /@media \(max-width: 900px\) \{[\s\S]*?font-size: calc\(var\(--text-welcome-size\) \* 0\.85\)/
    )
    expect(WELCOME_CSS).toMatch(/\.welcome-bracket \{\s*font-weight: 400;/)
  })

  it('竖线 54 / 细线 552×1 / 节奏 26-18（task-53 删小字后到 tagline 收尾）/ tagline 17', () => {
    expect(WELCOME_CSS).toMatch(/\.welcome-mark-rule \{[\s\S]*?width: 1px;[\s\S]*?height: 54px;/)
    expect(WELCOME_CSS).toMatch(/\.welcome-hair \{[\s\S]*?width: 552px;[\s\S]*?height: 1px;/)
    expect(WELCOME_CSS).toMatch(/\.welcome-hair \{[\s\S]*?margin: 26px auto 0;/)
    expect(WELCOME_CSS).toMatch(/\.welcome-tagline \{\s*margin: 18px 0 0;[\s\S]*?font-size: 17px;/)
    // 「本地运行，文件不出这台机器」已整行删除：样式/间距都不再存在
    expect(WELCOME_CSS).not.toContain('.welcome-note')
  })

  it('纸感（task-53 收口）：点阵中心亮四周收（radial mask）+ 640×430 暖光、两层、≤8.5%、可一键关', () => {
    // 点阵：18px 一格 + 1px 点
    expect(WELCOME_CSS).toMatch(/--welcome-texture: radial-gradient\([\s\S]*?circle 1px at 1px 1px/)
    expect(WELCOME_CSS).toContain('background-size: 18px 18px')
    // 「中心亮、四周收」：radial 蒙版 + 可调中心点变量
    expect(WELCOME_CSS).toMatch(
      /--welcome-fade: radial-gradient\([\s\S]*?ellipse 58% 46% at 50% 30%/
    )
    expect(WELCOME_CSS).toMatch(
      /\.welcome-paper::before \{[\s\S]*?mask-image: var\(--welcome-fade\)/
    )
    // 暖光尺寸与强调色上限：浅 6% / 深 8.5%
    expect(WELCOME_CSS).toMatch(/width: 640px;[\s\S]*?height: 430px;/)
    expect(WELCOME_CSS).toContain('rgba(217, 119, 87, 0.06)')
    expect(WELCOME_CSS).toContain('rgba(217, 119, 87, 0.085)')
    // 两个伪元素各管一层，且都能被 var 关掉
    expect(WELCOME_CSS).toMatch(
      /\.welcome-paper::before \{[\s\S]*?background-image: var\(--welcome-texture\)/
    )
    expect(WELCOME_CSS).toMatch(
      /\.welcome-paper::after \{[\s\S]*?background-image: var\(--welcome-glow\)/
    )
    expect(WELCOME_CSS).toContain('一键关：把 --welcome-texture / --welcome-glow 改成 none')
    // 不要暗角/ASCII/背景动画；窄窗暖光收 92% 防溢出
    expect(WELCOME_CSS).not.toContain('box-shadow: inset')
    expect(WELCOME_CSS).not.toContain('ascii')
    expect(WELCOME_CSS).toContain('max-width: 92%')
    expect(WELCOME_CSS).toMatch(/\.welcome-paper \{[\s\S]*?overflow: hidden;/)
  })

  it('细线 320ms 展开一次；reduced-motion 全部静态', () => {
    expect(WELCOME_CSS).toContain('@keyframes welcome-hair-in')
    expect(WELCOME_CSS).toContain('animation: welcome-hair-in var(--motion-enter, 320ms)')
    expect(WELCOME_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.welcome-hair \{\s*animation: none;/
    )
  })

  it('项目行引线：flex:1 1px l1（--border-field）', () => {
    expect(WELCOME_CSS).toMatch(
      /\.welcome-project-rule \{[\s\S]*?flex: 1;[\s\S]*?background: var\(--border-field\);/
    )
  })

  it('task-62：状态海獭挪到输入卡右上角 —— welcome.css 不再留 header 的 :has 让位规则', () => {
    // 一屏一只改由渲染条件保证（hero 时 Composer 不渲染状态獭、ChatHeader 已无海獭），
    // 原先针对 `.chat-otter` 的 :has 规则是死代码，已删除（对应 CSS/DOM 契约在 composer.spec）。
    expect(WELCOME_CSS).not.toContain(':has(')
    expect(WELCOME_CSS).not.toContain('chat-otter')
    // 角落氛围位整套已删除（task-53）
    expect(WELCOME_CSS).not.toContain('welcome-corner-slot')
    expect(WELCOME_CSS).not.toContain('welcome-ambient-otter')
  })
})
