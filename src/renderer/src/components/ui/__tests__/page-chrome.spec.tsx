import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DetailTitle, EmptyState, PageMeta, PageTitle, SectionTitle } from '../page-chrome'

/**
 * task-100 · 设计一致性 P1 的跨页契约（≥3 条）：
 *   ① 页面 h1 一档：所有有页面标题的页用同一个 PageTitle（衬线 22/30 × --ui-scale）；
 *   ② 空态一档：EmptyState 四件套结构统一（可选眉题/标题/说明/标签/动作）；
 *   ③ 选中态一档：内容列表统一 .ui-list-row（实底 + 2px accent 暖线）；
 *   ④ 字号/动效 token 一档：页面 CSS 不再出现 0.5px 私有字号与裸 ms 交互时长；
 *   ⑤ 重复表达收敛：newtab 页脚/Office 状态栏的第三次名称只保留 sr-only。
 */
const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8')

describe('task-100 · 页面 chrome 统一档', () => {
  it('① PageTitle/DetailTitle/SectionTitle/PageMeta 渲染统一 class 与语义层级', () => {
    render(
      <div>
        <PageTitle>设置</PageTitle>
        <PageMeta>共 3 份</PageMeta>
        <DetailTitle>详情</DetailTitle>
        <SectionTitle>开始</SectionTitle>
      </div>
    )
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toHaveClass('ui-page-title')
    expect(screen.getByText('共 3 份')).toHaveClass('ui-page-meta')
    expect(screen.getByRole('heading', { level: 2, name: '详情' })).toHaveClass('ui-detail-title')
    expect(screen.getByRole('heading', { level: 2, name: '开始' })).toHaveClass('ui-section-title')

    const css = read('src/renderer/src/components/ui/page-chrome.css')
    expect(css).toMatch(/\.ui-page-title \{[^}]*font-size: calc\(22px \* var\(--ui-scale, 1\)\)/)
    expect(css).toMatch(/\.ui-page-title \{[^}]*line-height: calc\(30px \* var\(--ui-scale, 1\)\)/)
    expect(css).toMatch(/\.ui-empty-title \{[^}]*font-size: calc\(22px \* var\(--ui-scale, 1\)\)/)
    expect(css).toMatch(/\.ui-detail-title \{[^}]*font-size: calc\(24px \* var\(--ui-scale, 1\)\)/)
  })

  it('② 空态模板：可选眉题 + 衬线标题 + 一句说明 + ≤6 标签 + 一个主按钮', () => {
    render(
      <EmptyState
        data-testid="empty-demo"
        eyebrow="资料索引"
        title="把资料收进一个地方"
        description="支持 Markdown、纯文本等文本文件。"
        tags={['Markdown', 'TXT', 'JSON']}
        tagsTestId="empty-demo-tags"
        action={<button type="button">导入资料</button>}
      />
    )
    const empty = screen.getByTestId('empty-demo')
    expect(empty).toHaveClass('ui-empty')
    expect(empty.querySelector('.ui-empty-eyebrow')).toHaveTextContent('资料索引')
    expect(screen.getByRole('heading', { level: 2 })).toHaveClass('ui-empty-title')
    expect(empty.querySelector('.ui-empty-desc')).toHaveTextContent('支持 Markdown')
    expect(screen.getByTestId('empty-demo-tags').querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '导入资料' })).toBeInTheDocument()
  })
})

describe('task-100 · 跨页源码契约', () => {
  it('③ 页面 h1：笔记/知识库/设置/Office 都走同一个 PageTitle（Office sr-only 登记无可见标题）', () => {
    for (const file of [
      'src/renderer/src/features/notes/NotesPage.tsx',
      'src/renderer/src/features/knowledge/KnowledgePage.tsx',
      'src/renderer/src/features/settings/SettingsPage.tsx',
      'src/renderer/src/features/office/OfficePage.tsx'
    ]) {
      const source = read(file)
      expect(source).toContain('PageTitle')
      expect(source).toContain('@renderer/components/ui/page-chrome')
    }
    // 新标签页不设页面 h1（C 设计用 section 标题）——登记为唯一 section 例外
    expect(read('src/renderer/src/features/newtab/NewTabView.tsx')).toContain('SectionTitle')
  })

  it('④ 空态：笔记/知识库/Office 都复用同一 EmptyState 模板', () => {
    for (const file of [
      'src/renderer/src/features/notes/NotesPage.tsx',
      'src/renderer/src/features/knowledge/KnowledgePage.tsx',
      'src/renderer/src/features/office/OfficePage.tsx'
    ]) {
      expect(read(file)).toContain('EmptyState')
    }
    const source = read('src/renderer/src/components/ui/page-chrome.tsx')
    expect(source).toContain('ui-empty-title')
    expect(source).toContain('ui-empty-desc')
    expect(source).toContain('ui-empty-tags')
  })

  it('⑤ 内容列表选中：笔记/知识库同一 .ui-list-row（实底 + 2px accent 暖线）', () => {
    for (const file of [
      'src/renderer/src/features/notes/NotesList.tsx',
      'src/renderer/src/features/knowledge/KnowledgeList.tsx'
    ]) {
      expect(read(file)).toContain('ui-list-row')
    }
    const css = read('src/renderer/src/components/ui/page-chrome.css')
    expect(css).toMatch(
      /\.ui-list-row\[data-selected='true'\] \{[^}]*background: var\(--fill-selected\)/
    )
    expect(css).toMatch(
      /\.ui-list-row\[data-selected='true'\]::before \{[^}]*background: var\(--accent\)/
    )
  })

  it('⑥ 字号/动效一档：owned 页面 CSS 无 0.5px 私有字号、交互时长无裸 ms', () => {
    for (const file of [
      'src/renderer/src/features/notes/notes.css',
      'src/renderer/src/features/newtab/newtab.css'
    ]) {
      const css = read(file)
      expect(css).not.toMatch(/font-size:\s*\d+\.5px/)
      expect(css).not.toMatch(/transition:[^;]*\b\d+ms\b/)
      expect(css).not.toMatch(/font-size:\s*\d+px[^;]*;/)
    }
    // 交互/入场时长都读角色 token（feedback/open/enter）
    const newtab = read('src/renderer/src/features/newtab/newtab.css')
    expect(newtab).toContain('var(--motion-feedback)')
    expect(newtab).toContain('var(--motion-enter)')
  })

  it('⑧ 新标签页 section 标题随 --ui-scale（不再 clamp 31）且 Office 状态栏文档名不落文本', () => {
    const newtabCss = read('src/renderer/src/features/newtab/newtab.css')
    expect(newtabCss).not.toContain('clamp(24px, 2.4vw, 31px)')
    expect(newtabCss).not.toContain('clamp(22px, 2.2vw, 29px)')
    for (const selector of ['\\.lt-sec-title', '\\.lt-rail-title']) {
      const block = newtabCss.match(new RegExp(selector + ' \\{[^}]*\\}'))?.[0] ?? ''
      expect(block).not.toContain('font-size')
      expect(block).not.toContain('font-weight')
    }
    expect(read('src/renderer/src/features/newtab/NewTabView.tsx')).toContain('SectionTitle')
    const status = read('src/renderer/src/features/office/OfficeStatusBar.tsx')
    expect(status).toContain('aria-label={documentName}')
    expect(status).not.toMatch(
      /office-status-doc-title[\s\S]{0,200}className="sr-only"[^>]*>\s*\{documentName\}/
    )
  })

  it('⑦ 重复表达收敛：newtab 页脚 / Office 状态栏的名称只留 sr-only（一屏可见 ≤2 处）', () => {
    const newtab = read('src/renderer/src/features/newtab/NewTabView.tsx')
    expect(newtab).toContain('aria-label="关闭新标签页"')
    expect(newtab).toContain('<span className="sr-only">关闭新标签页</span>')
    expect(newtab).toContain(`{showFuture ? '收起未来位' : '显示未来位'}`)
    const status = read('src/renderer/src/features/office/OfficeStatusBar.tsx')
    expect(status).toContain('className="sr-only"')
    // 设置页功能解释小字删掉，关闭窗口说明收敛为一行
    const settings = read('src/renderer/src/features/settings/SettingsPage.tsx')
    expect(settings).not.toContain('font-size-hint')
    expect(settings).not.toContain('动画会给设备带来渲染压力')
  })
})
