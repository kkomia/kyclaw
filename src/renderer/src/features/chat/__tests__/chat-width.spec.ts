import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * task-114 · 对话 chat 宽度（照抄 DSH 公式，2026-10-18）契约：
 *
 *   --chat-content-width = clamp(680px, 64cqi, 920px)   ← cqi = 内容区卡宽（ContentRegion）
 *   输入卡 = 内容宽 + 32，夹 712 / 952
 *   用户气泡 = min(内容宽 × .702, 82%)
 *   消息列 = 内容宽 + 72（抵消列内 pr-14 + pl-4 的横向内边距）
 *   正文不再套 44em；表格/代码块等宽元素不动
 *
 * 只作用于 chat 页；notes/knowledge/office 仍走 .content-column（800）+ --prose-measure 44em。
 * 这里只钉源码/常量契约；真机宽度数字在 `.superpowers/chat-aesthetics/chat-width/` 的证据里。
 */
const ROOT = join(__dirname, '../../..') // src/renderer/src
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

describe('task-114 · chat 宽度公式（DSH）', () => {
  it('chat 专用 CSS：内容宽 clamp(680px, 64cqi, 920px)；输入卡 = 内容宽 + 32（夹 712/952）', () => {
    const css = read('features/chat/chat-width.css')
    expect(css).toContain('--chat-content-width: clamp(680px, 64cqi, 920px);')
    expect(css).toContain(
      '--chat-input-max-width: clamp(712px, calc(var(--chat-content-width) + 32px), 952px);'
    )
  })

  it('容器查询基准 = 内容区卡（ContentRegion: container-type: inline-size）', () => {
    const region = read('components/shell/ContentRegion.tsx')
    expect(region).toContain('[container-type:inline-size]')
  })

  it('消息列：chat-column 里、内容包裹层 max-width = 内容宽 + 32 并居中（左右各 16 内边距）', () => {
    const chat = read('features/chat/ChatPage.tsx')
    expect(chat).toContain('className="chat-column flex min-h-0 flex-1 flex-col"')
    expect(chat).toContain("'./chat-width.css'")
    const list = read('features/chat/MessageList.tsx')
    expect(list).toContain(
      'chat-content mx-auto flex w-full max-w-[calc(var(--chat-content-width)+32px)]'
    )
    expect(list).toContain('px-4')
    expect(list).toContain('mx-auto')
  })

  it('右侧走廊原意保留：窄窗（<1080）chat-content 给回 56px 右内边距，宽窗对称居中不占走廊', () => {
    const css = read('features/chat/chat-width.css')
    expect(css).toMatch(
      /@media \(max-width: 1080px\) \{\s*\.chat-content \{\s*padding-right: 56px;/
    )
  })

  it('用户气泡：max-width = min(内容宽×.702, 82%)', () => {
    const message = read('features/chat/Message.tsx')
    expect(message).toContain('max-w-[min(calc(var(--chat-content-width)*0.702),82%)]')
    // 右缘对齐前提：气泡仍在 items-end 的 user 栈里，AI 正文不设独立 max-width
    expect(message).toContain('flex flex-col items-end gap-1.5')
  })

  it('AI 正文铺满内容列：chat 页覆盖 markdown 叙事块 44em 限制；表格等宽元素规则不动', () => {
    const css = read('features/chat/chat-width.css')
    expect(css).toContain(
      "[data-testid='chat-page'] .markdown-body > :is(p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote)"
    )
    expect(css).toContain('max-width: var(--chat-content-width);')
    // 全局 markdown 规则保留（notes/知识库/设置等仍 44em）
    const markdown = read('styles/markdown.css')
    expect(markdown).toContain('max-width: var(--prose-measure);')
  })

  it('composer 仍吃 --chat-input-max-width（宽度来自 chat 页变量，不改内部）', () => {
    const composer = read('features/chat/Composer.tsx')
    expect(composer).toContain('max-w-(--chat-input-max-width)')
  })

  it('非 chat 页面不回退：content-column + 800 + 44em 仍保留', () => {
    const semantic = read('styles/tokens/semantic.css')
    expect(semantic).toContain('--content-max-width: 800px;')
    expect(semantic).toContain('--prose-measure: 44em;')
    // chat 输入卡兜底（不在 chat 页时）= 680 + 32 = 712
    expect(semantic).toContain(
      '--chat-input-max-width: clamp(712px, calc(var(--chat-content-width, 680px) + 32px), 952px);'
    )
  })
})
