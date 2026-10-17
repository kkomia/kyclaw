import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * P3 · Office 面字体/token 对齐契约（A5 字体审计 ① + 章程 §2.1/§2.5/§9.7-1）。
 *
 * 这些是**源码级契约**（读 CSS/入口源码），因为面内样式不经过 jsdom 的样式计算：
 *   - 面内字体只读 `--font-ui` / `--font-code`（不再镜像第二份系统栈）；
 *   - 组标签 = 无衬线 11/14、500、`--text-tertiary`（不是 mono 9.5）；
 *   - ribbon 焦点 = 暖灰（1px `--text-tertiary` 环 + 2px 偏移），不引 accent；
 *   - surface.css 不再残留旧十六进制 fallback；调试面字号已注明专用。
 */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const chromeCss = readSource('../office-chrome.css')
const surfaceCss = readSource('../surface.css')
const officeMainTsx = readSource('../main.tsx')

/** 取某条 CSS 规则的声明块（简单扁平规则；本文件规则都不嵌套） */
function blockOf(css: string, selector: string): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  const match = pattern.exec(css)
  if (match === null) throw new Error(`找不到规则 ${selector}`)
  return match[1]
}

describe('P3 Office 面：字体栈接 token（audit ①）', () => {
  it('面入口先 import identity/motion/kimi/semantic，再 import 面样式（token 单源、顺序正确）', () => {
    const identity = officeMainTsx.indexOf("import '../styles/tokens/identity.css'")
    const motion = officeMainTsx.indexOf("import '../styles/tokens/motion.css'")
    const kimi = officeMainTsx.indexOf("import '../styles/tokens/kimi-tokens.css'")
    const semantic = officeMainTsx.indexOf("import '../styles/tokens/semantic.css'")
    const surface = officeMainTsx.indexOf("import './surface.css'")
    const chrome = officeMainTsx.indexOf("import './office-chrome.css'")
    expect(identity).toBeGreaterThan(-1)
    expect(motion).toBeGreaterThan(identity)
    expect(kimi).toBeGreaterThan(motion)
    expect(semantic).toBeGreaterThan(kimi)
    expect(surface).toBeGreaterThan(semantic)
    expect(chrome).toBeGreaterThan(surface)
  })

  it('office-chrome.css：--ofr-font-sans/-mono 直接接 --font-ui/--font-code，不再镜像系统栈', () => {
    const ribbon = blockOf(chromeCss, '.ofr-ribbon')
    expect(ribbon).toContain('--ofr-font-sans: var(--font-ui);')
    expect(ribbon).toContain('--ofr-font-mono: var(--font-code);')
    // 旧镜像栈（P3 前的第二数据源）不得复活
    expect(chromeCss).not.toContain("'Microsoft YaHei'")
    expect(chromeCss).not.toContain("'Geist Mono'")
    expect(chromeCss).not.toContain("'PingFang SC'")
    expect(chromeCss).not.toContain('system-ui,')
  })

  it('surface.css：body 字体接 --font-ui（不再镜像栈）', () => {
    const body = blockOf(surfaceCss, 'body')
    expect(body).toContain('font-family: var(--font-ui);')
    expect(surfaceCss).not.toContain("'Microsoft YaHei'")
    expect(surfaceCss).not.toContain('system-ui,')
    expect(surfaceCss).not.toContain("'Segoe UI'")
  })

  it('字声部分工：只有调试条 / 技术读数用 --font-code（chrome 正文仍 --font-ui）', () => {
    // 调试条（DEV/officeDebug 才显示）= mono + tabular
    const status = blockOf(surfaceCss, '.office-surface-status')
    expect(status).toContain('font-family: var(--font-code);')
    expect(status).toContain('font-variant-numeric: tabular-nums;')
    // 调试条字号 11px 属"调试面专用"，已注释（不纳入全局字阶）
    expect(surfaceCss).toContain('调试面专用')
  })
})

describe('P3 Office 面：组标签 11/14/500/tertiary', () => {
  it('无衬线（不是 mono）、11px / 14px / 500 / --text-tertiary，保留 tabular-nums，无字距', () => {
    const label = blockOf(chromeCss, '.ofr-group-label')
    expect(label).toContain('font-family: var(--ofr-font-sans);')
    expect(label).not.toContain('--ofr-font-mono')
    expect(label).toContain('font-size: 11px;')
    expect(label).toContain('line-height: 14px;')
    expect(label).toContain('font-weight: 500;')
    expect(label).toContain('color: var(--text-tertiary);')
    expect(label).toContain('font-variant-numeric: tabular-nums;')
    // P3 前的 mono 9.5 + letter-spacing 规格不得残留
    expect(chromeCss).not.toContain('font-size: 9.5px')
    expect(label).not.toContain('letter-spacing')
  })

  it('工具带高度 token 不变（组标签改字号不改 80px band 契约）', () => {
    // 80px 固定在 .ofr-body（band 只 height:100% 填满）；切 tab 高度恒为 80 → 不抖
    expect(blockOf(chromeCss, '.ofr-body')).toContain('height: var(--office-ribbon-body-height);')
    expect(blockOf(chromeCss, '.ofr-band')).toContain('height: 100%;')
  })
})

describe('P3 Office 面：ribbon 焦点暖灰（不引 accent）', () => {
  it('--ofr-focus-ring 用 --text-tertiary 1px 环 + 2px 偏移；--ofr-focus-halo 垫 2px 底色', () => {
    const ribbon = blockOf(chromeCss, '.ofr-ribbon')
    expect(ribbon).toContain('--ofr-focus-halo: 0 0 0 2px var(--bg-primary);')
    expect(ribbon).toContain('--ofr-focus-ring: 0 0 0 3px var(--text-tertiary);')
    expect(ribbon).not.toContain('--ofr-focus-ring: 0 0 0 3px color-mix')
    expect(ribbon).not.toMatch(/--ofr-focus-ring:[^;]*var\(--accent\)/)
  })

  it('focus-visible 组合只用 halo+ring（无 accent outline）', () => {
    // 选择器是逗号列表（qat/btn/tab/select/swatch），取含 qat 的那条规则体
    const focusRule = /\.ofr-qat-btn:focus-visible[^{]*\{([^}]*)\}/.exec(chromeCss)?.[1]
    expect(focusRule).toBeDefined()
    expect(focusRule).toContain('box-shadow: var(--ofr-focus-halo), var(--ofr-focus-ring);')
    expect(focusRule).not.toContain('accent')
    expect(chromeCss).not.toContain('color-mix(in srgb, var(--accent) 42%')
  })

  it('accent 只留状态点（保存中/脏点），不用于焦点/选区', () => {
    const accentLines = chromeCss
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('var(--accent)'))
    expect(accentLines.length).toBeGreaterThan(0)
    for (const line of accentLines) {
      expect(line).toMatch(/background: var\(--accent\);|--accent-bg|border.*--accent/)
    }
    expect(accentLines.some((line) => /focus|outline/.test(line))).toBe(false)
  })
})

describe('P3 Office 面：surface.css fallback 收敛 + 字号复核', () => {
  it('token 变量不再带旧十六进制 fallback（token CSS 是入口前置依赖）', () => {
    expect(surfaceCss).not.toMatch(/var\(--doc-canvas-bg,\s*#/)
    expect(surfaceCss).not.toMatch(/var\(--text-primary,\s*#/)
    expect(surfaceCss).not.toMatch(/var\(--border-hairline,\s*#/)
    expect(surfaceCss).not.toMatch(/#fbfaf9|#f5f5f5|#e0e0e0|#1f1f1f/i)
  })

  it('Office chrome 字号落在 12/14 两档（保存态 11 → 12；组标签是 Office 局部 11/14 档）', () => {
    const save = blockOf(chromeCss, '.ofr-save-state')
    expect(save).toContain('font-size: 12px;')
    const tab = blockOf(chromeCss, '.ofr-tab')
    expect(tab).toContain('font-size: 12px;')
    expect(blockOf(chromeCss, '.ofr-ribbon')).toContain('font-size: 12px;')
    // 不应再出现 9.5 / 11 的 chrome 正文档（组标签是唯一 11px 例外，已单测钉住）
    expect(chromeCss).not.toContain('font-size: 9.5px')
  })

  it('首开 loading 文案 12 档、调试条 11 属调试专用（注释登记）', () => {
    expect(blockOf(surfaceCss, '.office-surface-loading')).toContain('font-size: 12px;')
    expect(blockOf(surfaceCss, '.office-surface-status')).toContain('font-size: 11px;')
    expect(surfaceCss).toContain('调试条（S2/S3')
  })
})

describe('P2 字体小规格（task-67 字体统一收口）', () => {
  it('ribbon tab 字重 500（章程 §9.7-1；不再 600 过重）', () => {
    const tab = blockOf(chromeCss, '.ofr-tab')
    expect(tab).toContain('font-weight: 500;')
    expect(tab).not.toContain('font-weight: 600;')
  })

  it('文档名 14（原 12 比 ribbon 其它文字低一档）', () => {
    expect(blockOf(chromeCss, '.ofr-doc-title')).toContain('font-size: 14px;')
  })

  it('AI 面板装饰眉题：正常大小写 + 11/500 三级灰，不再 uppercase/拉字距', () => {
    const panelSource = readSource('../../features/office/OfficeAiPanel.tsx')
    expect(panelSource).not.toContain('uppercase')
    expect(panelSource).not.toContain('tracking-wide')
    expect(panelSource).toContain('text-[11px] font-medium text-ink-tertiary')
  })
})
