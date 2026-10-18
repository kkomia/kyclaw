import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  SurfaceLoading,
  loadingCopyOf,
  loadingStageOf,
  type LoadingStageInput
} from '../SurfaceLoading'

/**
 * PB-019：加载态骨架 + 阶段读数。
 * 纯函数（阶段推导/文案）直接断言；组件只断契约（testid/stage/data-*），几何交给真机截图。
 */
function input(overrides: Partial<LoadingStageInput> = {}): LoadingStageInput {
  return {
    kind: null,
    doc: false,
    fontsState: 'idle',
    pptxFontsState: 'idle',
    editorState: 'idle',
    ...overrides
  }
}

describe('PB-019 loadingStageOf：四阶段只按事件前进', () => {
  it('没收到文档 → 阶段 1（准备）', () => {
    expect(loadingStageOf(input())).toBe(1)
    expect(loadingStageOf(input({ kind: 'docx' }))).toBe(1)
  })

  it('docx：doc 到达但字体还没开始 → 2；字体 loading/ready 且编辑器未就绪 → 3；doc:loaded → 4', () => {
    expect(loadingStageOf(input({ kind: 'docx', doc: true }))).toBe(2)
    expect(loadingStageOf(input({ kind: 'docx', doc: true, fontsState: 'loading' }))).toBe(3)
    expect(
      loadingStageOf(input({ kind: 'docx', doc: true, fontsState: 'ready', editorState: 'loading' }))
    ).toBe(3)
    expect(
      loadingStageOf(input({ kind: 'docx', doc: true, fontsState: 'ready', editorState: 'ready' }))
    ).toBe(4)
  })

  it('pptx：等 6 面字体（pptxFontsState），不等 docx 的 fontsState', () => {
    expect(loadingStageOf(input({ kind: 'pptx', doc: true }))).toBe(2)
    expect(
      loadingStageOf(
        input({ kind: 'pptx', doc: true, pptxFontsState: 'loading', fontsState: 'ready' })
      )
    ).toBe(3)
    expect(
      loadingStageOf(
        input({ kind: 'pptx', doc: true, pptxFontsState: 'ready', editorState: 'loading' })
      )
    ).toBe(3)
    expect(
      loadingStageOf(input({ kind: 'pptx', doc: true, pptxFontsState: 'ready', editorState: 'ready' }))
    ).toBe(4)
  })

  it('xlsx：没有字体阶段，doc 到达 → 2，引擎 loading → 3，doc:loaded → 4', () => {
    expect(loadingStageOf(input({ kind: 'xlsx', doc: true }))).toBe(2)
    expect(loadingStageOf(input({ kind: 'xlsx', doc: true, editorState: 'loading' }))).toBe(3)
    expect(loadingStageOf(input({ kind: 'xlsx', doc: true, editorState: 'ready' }))).toBe(4)
  })
})

describe('PB-019 loadingCopyOf：文案只说事实（不再复用 docx 的 pptx 错句）', () => {
  it('四阶段主文案', () => {
    expect(loadingCopyOf('docx', 1, 0).label).toBe('正在打开文档')
    expect(loadingCopyOf('docx', 2, 10_240).label).toBe('正在读取内容')
    expect(loadingCopyOf('docx', 4, 10_240).label).toBe('即将显示')
  })

  it('docx 字体：46 个字面 · 本地读取', () => {
    const copy = loadingCopyOf('docx', 3, 10_240)
    expect(copy.label).toBe('正在准备中文字体')
    expect(copy.meta).toContain('46 个字面')
  })

  it('pptx 字体：演示文稿字体 · 6 面（修正旧错句）', () => {
    const copy = loadingCopyOf('pptx', 3, 10_240)
    expect(copy.label).toContain('演示文稿字体')
    expect(copy.label).toContain('6 面')
    expect(copy.label).not.toContain('注册本地字体')
  })

  it('xlsx：表格引擎，不是字体', () => {
    const copy = loadingCopyOf('xlsx', 3, 10_240)
    expect(copy.label).toBe('正在准备表格引擎')
    expect(copy.meta).toContain('表格运行时')
  })
})

describe('PB-019 SurfaceLoading 契约', () => {
  it('保留原 testid + 新增 data-surface-loading-stage；骨架 ribbon/纸/阶段行/meter 齐全', () => {
    const { container } = render(
      <SurfaceLoading kind="docx" stage={3} docBytes={10_240} testId="surface-fonts-loading" />
    )
    const root = screen.getByTestId('surface-fonts-loading')
    expect(root).toHaveClass('office-surface-loading')
    expect(root).toHaveAttribute('data-surface-loading-stage', '3')
    expect(container.querySelector('.osl-ribbon')).not.toBeNull()
    expect(container.querySelectorAll('.osl-tabs i')).toHaveLength(3)
    expect(container.querySelectorAll('.osl-group')).toHaveLength(5)
    expect(container.querySelectorAll('.osl-line')).toHaveLength(5)
    expect(container.querySelectorAll('.osl-dots i')).toHaveLength(3)
    expect(container.querySelectorAll('.osl-meter i')).toHaveLength(4)
    // 阶段 3：前两段完成（done）、当前段扫光、最后一段未到
    const segs = Array.from(container.querySelectorAll('.osl-meter i')).map((el) =>
      el.getAttribute('data-state')
    )
    expect(segs).toEqual(['done', 'done', 'current', 'todo'])
  })

  it('leaving → data-leaving=true（150ms 淡出由 CSS transition 承担）', () => {
    render(<SurfaceLoading kind="docx" stage={4} docBytes={1} testId="t" leaving />)
    expect(screen.getByTestId('t')).toHaveAttribute('data-leaving', 'true')
  })

  it('reduced 静态兜底：CSS 里脉冲/粒子/扫光都被 [data-motion=reduced] 关掉', () => {
    // jsdom 环境的 import.meta.url 不是 file:，按仓库根取相对路径（vitest cwd = 仓库根）
    const css = readFileSync('src/renderer/src/office/surface-loading.css', 'utf8')
    expect(css).toContain("[data-motion='reduced']")
    expect(css).toContain('animation: none !important')
    expect(css).toContain('--motion-reduced')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
