import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读样式表源码：路径经函数参数传进来（Vite 就不会把 `new URL(..., import.meta.url)` 静态改写成资源地址） */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const TAILWIND_CSS = readSource('../tailwind.css')

/**
 * 样式契约（UI 返工 R1 复核修复的两条 + R2 修复轮 round 2 的焦点环颜色 / round 3 的缺口角梯度）——
 * jsdom 不做布局，这里钉的是**样式表里的机制**，真实观感由窗口级连拍序列证明（smoke-ui-r1/14-*、
 * smoke-ui-r2/F*、G*）。
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
    // --border-hairline = 比 Separators-S1 深一档的灰（2026-10-16 边框可见度轮：浅 20% 黑 / 深 18% 白），
    // 两档都是灰，值锁在 tokens.spec。
    expect(utility).not.toContain('var(--text-primary)')
    expect(utility).not.toContain('--accent')
  })

  it('round 48：基础态就写死环色 —— 否则聚焦首帧会从 currentColor 过渡出一圈墨色/白色框线', () => {
    const utility = /@utility focus-ring-container \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''
    // composer 卡片带 transition-colors，v4 的 transition-colors 含 outline-color：
    // 颜色只在 :has(:focus-visible) 里给 → outline-color 从继承色（浅色近黑 / 暗色近白）
    // 花 150ms 淡到分隔线灰，而 outline-style 是同一帧变 solid 的 → 用户实拍"闪一圈白/浅色框线"。
    // 逐帧实证见 .superpowers/sdd/2026-10-10-kyclaw-mvp/_r48-flash-before/（暗色 0.84 白 → 0.12 白）。
    const base = utility.split('&:has(:focus-visible)')[0]
    expect(base).toContain('outline-color: var(--border-hairline);')
  })
})

describe('壳 · 缺口角梯度（round 3：防静默回退）', () => {
  it('shell-notch（上沿）：圆盘补集 —— 圆心在右下、圆盘外才是画布', () => {
    const utility = /@utility shell-notch \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''

    expect(utility).toContain('circle at 100% 100%')
    expect(utility).toContain('transparent 0 calc(var(--radius-overlay) - 1px)')
    expect(utility).toContain('var(--bg-canvas) var(--radius-overlay)')
  })

  it('shell-notch-bottom（下沿镜像）：圆心在右上（100% 0%）', () => {
    const utility = /@utility shell-notch-bottom \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''

    expect(utility).toContain('circle at 100% 0%')
    expect(utility).toContain('transparent 0 calc(var(--radius-overlay) - 1px)')
    expect(utility).toContain('var(--bg-canvas) var(--radius-overlay)')
  })
})

describe('全局焦点环 · 去墨色（round 5，用户实拍 #7）', () => {
  const SEMANTIC_CSS = readSource('../tokens/semantic.css')
  const MENU_TSX = readSource('../../components/ui/menu.tsx')

  it('焦点环是分隔线灰（Separators-S1），不再是 Labels-Primary 墨色', () => {
    expect(SEMANTIC_CSS).toContain('--focus-ring: inset 0 0 0 1px var(--Separators-S1);')
    expect(SEMANTIC_CSS).not.toContain('--focus-ring: inset 0 0 0 1px var(--Labels-Primary);')
    // 全局规则本身保持"内环不占布局"的机制（只换颜色，不删指示）
    expect(TAILWIND_CSS).toContain('box-shadow: var(--focus-ring)')
  })

  it('菜单条目键盘高亮只铺填充（Fills-F1），不再叠焦点环', () => {
    expect(MENU_TSX).toContain('data-[highlighted]:bg-hover')
    expect(MENU_TSX).toContain('focus-visible:shadow-none')
  })
})
