import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * task-76 · Office 工具栏返工契约（源码级，无内核/无 Electron）：
 *   - 高度：tabs 28 + band 54 + 1px hairline = 83 ≤ 84（用户「不需要这么高」口径）；
 *   - 下拉：不再有原生 `<select>`（popup 由 OS 绘制、CSS/token 进不去 → 暗色白底白字），
 *     一律自绘 listbox + portal + fixed；浮层用 semantic token（切主题立即重绘）；
 *   - 组标签不再占一行（绝对定位 hover tooltip）；
 *   - 纸面：暗色主题 canvas 原生白、无暗纸滤镜（task-76 覆盖 A4 灰纸）。
 */
function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const chromeCss = read('../office-chrome.css')
/** 去掉 CSS 注释再断言：注释里会提到旧实现（如旧暗纸 filter 只在历史说明里出现） */
const chromeCode = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '')
const ribbonViewTsx = read('../components/OfficeRibbonView.tsx')
const popoverTs = read('../components/office-popover.ts')
const semanticCss = read('../../styles/tokens/semantic.css')

function tokenValue(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)px;`).exec(semanticCss)
  if (match === null) throw new Error(`semantic.css 缺 token --${name}`)
  return Number(match[1])
}

describe('task-76 工具栏高度：≤84px', () => {
  it('tabs 28 / band 54 / 总高 83（含 1px 底线）', () => {
    expect(tokenValue('office-ribbon-tabs-height')).toBe(28)
    expect(tokenValue('office-ribbon-body-height')).toBe(54)
    expect(tokenValue('office-ribbon-total-height')).toBe(83)
    expect(tokenValue('office-ribbon-total-height')).toBeLessThanOrEqual(84)
    // .ofr-bar / .ofr-body 仍消费 token（不写死像素，折叠过渡不改高度来源）
    expect(chromeCss).toMatch(/\.ofr-bar\s*\{[^}]*height:\s*var\(--office-ribbon-tabs-height\)/)
    expect(chromeCss).toMatch(/\.ofr-body\s*\{[^}]*height:\s*var\(--office-ribbon-body-height\)/)
  })

  it('按钮 26、select 触发钮 24、QAT 24、内置控件 ≤26（能塞进 54 的 band）', () => {
    expect(chromeCode).toContain('--ofr-button-size: 26px;')
    expect(chromeCss).toMatch(/\.ofr-select\s*\{[^}]*height:\s*24px/)
    expect(chromeCss).toMatch(/\.ofr-qat-btn\s*\{[^}]*height:\s*24px/)
    expect(chromeCss).toMatch(/\.ofr-builtin\s*\{[^}]*height:\s*26px/)
    expect(chromeCss).toMatch(/\.ofr-builtin-control\s*\{[^}]*max-height:\s*26px/)
  })

  it('组标签绝对定位（hover tooltip，不占行高）', () => {
    expect(chromeCss).toMatch(/\.ofr-group-label\s*\{[^}]*position:\s*absolute/)
    expect(chromeCss).toMatch(/\.ofr-group:hover \.ofr-group-label/)
    expect(chromeCss).toMatch(/\.ofr-group\s*\{[^}]*position:\s*relative/)
  })
})

describe('task-76 下拉框：自绘 listbox + 主题 token', () => {
  it('ribbon 里没有原生 <select> JSX；RibbonSelect 用 combobox trigger + portal listbox', () => {
    expect(ribbonViewTsx).not.toMatch(/\n\s*<select[\s>]/)
    expect(ribbonViewTsx).toContain('role="combobox"')
    expect(ribbonViewTsx).toContain('role="listbox"')
    expect(ribbonViewTsx).toContain('aria-haspopup="listbox"')
    expect(ribbonViewTsx).toContain('aria-activedescendant')
    expect(ribbonViewTsx).toContain('createPortal')
    expect(ribbonViewTsx).toContain('useAnchoredPanel')
    // 7 个 select 命令统一走 RibbonSelect（模型里的 select 类型只在这里分派）
    expect(ribbonViewTsx).toContain("if (item.type === 'select')")
  })

  it('浮层颜色全部 semantic token（切换深浅主题即重绘，不残留旧色）', () => {
    const menu = /\.ofr-select-menu\s*\{([^}]*)\}/.exec(chromeCss)?.[1]
    expect(menu).toBeDefined()
    expect(menu).toContain('background: var(--bg-menu);')
    expect(menu).toContain('border: 1px solid var(--border-hairline);')
    expect(menu).toContain('box-shadow: var(--shadow-overlay);')
    expect(menu).toContain('color: var(--text-primary);')
    // 旧根因：原生 select 写死 `color-scheme: light`（暗色 popup 仍白底）——已删
    expect(chromeCode).not.toContain('color-scheme: light')
    // 色板浮层同样 portal + token
    const palette = /\.ofr-palette\s*\{([^}]*)\}/.exec(chromeCss)?.[1]
    expect(palette).toContain('background: var(--bg-menu);')
    expect(palette).toContain('box-shadow: var(--shadow-overlay);')
  })

  it('浮层定位：portal 到 body + fixed + 视口夹取（窄窗不溢出）；滚动重算不关闭', () => {
    expect(popoverTs).toContain("position: 'fixed'")
    expect(popoverTs).toContain('VIEWPORT_MARGIN')
    expect(popoverTs).toContain("window.addEventListener('scroll'")
    expect(popoverTs).toContain("window.addEventListener('resize'")
    expect(popoverTs).toContain('onDismiss')
    // portal 在 ribbon 视图里调用（浮层挂 body，不挂在 .ofr-band 的 overflow 裁切里）
    expect(ribbonViewTsx).toContain('createPortal')
    expect(ribbonViewTsx).toContain('document.body')
  })
})

describe('task-76 纸面：暗色下原生白', () => {
  it('canvas 纸面 #ffffff，不再有 A4 暗纸滤镜', () => {
    expect(chromeCode).toContain('background-color: #ffffff')
    expect(chromeCode).not.toMatch(/filter:\s*invert\(0\.78\)/)
    expect(chromeCode).toMatch(/\.oox-root\.dark \.canvas-page\s*\{[^}]*filter:\s*none/)
    // 画布（周边）仍暗：surface.css 把 --doc-bg 接到 --doc-canvas-bg
    const surfaceCss = read('../surface.css')
    expect(surfaceCss).toMatch(/--doc-bg:\s*var\(--doc-canvas-bg\)/)
  })
})
