import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'
import { describe, expect, it } from 'vitest'

/**
 * Tailwind 编译护栏。
 *
 * T2 报告 §4 记的缺口是"单测不跑 Tailwind 编译器，dark: 与工具类的可用性只有一次性构建证据"。
 * 这里用 tailwindcss 自带的 compile()（已在依赖里，不引新包）真编译一遍入口样式：
 *   1. dark: 变体确实产出 `[data-theme='dark']` 作用域的规则（换主题机制只有这一处）；
 *   2. T3 组件用到的工具类语法（var() 简写、长度/颜色提示、data 与 group-data 变体）真能生成；
 *   3. shimmer 工具类与动画时长走的是 token。
 */

const require = createRequire(import.meta.url)
// 这里传字符串而不传 new URL(...)：jsdom 环境里的 URL 不是 Node 自己的实现，fileURLToPath 认不出来。
const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = resolve(stylesDir, 'tailwind.css')

/** 真跑一遍 Tailwind：解析 @import、按候选类编译出 CSS（与 electron-vite 里同一份入口）。 */
async function compileCandidates(candidates: string[]): Promise<string> {
  const result = await compile(readFileSync(entryPath, 'utf8'), {
    base: stylesDir,
    loadStylesheet: async (id, base) => {
      const path =
        id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : resolve(base, id)
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
    }
  })
  return result.build(candidates)
}

/** 断言前把空白归一，免得断言被源文件/编译器的换行方式左右。 */
function flatten(css: string): string {
  return css.replace(/\s+/g, ' ')
}

describe('Tailwind 编译护栏', () => {
  it('dark: 变体产出 [data-theme=dark] 作用域规则（不是 .dark、也不是媒体查询）', async () => {
    const css = flatten(await compileCandidates(['dark:bg-menu']))

    expect(css).toContain(
      ".dark\\:bg-menu:where([data-theme='dark'], [data-theme='dark'] *) { background-color: var(--bg-menu); }"
    )
    expect(css).not.toContain('prefers-color-scheme')
  })

  it('浅色工具类不带主题条件（对照：同一个 token 的两种写法）', async () => {
    const css = flatten(await compileCandidates(['bg-menu']))
    expect(css).toContain('.bg-menu { background-color: var(--bg-menu); }')
  })

  const UTILITY_CASES: Array<[string, string[]]> = [
    // [候选类, 产物里必须出现的声明]
    ['h-(--control-height-sm)', ['height: var(--control-height-sm)']],
    ['h-(--nav-item-height)', ['height: var(--nav-item-height)']],
    ['h-(--new-session-height)', ['height: var(--new-session-height)']],
    // 2026-10-17 一级导航只剩图标栏一档：只编译 rail 56（旧的 --primary-nav-width 已删）
    ['w-(--primary-nav-rail-width)', ['width: var(--primary-nav-rail-width)']],
    ['min-w-(--control-min-width-md)', ['min-width: var(--control-min-width-md)']],
    ['size-(--icon-size-md)', ['width: var(--icon-size-md)', 'height: var(--icon-size-md)']],
    ['w-(--overlay-width-sm)', ['width: var(--overlay-width-sm)']],
    ['max-w-(--overlay-max-width)', ['max-width: var(--overlay-max-width)']],
    ['p-(--menu-pad)', ['padding: var(--menu-pad)']],
    ['bg-(--button-primary-bg)', ['background-color: var(--button-primary-bg)']],
    ['text-(--tooltip-fg)', ['color: var(--tooltip-fg)']],
    ['placeholder:text-(--text-quaternary)', ['color: var(--text-quaternary)']],
    ['border-(--border-field)', ['border-color: var(--border-field)']],
    ['border-(length:--hairline-width)', ['border-width: var(--hairline-width)']],
    ['rounded-(--menu-item-radius)', ['border-radius: var(--menu-item-radius)']],
    ['opacity-(--icon-opacity)', ['opacity: var(--icon-opacity)']],
    ['shadow-(--shadow-overlay)', ['--tw-shadow: var(--shadow-overlay)']],
    ['backdrop-blur-(--blur-glass)', ['--tw-backdrop-blur: blur(var(--blur-glass))']],
    ['duration-(--motion-main)', ['transition-duration: var(--motion-main)']],
    // round 29：停靠区（审批条）的开合走容器级 grid-rows 过渡 —— 0fr ↔ 1fr 与过渡属性都得真生成
    ['grid-rows-[0fr]', ['grid-template-rows: 0fr']],
    ['grid-rows-[1fr]', ['grid-template-rows: 1fr']],
    ['transition-[grid-template-rows]', ['transition-property: grid-template-rows']],
    ['data-[highlighted]:bg-hover', ['background-color: var(--fill-hover)']],
    [
      'group-data-disabled:opacity-(--icon-opacity-disabled)',
      ['opacity: var(--icon-opacity-disabled)']
    ],
    ['group-hover:opacity-(--icon-opacity-hover)', ['opacity: var(--icon-opacity-hover)']],
    // 禁用态（T5 随修 T3 遗留）：:disabled 叠在 hover/active 上压掉亮底，压不掉就是外观 bug
    ['disabled:hover:bg-transparent', ['background-color: transparent']],
    ['disabled:active:bg-transparent', ['background-color: transparent']],
    ['disabled:text-(--text-disabled)', ['color: var(--text-disabled)']],
    ['disabled:placeholder:text-(--text-disabled)', ['color: var(--text-disabled)']],
    // round 64：输入卡两档最小高 + 换档过渡 + 草稿期能力行的居中偏移（初始页光学居中）
    ['min-h-(--composer-input-min-height)', ['min-height: var(--composer-input-min-height)']],
    [
      'min-h-(--composer-input-min-height-hero)',
      ['min-height: var(--composer-input-min-height-hero)']
    ],
    ['transition-[min-height]', ['transition-property: min-height']],
    ['transition-[flex-grow,margin-top]', ['transition-property: flex-grow,margin-top']],
    [
      'max-h-(--radix-dropdown-menu-content-available-height)',
      ['max-height: var(--radix-dropdown-menu-content-available-height)']
    ],
    ['mt-8', ['margin-top: calc(var(--spacing) * 8)']],
    // round 66：空态占位的上提偏移（卡片上/下各一行后的重新推导值 = 72px）
    // round 76 复核：两行从"条件渲染"改成"常挂 + 收合"（收合含外边距）后**结论不变**，
    // 仍是 72px —— 推导见 ChatPage 里 welcome-spacer 的那段注释
    ['mt-18', ['margin-top: calc(var(--spacing) * 18)']],
    // round 76：初始页两行（CollapsibleRow）的收合 —— 高度与淡出走同一条过渡（主档时长，不硬切）
    [
      'transition-[grid-template-rows,opacity]',
      ['transition-property: grid-template-rows,opacity']
    ],
    // round 87：消息导览轨的行高不再写死 h-7，改由组件按条数算好、经这两个变量喂进去
    // （常态 / hover·聚焦展开态）——变量简写必须真编译得出 height
    ['h-(--rail-row)', ['height: var(--rail-row)']],
    ['hover:h-(--rail-row-open)', ['height: var(--rail-row-open)']],
    ['focus-visible:h-(--rail-row-open)', ['height: var(--rail-row-open)']]
  ]

  it.each(UTILITY_CASES)('工具类 %s 生成 token 引用', async (candidate, declarations) => {
    const css = flatten(await compileCandidates([candidate]))

    for (const declaration of declarations) {
      expect(css, `${candidate} 缺少 ${declaration}`).toContain(declaration)
    }
  })

  it('禁用变体带 :disabled 伪类（不只是媒体查询里的 hover）', async () => {
    const css = flatten(await compileCandidates(['disabled:hover:bg-transparent']))

    expect(css).toContain(':disabled')
    expect(css).toContain(':hover')
  })

  it('变量简写要能写进 data-*/group-* 变体（图标按钮的禁用态依赖它）', async () => {
    const css = flatten(
      await compileCandidates(['group-data-disabled:opacity-(--icon-opacity-disabled)'])
    )
    expect(css).toContain('data-disabled')
    expect(css).toContain('var(--icon-opacity-disabled)')
  })

  it('spinner 用 1s linear 常速（--duration-loop，§6.5）', async () => {
    const css = flatten(await compileCandidates(['animate-spin']))
    expect(css).toContain('animation: spin var(--duration-loop) linear infinite')
    expect(css).toContain('@keyframes spin')
  })

  it('shimmer 工具类与关键帧进产物（§6.6，高光色走 token）', async () => {
    const css = flatten(await compileCandidates(['shimmer']))
    expect(css).toContain('.shimmer {')
    expect(css).toContain(
      'background-image: linear-gradient(90deg, transparent, var(--skeleton-highlight), transparent)'
    )
    expect(css).toContain('background-size: 200% 100%')
    expect(css).toContain('animation: shimmer var(--duration-loop-slow) linear infinite')
    expect(css).toContain('@keyframes shimmer')
  })

  it('无边框窗口的拖拽区工具类（drag-region / no-drag）真进产物', async () => {
    const css = flatten(await compileCandidates(['drag-region', 'no-drag']))

    expect(css).toContain('-webkit-app-region: drag')
    expect(css).toContain('-webkit-app-region: no-drag')
  })

  it('左栏滚动条静置隐藏（round 50）：伪元素选择器与注册过的颜色变量真进产物', async () => {
    // 用原始产物（不 flatten）：这里要看的就是嵌套写法本身有没有被保留
    const css = await compileCandidates(['scrollbar-auto-hide'])

    expect(css).toContain('@property --scrollbar-thumb-auto {')
    expect(css).toContain("syntax: '<color>';")
    expect(css).toContain('.scrollbar-auto-hide {')
    expect(css).toContain('&::-webkit-scrollbar-thumb {')
    expect(css).toContain('background-color: var(--scrollbar-thumb-auto);')
    // 恢复档：元素级 hover / focus-within，以及滑块自身的 hover
    expect(css).toContain('&:focus-within {')
    expect(css).toContain('&::-webkit-scrollbar-thumb:hover {')
    expect(css).toContain('background-color: var(--scrollbar-thumb-hover);')
  })
})
