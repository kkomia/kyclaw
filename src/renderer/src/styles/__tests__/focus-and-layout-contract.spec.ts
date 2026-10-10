import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读样式表源码：路径经函数参数传进来（Vite 就不会把 `new URL(..., import.meta.url)` 静态改写成资源地址） */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const TAILWIND_CSS = readSource('../tailwind.css')

/**
 * 样式契约（UI 返工 R1 复核修复的两条）——jsdom 不做布局，这里钉的是**样式表里的机制**，
 * 真实观感由窗口级连拍序列证明（smoke-ui-r1/14-*）。
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
})

describe('焦点环 · 跟随圆角（复核 + 用户实拍）', () => {
  it('容器级焦点环是墨色 1px、贴内缘的 outline（outline 跟 border-radius，且不占 box-shadow）', () => {
    const utility = /@utility focus-ring-container \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''

    expect(utility).toContain(':has(:focus-visible)')
    expect(utility).toContain('outline: 1px solid var(--text-primary);')
    expect(utility).toContain('outline-offset: -1px;')
    // 口径来自 UI 参考 §5.4：焦点环是墨色，不是品牌蓝
    expect(utility).not.toContain('--accent')
  })
})
