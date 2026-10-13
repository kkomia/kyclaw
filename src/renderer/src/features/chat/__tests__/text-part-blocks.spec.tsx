import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextPart } from '../parts/TextPart'
import { splitBlocks } from '../parts/markdown-blocks'

/**
 * 流式分块渲染的**保真度**（round 73）：流式期间按硬边界分块渲染出来的 DOM，必须与
 * "把同一份文本整篇交给 markdown"逐字节相同（text-part-streaming.spec.tsx 钉的是"渲染几次"，
 * 这一份钉的是"渲染出来的东西一样"）。
 *
 * 为什么这条最关键：分块是**性能手段**，不该有任何可见后果。任何一处切错（松散列表、setext 标题、
 * 缩进围栏……）都会让流式期间的排版与最终排版不一致，用户就会在流结束时看到一次重排。
 *
 * 这一组用**真 markdown 引擎**（react-markdown + remark-gfm + 自绘 CodeBlock），只把帧控制成
 * 假 rAF——"上屏"是可确定的，不做时间断言。
 */

/** 一组刻意踩边界的文档：切点规则错在哪一类，就会在哪一行炸出来 */
const DOCS: Record<string, string> = {
  '标题序列（每节的标题都是切点）': [
    '# 顶层标题',
    '',
    '开场白。',
    '',
    '## 第一节',
    '',
    '正文一。',
    '',
    '## 第二节',
    '',
    '- 甲',
    '- 乙',
    ''
  ].join('\n'),
  '松散列表（空行让列表变松 —— 绝不能在这里切）': [
    '前言。',
    '',
    '- 第一项',
    '',
    '- 第二项',
    '',
    '- 第三项',
    ''
  ].join('\n'),
  '列表后紧跟标题（列表必须整段留着）': [
    '- 甲',
    '',
    '- 乙',
    '',
    '## 后面的标题',
    '',
    '尾巴。'
  ].join('\n'),
  'setext 标题（上一行紧挨 ---，不是分割线）': [
    '前言。',
    '',
    '这是 setext 标题',
    '---',
    '',
    '正文。'
  ].join('\n'),
  '分割线（前面有空行，是合法切点）': ['前半段。', '', '---', '', '后半段。'].join('\n'),
  围栏内部长得像标题的行: [
    '说明。',
    '',
    '```md',
    '## 这不该被切开',
    '',
    '---',
    '```',
    '',
    '围栏之后的正文。'
  ].join('\n'),
  '列表项里缩进的围栏（不能当切点）': [
    '清单：',
    '',
    '- 一项',
    '',
    '  ```ts',
    '  const x = 1',
    '  ```',
    '',
    '## 收尾标题',
    ''
  ].join('\n'),
  '段落紧跟表格（表头不能与段落拆开）': [
    '表格前的段落。',
    '| 甲 | 乙 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '## 表格之后',
    '',
    '尾段。'
  ].join('\n'),
  引用块分段: ['> 第一段引用', '', '> 第二段引用', '', '## 引用之后', '', '普通段落。'].join('\n'),
  '没有任何硬边界（应该整篇一块）': ['一段。', '', '又一段。', '', '再来一段。', ''].join('\n')
}

function body(view: { container: HTMLElement }): string {
  return view.container.querySelector('[data-testid="message-text"]')?.innerHTML ?? ''
}

function streamedHtml(doc: string): string {
  const view = render(<TextPart text={doc} streaming />)
  act(() => {
    vi.advanceTimersByTime(20)
  })
  const html = body(view)
  view.unmount()
  return html
}

function wholeHtml(doc: string): string {
  const view = render(<TextPart text={doc} streaming={false} />)
  const html = body(view)
  view.unmount()
  return html
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('分块切点（splitBlocks）', () => {
  it('拼回去与原文逐字节相同', () => {
    const doc = Object.values(DOCS).join('\n')
    const blocks = splitBlocks(doc)
    expect(blocks).not.toBeNull()
    expect(blocks?.join('')).toBe(doc)
  })

  it('在标题 / 围栏 / 分割线处切开', () => {
    const blocks = splitBlocks(DOCS['标题序列（每节的标题都是切点）'] ?? '')
    expect(blocks?.length).toBe(3)
    expect(blocks?.[1]?.startsWith('## 第一节')).toBe(true)
  })

  it('松散列表不是切点（列表整段留在一块里）', () => {
    expect(splitBlocks(DOCS['松散列表（空行让列表变松 —— 绝不能在这里切）'] ?? '')).toBeNull()
  })

  it('列表项里缩进的围栏不是切点（只有后面的标题才是）', () => {
    const blocks = splitBlocks(DOCS['列表项里缩进的围栏（不能当切点）'] ?? '')
    expect(blocks?.length).toBe(2)
    expect(blocks?.[0]).toContain('const x = 1')
    expect(blocks?.[1]?.startsWith('## 收尾标题')).toBe(true)
  })

  it('围栏内部长得像标题的行不是切点（切点在围栏那一行）', () => {
    const blocks = splitBlocks(DOCS['围栏内部长得像标题的行'] ?? '')
    expect(blocks?.length).toBe(2)
    expect(blocks?.[0]).toBe('说明。\n\n')
    expect(blocks?.[1]).toContain('## 这不该被切开')
  })

  it('没有硬边界时返回 null（调用方整篇渲染）', () => {
    expect(splitBlocks(DOCS['没有任何硬边界（应该整篇一块）'] ?? '')).toBeNull()
    expect(splitBlocks('')).toBeNull()
  })

  it('边界只由前缀决定 —— 流往前走时不会把已上屏的块改掉', () => {
    const doc = DOCS['标题序列（每节的标题都是切点）'] ?? ''
    const early = splitBlocks(doc.slice(0, doc.indexOf('## 第二节')))
    const full = splitBlocks(doc)
    // 早期切出来的块，逐字节是最终切法的前缀
    early?.forEach((block, index) => {
      expect(full?.[index]?.startsWith(block)).toBe(true)
    })
  })
})

describe('分块渲染与整篇渲染的结果一致', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(name, () => {
      expect(streamedHtml(doc)).toBe(wholeHtml(doc))
    })
  }
})
