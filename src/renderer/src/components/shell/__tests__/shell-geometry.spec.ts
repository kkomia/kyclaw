import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * task-85：壳级几何统一 + 接缝线调灰的**静态契约**（jsdom 没有布局，几何靠真实量测见
 * `.superpowers/chat-aesthetics/shell-width/widths2.json`；这里钉源头规则不回归）。
 *
 * 统一规则（四个内容页）：
 *   1. 二级列表宽 = --sidebar-width(240)：会话侧栏 / 笔记列表 / 知识库列表同宽；
 *   2. 内容列 = content-column / min(100%, --content-max-width=800) 居中（正文阅读宽 44em 不动）；
 *   3. 页面 gutter = --page-gutter(16)：标题/正文左右同一条线；
 *   4. 接缝线 = --seam-line（60% hairline：暗 0.108 白 / 浅 ≈#e9e8e4），solid、不用 dashed。
 * Office 是文档画布（有意全出血），不套内容列；新增标签页视觉待重做（task-80 临时壳）。
 */
const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8')

const SHELL = 'src/renderer/src/components/shell/'
const NOTES = 'src/renderer/src/features/notes/'
const KNOWLEDGE = 'src/renderer/src/features/knowledge/'

describe('task-85 · 页面外层几何统一（token + 用例）', () => {
  it('semantic.css：内容列 800 / gutter 16 / 侧栏 240 三个几何 token 就位', () => {
    const css = read('src/renderer/src/styles/tokens/semantic.css')
    expect(css).toContain('--content-max-width: 800px;')
    expect(css).toMatch(/--page-gutter:\s*var\(--space-4\);/)
    expect(css).toMatch(/--sidebar-width:\s*240px;/)
  })

  it('笔记/知识库二级列表与会话侧栏同宽（--sidebar-width，不再写死 300）', () => {
    for (const file of [`${NOTES}NotesList.tsx`, `${KNOWLEDGE}KnowledgePage.tsx`]) {
      const source = read(file)
      expect(source, file).toContain('w-(--sidebar-width)')
      expect(source, file).not.toContain('w-[300px]')
    }
    const sidebar = read(`${SHELL}Sidebar.tsx`)
    expect(sidebar).toContain('w-(--sidebar-width)')
  })

  it('笔记/知识库正文区内容列 = 800 + 页面 gutter 16（统一由 page-chrome / notes.css 规格承担）', () => {
    // task-100：笔记空态改统一 EmptyState，内容列几何下沉到共享规格（仍是 800 + 16，不放松）
    const chrome = read('src/renderer/src/components/ui/page-chrome.css')
    expect(chrome).toMatch(/\.ui-empty \{[^}]*max-width: var\(--content-max-width\)/)
    expect(chrome).toMatch(/\.ui-empty \{[^}]*padding: 0 var\(--page-gutter\)/)
    // 笔记稿纸列：notes.css 同一几何；编辑器只挂 np-sheet（不再各写 max-width/px）
    const notesCss = read(`${NOTES}notes.css`)
    expect(notesCss).toMatch(/\.np-sheet \{[^}]*max-width: var\(--content-max-width\)/)
    expect(notesCss).toMatch(/\.np-sheet \{[^}]*padding: 22px var\(--page-gutter\)/)
    expect(read(`${NOTES}NoteEditor.tsx`)).toContain('np-sheet')
    expect(read(`${NOTES}NotesPage.tsx`)).toContain('EmptyState')
    // 知识库详情仍走 content-column + gutter16（详情几何未变）
    const detail = read(`${KNOWLEDGE}KnowledgeDetail.tsx`)
    expect(detail).toContain('content-column')
    expect(detail).toContain('px-(--page-gutter)')
    // 旧的 720/40 口径在笔记（含 CSS）与知识库详情里都不再出现
    for (const file of [
      `${NOTES}NotesPage.tsx`,
      `${NOTES}NoteEditor.tsx`,
      `${NOTES}notes.css`,
      `${KNOWLEDGE}KnowledgeDetail.tsx`
    ]) {
      const source = read(file)
      expect(source, file).not.toContain('max-w-[720px]')
      expect(source, file).not.toContain('px-10')
    }
    // 设置页内容列也走同一 gutter
    const settings = read('src/renderer/src/features/settings/SettingsPage.tsx')
    expect(settings).toContain('content-column')
    expect(settings).toContain('px-(--page-gutter)')
    // 知识库页 band / 提示条同样退到 16（空态几何在共享模板）
    const knowledgePage = read(`${KNOWLEDGE}KnowledgePage.tsx`)
    expect(knowledgePage).toContain('px-(--page-gutter)')
    expect(knowledgePage).not.toContain('px-6')
  })

  it('主对话正文阅读宽保持：content-column + 输入卡 768 + 44em 不变', () => {
    const chat = read('src/renderer/src/features/chat/ChatPage.tsx')
    expect(chat).toContain('content-column')
    const composer = read('src/renderer/src/features/chat/Composer.tsx')
    expect(composer).toContain('max-w-(--chat-input-max-width)')
    const semantic = read('src/renderer/src/styles/tokens/semantic.css')
    expect(semantic).toContain('--chat-input-max-width: 768px;')
    expect(semantic).toContain('--prose-measure: 44em;')
  })
})

describe('task-85 · 接缝线调灰（弱 token + solid，不用 dashed）', () => {
  const SEAMS = [
    { file: `${SHELL}Sidebar.tsx`, what: '左侧会话列表 ↔ 对话区（border-r）' },
    { file: `${SHELL}WorkPanel.tsx`, what: '对话区 ↔ 右侧边栏（border-l）' },
    {
      file: 'src/renderer/src/features/workbench/Workbench.tsx',
      what: '右侧边栏自身连接处（工作台 tab 条 border-b）'
    },
    { file: `${NOTES}NotesList.tsx`, what: '笔记页 列表 ↔ 正文' },
    { file: `${KNOWLEDGE}KnowledgePage.tsx`, what: '知识库页 列表 ↔ 详情' }
  ]

  it('--seam-line 由 60% hairline 派生（暗 0.108 白 / 浅 ≈#e9e8e4），比组件 hairline 弱一档', () => {
    const css = read('src/renderer/src/styles/tokens/semantic.css')
    expect(css).toMatch(
      /--seam-line:\s*color-mix\(in srgb, var\(--border-hairline\) 60%, transparent\);/
    )
  })

  it('五条接缝都改用弱 token：solid、无 dashed、不再直接用 --border-hairline', () => {
    for (const { file, what } of SEAMS) {
      const source = read(file)
      expect(source, `${file}（${what}）`).toContain('border-(--seam-line)')
      expect(source.toLowerCase(), file).not.toContain('dashed')
    }
    // 壳侧三处接缝源文件里不得再出现组件级 hairline（笔记/知识库文件内部的普通分隔仍可用 hairline）
    for (const file of [
      `${SHELL}Sidebar.tsx`,
      `${SHELL}WorkPanel.tsx`,
      'src/renderer/src/features/workbench/Workbench.tsx'
    ]) {
      expect(read(file), file).not.toMatch(/border[^"' ]*-hairline/)
    }
  })

  it('卡片外框 hairline 不动（接缝弱化不波及 content-region/Sidebar 外框常量）', () => {
    const region = read(`${SHELL}ContentRegion.tsx`)
    expect(region).toContain('rounded-overlay')
    const semantic = read('src/renderer/src/styles/tokens/semantic.css')
    expect(semantic).toMatch(/--border-hairline:\s*var\(--k-border-l2\);/)
  })
})
