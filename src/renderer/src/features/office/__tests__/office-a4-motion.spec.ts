import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A4 动效/CSS 契约（不依赖 jsdom 计算样式，直接读源文件钉口径）：
 *   - 保存态换词：150ms + 新词晚 50ms、opacity/translateY(4px)/blur(2px)、reduced-motion 0.01ms；
 *   - 一份 CSS 两处消费：shell `OfficeStatusBar` + 面内 QAT（office/main.tsx + OfficeRibbonView class），
 *     不在办公室（office-chrome.css）里再写第二份换词动画；
 *   - ribbon 折叠：展开 enter 档、收起 exit 档，reduced-motion 面内兜底 0.01ms；
 *   - 纸面：task-76 起暗色主题也用原生白（覆盖 A4 的 invert 灰纸），只钉「无滤镜 + 白底」；
 *   - 状态栏：高度用 `--office-status-height`、不写死像素；OfficePage 作为 workspace 最后一个 flex 子项渲染。
 */
function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const swapCss = read('../../../office/office-save-swap.css')
const chromeCss = read('../../../office/office-chrome.css')
/** 去 CSS 注释：历史说明里会提到旧暗纸 filter，只对生效代码断言 */
const chromeCode = chromeCss.replace(/\/\*[\s\S]*?\*\//g, '')
const officeMainTsx = read('../../../office/main.tsx')
const ribbonViewTsx = read('../../../office/components/OfficeRibbonView.tsx')
const statusBarTsx = read('../OfficeStatusBar.tsx')
const officePageTsx = read('../OfficePage.tsx')

describe('保存态换词动效（共享一份 CSS）', () => {
  it('150ms + 新词晚 50ms + opacity/translateY(4px)/blur(2px)', () => {
    expect(swapCss).toContain('.office-save-swap')
    expect(swapCss).toMatch(/animation:\s*office-save-swap-in\s+150ms/)
    expect(swapCss).toMatch(/\)\s*50ms\s*both/)
    expect(swapCss).toContain('translateY(4px)')
    expect(swapCss).toContain('blur(2px)')
    expect(swapCss).toContain('opacity: 0')
  })

  it('prefers-reduced-motion 压到 0.01ms（不是 0）', () => {
    expect(swapCss).toContain('prefers-reduced-motion: reduce')
    expect(swapCss).toContain('animation-duration: 0.01ms')
    expect(swapCss).not.toMatch(/animation-duration:\s*0ms/)
  })

  it('两处消费、没有第二份实现：shell 状态栏 + 面内 QAT 都 import/用同一份', () => {
    expect(statusBarTsx).toContain("import '../../office/office-save-swap.css'")
    expect(statusBarTsx).toContain('className="office-save-swap"')
    expect(officeMainTsx).toContain("import './office-save-swap.css'")
    expect(ribbonViewTsx).toContain('office-save-swap')
    // A2 的旧换词 keyframes 已删（只保留这一份定义）
    expect(chromeCss).not.toContain('@keyframes ofr-swap')
  })
})

describe('ribbon 折叠动效（A2 收尾）', () => {
  it('展开走 enter 档、收起走 exit 档；切 tab 不改 body 高度', () => {
    expect(chromeCss).toContain('transition: height var(--office-motion-exit)')
    expect(chromeCss).toMatch(/\.ofr-ribbon:not\(\[data-collapsed='true'\]\) \.ofr-body/)
    expect(chromeCss).toMatch(/\.ofr-body\s*\{[^}]*height: var\(--office-ribbon-body-height\)/)
    // 切 tab 只换 .ofr-band 内部组，不动 .ofr-body 高度（没有 data-tab 之类的高度规则）
    expect(chromeCss).not.toMatch(/\[data-tab=['"][^'"]+['"]\]\s+\.ofr-body/)
  })

  it('面内 reduced-motion 兜底存在且是 0.01ms', () => {
    expect(chromeCss).toContain('prefers-reduced-motion: reduce')
    expect(chromeCss).toContain('animation-duration: 0.01ms !important')
    expect(chromeCss).toContain('transition-duration: 0.01ms !important')
  })
})

describe('文档纸面：task-76 覆盖 A4 灰纸，改回原生白', () => {
  it('暗色主题纸面 = 原生白（无 invert/hue-rotate 滤镜；红色/图片不再被反相）', () => {
    // 用户 2026-10-18 新口径：「word 底还是采用 原生的白色把。不然 用户他不知道自己到底是啥颜色啊」
    expect(chromeCss).toContain('.oox-root.dark .canvas-page')
    expect(chromeCss).toContain('background-color: #ffffff')
    // A4 的暗纸滤镜必须被删掉（否则文档颜色不是 Word 里的真实颜色）
    expect(chromeCode).not.toMatch(/filter:\s*invert\(0\.78\)/)
    expect(chromeCode).not.toMatch(/filter:\s*invert\(1\)/)
    expect(chromeCss).toContain('覆盖 A4')
    // 画布/周边仍暗：--doc-canvas-bg 映射不动（surface.css 仍把 .oox-root 的 --doc-bg 接到画布 token）
    expect(chromeCss).toContain('--doc-canvas-bg 不动')
  })

  it('窄窗 720：不做会裁纸的 minWidth CSS 覆盖（内核 min-layout，A5 走上游 fit-width）', () => {
    // A4 实测：覆盖 min-width 只缩盒子、不改页面 canvas 的绝对定位，纸面右侧会被裁且无法滚动；
    // 结论是保留内核画布横滚、页面级不溢出，所以这里钉「不覆盖」。
    expect(chromeCss).not.toContain(".docx-editor__scroll-container > div[style*='min-width']")
    expect(chromeCss).not.toContain('min-width: 0 !important')
    expect(chromeCss).toContain('720 的验收口径')
  })
})

describe('状态栏布局契约', () => {
  it('高度消费 --office-status-height，不写死 26px（token 归 A2/P0）', () => {
    expect(statusBarTsx).toContain('h-(--office-status-height)')
    expect(statusBarTsx).not.toContain('26px')
    expect(officePageTsx).toContain('<OfficeStatusBar')
  })

  it('OfficePage 在 workspace 末尾渲染状态栏，数据来自壳真值', () => {
    expect(officePageTsx).toContain('documentName={loaded?.info.displayName ?? tab.title}')
    expect(officePageTsx).toContain('pageCount={pageCount}')
    expect(officePageTsx).toContain('dirty={tab.dirty}')
    expect(officePageTsx).toContain('saving={saving}')
    expect(officePageTsx).toContain('readOnly={tab.readOnly}')
  })

  it('testid 契约：office-statusbar / pages / save / readonly', () => {
    expect(statusBarTsx).toContain('data-testid="office-statusbar"')
    expect(statusBarTsx).toContain('data-testid="office-status-pages"')
    expect(statusBarTsx).toContain('data-testid="office-status-save"')
    expect(statusBarTsx).toContain('data-testid="office-status-readonly"')
  })
})
