import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * task-99 · Office ribbon 三枚下拉（正文/字体/字号）加宽契约。
 *
 * 用户 2026-10-18 09:1x：「提升"正文" "字体" "字号" 的下拉框栏宽度，现在这么窄，本来顶层工具栏也没有用完。」
 * 实现：ribbon 是 container query 容器，三枚触发器按工具带可用宽度分三档；面板以触发器为 min-width、
 * 长字体名（Calibri Light / 微软雅黑）按 max-content 放宽。
 *
 * 真机实测（e2e/_office-ribbon-width.spec.ts，dev HMR）：
 *   窗口 1100 → ribbon 1038 / 剩余 200.6px；1280 → ribbon 898（AI 面板展开）/ 剩余 60.6px；1440 → ribbon 1058 / 剩余 220.6px。
 * 分档依据：标准档相对现状（3×54=162）加宽 +170 → 内容 1007.6 < 1020 阈值；宽档 +250 → 1087.6 < 1100 阈值；
 * 1280 的 898 只放得下 +54（窄档），再宽会挤掉其它组/触发横滚 —— 所以必须分档而不是一个固定大宽。
 */
const CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/office/office-chrome.css'),
  'utf8'
)
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

function widthOf(testId: string): number | null {
  const match = new RegExp(
    `\\.ofr-select\\[data-testid='${testId}'\\]\\s*\\{[^}]*?width:\\s*(\\d+)px;`
  ).exec(CSS_CODE)
  return match === null ? null : Number(match[1])
}

function containerBlock(minWidth: number): string {
  const marker = `@container ofr-ribbon (min-width: ${minWidth}px)`
  const start = CSS_CODE.indexOf(marker)
  if (start < 0) throw new Error(`缺 container 档 ${minWidth}`)
  let depth = 0
  for (let index = start; index < CSS_CODE.length; index += 1) {
    const char = CSS_CODE[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return CSS_CODE.slice(start, index + 1)
    }
  }
  throw new Error(`container ${minWidth} 花括号不闭合`)
}

function containerWidths(minWidth: number): Record<string, number> {
  const block = containerBlock(minWidth)
  const result: Record<string, number> = {}
  for (const match of block.matchAll(
    /\.ofr-select\[data-testid='(office-ribbon-(?:style|font-family|font-size))'\]\s*\{[^}]*?width:\s*(\d+)px;/g
  )) {
    result[match[1]!] = Number(match[2])
  }
  return result
}

describe('task-99 三枚下拉宽度：container query 分档', () => {
  it('ribbon 是 inline-size container（三枚宽度按工具带宽度分档，不引整页 media）', () => {
    expect(CSS_CODE).toMatch(/\.ofr-ribbon\s*\{[^}]*container-type:\s*inline-size;/)
    expect(CSS_CODE).toContain('container-name: ofr-ribbon;')
  })

  it('窄档 <1020：76 / 72 / 62（1280 窗口 AI 面板展开时 band≈898，只放得下约 +48）', () => {
    expect(widthOf('office-ribbon-style')).toBe(76)
    expect(widthOf('office-ribbon-font-family')).toBe(72)
    expect(widthOf('office-ribbon-font-size')).toBe(62)
    // 窄档三枚仍比旧 54 宽，且合计 210（旧 162，+48；留余量吸收 band padding / 亚像素）
    expect(76 + 72 + 62).toBe(210)
  })

  it('标准档 ≥1020：120 / 140 / 72（1100/1440 实测 band 1038/1058）', () => {
    const widths = containerWidths(1020)
    expect(widths['office-ribbon-style']).toBe(120)
    expect(widths['office-ribbon-font-family']).toBe(140)
    expect(widths['office-ribbon-font-size']).toBe(72)
  })

  it('宽档 ≥1100：150 / 176 / 86（最大化/无 AI 面板）', () => {
    const widths = containerWidths(1100)
    expect(widths['office-ribbon-style']).toBe(150)
    expect(widths['office-ribbon-font-family']).toBe(176)
    expect(widths['office-ribbon-font-size']).toBe(86)
  })

  it('落在用户口径区间：正文 120–150 / 字体 140–180 / 字号 72–90（标准+宽档）', () => {
    const standard = containerWidths(1020)
    const wide = containerWidths(1100)
    for (const widths of [standard, wide]) {
      expect(widths['office-ribbon-style']).toBeGreaterThanOrEqual(120)
      expect(widths['office-ribbon-style']).toBeLessThanOrEqual(150)
      expect(widths['office-ribbon-font-family']).toBeGreaterThanOrEqual(140)
      expect(widths['office-ribbon-font-family']).toBeLessThanOrEqual(180)
      expect(widths['office-ribbon-font-size']).toBeGreaterThanOrEqual(72)
      expect(widths['office-ribbon-font-size']).toBeLessThanOrEqual(90)
    }
  })

  it('三枚触发器去掉旧 max-width:118 上限（否则标准/宽档被 CSS 压回去）', () => {
    for (const testId of [
      'office-ribbon-style',
      'office-ribbon-font-family',
      'office-ribbon-font-size'
    ]) {
      const block = new RegExp(`\\.ofr-select\\[data-testid='${testId}'\\]\\s*\\{([^}]*)\\}`).exec(
        CSS_CODE
      )?.[1]
      expect(block, testId).toContain('max-width: none;')
    }
  })

  it('下拉面板宽度跟触发器（min-width 内联）+ 长选项 max-content 放宽，不 ellipsis 截断', () => {
    expect(CSS_CODE).toMatch(/\.ofr-select-menu\s*\{[^}]*width:\s*max-content;/)
    expect(CSS_CODE).toMatch(
      /\.ofr-select-menu\s*\{[^}]*max-width:\s*min\(360px, calc\(100vw - 16px\)\);/
    )
    // 面板固定宽度只由内联 minWidth 给（matchTriggerWidth=false），CSS 不允许再写死 width: <n>px
    expect(CSS_CODE).not.toMatch(/\.ofr-select-menu\s*\{[^}]*width:\s*\d+px;/)
  })
})
