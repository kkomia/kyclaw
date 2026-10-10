import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读样式表源码：路径经函数参数传进来（Vite 就不会把 `new URL(..., import.meta.url)` 静态改写成资源地址） */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const TAILWIND_CSS = readSource('../tailwind.css')

/**
 * 样式契约（UI 返工 R1 复核修复的两条 + R2 修复轮 round 2 的焦点环颜色）——
 * jsdom 不做布局，这里钉的是**样式表里的机制**，真实观感由窗口级连拍序列证明（smoke-ui-r1/14-*、
 * smoke-ui-r2/F*）。
 */

describe('内容列 · 动效契约（复核 Important #1）', () => {
  it('@property 把 --content-safe-left 注册成可插值的长度，并允许继承', () => {
    expect(TAILWIND_CSS).toMatch(
      /@property --content-safe-left \{[\s\S]*?syntax: '<length>';[\s\S]*?inherits: true;[\s\S]*?initial-value: 0px;/
    )
  })

  it('过渡挂在"值真正变化的元素"（壳根的 [data-sidebar]）上', () => {
    expect(TAILWIND_CSS).toMatch(
      /\[data-sidebar\] \{\s*transition: --content-safe-left var\(--motion-main\) var\(--motion-ease-inout\);\s*\}/
    )
  })

  it('content-column 只从变量推导几何，自身不再单过渡 margin-left（否则宽度会先跳一帧）', () => {
    const utility = /@utility content-column \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''

    expect(utility).toContain(
      'width: min(calc(100% - var(--content-safe-left)), var(--content-max-width));'
    )
    expect(utility).toContain('var(--content-safe-left)')
    expect(utility).not.toContain('transition')
  })

  it('居中基准是可见区 [safe-left, 100%]：先扣安全边取居中，再加回安全边（R2 D1）', () => {
    const utility = /@utility content-column \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''
    const normalized = utility.replace(/\s+/g, ' ')

    // 旧口径（按整个主列居中，max(居中, safeLeft)）在侧栏开时贴边 + 右侧留一大截空档
    expect(normalized).toContain(
      'margin-left: calc( var(--content-safe-left) + max(calc((100% - var(--content-safe-left) - var(--content-max-width)) / 2), 0px) );'
    )
    expect(normalized).not.toContain('max( calc((100% - min(')
  })
})

describe('焦点环 · 跟随圆角（复核 + 用户实拍）', () => {
  it('容器级焦点环是分隔线灰 1px、贴内缘的 outline（round 2：灰档，两主题都取灰）', () => {
    const utility = /@utility focus-ring-container \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''

    expect(utility).toContain(':has(:focus-visible)')
    expect(utility).toContain('outline: 1px solid var(--border-hairline);')
    expect(utility).toContain('outline-offset: -1px;')
    // round 2 用户实拍：不能再用墨色（暗近白 / 浅近黑，对比过重），也不能是品牌蓝。
    // --border-hairline = Separators-S1（浅 13% 黑 / 深 12% 白），两档都是灰，值锁在 tokens.spec。
    expect(utility).not.toContain('var(--text-primary)')
    expect(utility).not.toContain('--accent')
  })
})
