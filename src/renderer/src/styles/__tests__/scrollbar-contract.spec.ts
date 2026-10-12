import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读样式表源码：路径经函数参数传进来（Vite 就不会把 `new URL(..., import.meta.url)` 静态改写成资源地址） */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const TAILWIND_CSS = readSource('../tailwind.css')

/**
 * 左栏滚动条 · 静置隐藏（round 50，用户实拍）：钉的是**样式表里的机制**——
 * jsdom 不画滚动条，真机观感与像素级证据在 .superpowers/sdd/2026-10-10-kyclaw-mvp/_r50-*。
 *
 * 这里锁三条：
 *   1. 静置透明（滑块与槽），指针进栏 / 区内有焦点才恢复皮肤那两档；
 *   2. 颜色必须走**元素上那条注册过的自定义属性**——「元素状态作用域直写滚动条伪元素颜色」的写法
 *      在 Chromium 里**不重绘**（round 50 探针 A/D 实测：hover 前后滑块像素都是底色）；
 *      注册成 <color> 还能跟着 --motion-fast 淡入（探针 G），不硬切；
 *   3. 只改颜色不改几何：槽宽仍由全局那条 --scrollbar-size 给 → 显隐不推挤内容。
 */
function utility(name: string): string {
  return new RegExp(`@utility ${name} \\{([\\s\\S]*?)\\n\\}`).exec(TAILWIND_CSS)?.[1] ?? ''
}

const UTILITY = utility('scrollbar-auto-hide')

describe('左栏滚动条 · 静置隐藏（round 50）', () => {
  it('工具类真的在（否则挂上去的类名是空转）', () => {
    expect(UTILITY).not.toBe('')
  })

  it('静置：滑块与槽都透明，滑块颜色取本工具类那条变量', () => {
    expect(UTILITY).toContain('--scrollbar-thumb-auto: transparent;')
    expect(UTILITY).toMatch(/&::-webkit-scrollbar-track \{\s*background-color: transparent;\s*\}/)
    expect(UTILITY).toMatch(
      /&::-webkit-scrollbar-thumb \{\s*background-color: var\(--scrollbar-thumb-auto\);\s*\}/
    )
  })

  it('交互时恢复皮肤：hover / focus-within 回 --scrollbar-thumb，压在滑块上是 --scrollbar-thumb-hover', () => {
    expect(UTILITY).toMatch(
      /&:hover,\s*&:focus-within \{\s*--scrollbar-thumb-auto: var\(--scrollbar-thumb\);\s*\}/
    )
    expect(UTILITY).toMatch(
      /&::-webkit-scrollbar-thumb:hover \{\s*background-color: var\(--scrollbar-thumb-hover\);\s*\}/
    )
    // 反例护栏：不能退回「元素状态作用域直写伪元素颜色」——那套在 Chromium 里不重绘
    expect(UTILITY).not.toContain('&:hover::-webkit-scrollbar-thumb')
    expect(UTILITY).not.toContain('&:focus-within::-webkit-scrollbar-thumb')
  })

  it('颜色变量注册成可插值的 <color> 并允许继承（伪元素才看得见、才能淡入）', () => {
    expect(TAILWIND_CSS).toMatch(
      /@property --scrollbar-thumb-auto \{[\s\S]*?syntax: '<color>';[\s\S]*?inherits: true;[\s\S]*?initial-value: transparent;/
    )
    expect(UTILITY).toContain(
      'transition: --scrollbar-thumb-auto var(--motion-fast) var(--motion-ease-inout);'
    )
  })

  it('几何不动：槽宽仍走全局的 --scrollbar-size，本工具类不碰宽高', () => {
    expect(UTILITY).not.toContain('--scrollbar-size')
    expect(TAILWIND_CSS).toContain('width: var(--scrollbar-size);')
  })

  it('全站皮肤（其他页面的滚动条）不动：全局滑块仍是 --scrollbar-thumb 常驻', () => {
    expect(TAILWIND_CSS).toMatch(
      /::-webkit-scrollbar-thumb \{\s*background-color: var\(--scrollbar-thumb\);/
    )
  })
})
