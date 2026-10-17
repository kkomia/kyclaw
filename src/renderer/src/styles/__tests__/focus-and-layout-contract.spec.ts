import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读样式表源码：路径经函数参数传进来（Vite 就不会把 `new URL(..., import.meta.url)` 静态改写成资源地址） */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const TAILWIND_CSS = readSource('../tailwind.css')

/**
 * 样式契约（UI 返工 R1 复核修复的两条 + R2 修复轮 round 2 的焦点环颜色；
 * 2026-10-17 壳布局改版：会话侧栏进卡、覆盖层时代的"安全左边 / 缺口角"机制整档删除）。
 * jsdom 不做布局，这里钉的是**样式表里的机制**，真实观感由窗口级连拍序列证明。
 */

describe('内容列 · 布局契约（2026-10-17：覆盖层 safe-left 机制退休）', () => {
  it('content-column 只做限宽 + 在自己的可用宽里居中（不再从 --content-safe-left 推导几何）', () => {
    const utility = /@utility content-column \{([\s\S]*?)\n\}/.exec(TAILWIND_CSS)?.[1] ?? ''
    const normalized = utility.replace(/\s+/g, ' ').trim()

    expect(normalized).toContain('width: min(100%, var(--content-max-width));')
    expect(normalized).toContain('margin-inline: auto;')
    // 侧栏已是卡内 flex 兄弟：主列宽度天然不含侧栏，再扣一条安全边就是双偏移（旧 bug）
    expect(utility).not.toContain('--content-safe-left')
    // 内容列自己没有过渡（几何跟着 flex 重排走，不需要逐帧插值一条偏移量）
    expect(utility).not.toContain('transition')
  })

  it('@property --content-safe-left 与壳根 [data-sidebar] 的过渡规则都已删除（防静默回退）', () => {
    expect(TAILWIND_CSS).not.toContain('@property --content-safe-left')
    expect(TAILWIND_CSS).not.toMatch(/\[data-sidebar='expanded'\]/)
    expect(TAILWIND_CSS).not.toMatch(/\[data-sidebar\]\s*\{/)
  })
})

describe('壳 · 缺口角机制已退休（2026-10-17 侧栏进卡）', () => {
  it('shell-notch / shell-notch-bottom 两段样式都删了（不再有覆盖层要补的圆角缺口）', () => {
    expect(TAILWIND_CSS).not.toContain('@utility shell-notch')
    expect(TAILWIND_CSS).not.toContain('shell-notch-bottom')
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

describe('全局焦点环 · 去墨色（round 5，用户实拍 #7）', () => {
  const SEMANTIC_CSS = readSource('../tokens/semantic.css')
  const MENU_TSX = readSource('../../components/ui/menu.tsx')

  it('焦点环是暖灰（Claude tertiary），不再是 Labels-Primary 墨色、也不是 accent 陶土橙', () => {
    // P0（章程 §3.7/D-11）：焦点环保底「暖灰」拍板 —— 浅 #8f8a7e / 深 #8f8d84 = identity --k-ink-3
    expect(SEMANTIC_CSS).toContain('--focus-ring: inset 0 0 0 1px var(--k-ink-3);')
    expect(SEMANTIC_CSS).not.toContain('--focus-ring: inset 0 0 0 1px var(--Labels-Primary);')
    expect(SEMANTIC_CSS).not.toContain('--focus-ring: inset 0 0 0 1px var(--k-accent)')
    // 全局规则本身保持"内环不占布局"的机制（只换颜色，不删指示）
    expect(TAILWIND_CSS).toContain('box-shadow: var(--focus-ring)')
  })

  it('菜单条目键盘高亮只铺填充（Fills-F1），不再叠焦点环', () => {
    expect(MENU_TSX).toContain('data-[highlighted]:bg-hover')
    expect(MENU_TSX).toContain('focus-visible:shadow-none')
  })
})
