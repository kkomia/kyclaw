import { describe, expect, it } from 'vitest'
import { approvalDiff, diffLines, MAX_DIFF_LINES, type DiffLine } from '../approval-diff'

/** 行级 diff（T13 审批卡）：公共前后缀 + 中间 LCS；超限折叠、超大块退化 */
function render(lines: DiffLine[]): string[] {
  const marker: Record<DiffLine['kind'], string> = { add: '+', remove: '-', context: ' ', gap: '…' }
  return lines.map((line) => `${marker[line.kind]}${line.text}`)
}

describe('diffLines', () => {
  it('两边一样：全是上下文行', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc')
    expect(render(lines)).toEqual([' a', ' b', ' c'])
  })

  it('空内容 = 零行；新建文件就是清一色新增', () => {
    expect(diffLines('', '')).toEqual([])
    expect(render(diffLines('', 'hello\nworld'))).toEqual(['+hello', '+world'])
  })

  it('改一行：命中上下文、删除、新增（公共前后缀不重复展开）', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc')
    expect(render(lines)).toEqual([' a', '-b', '+B', ' c'])
    expect(lines.map((line) => line.kind)).toEqual(['context', 'remove', 'add', 'context'])
  })

  it('纯插入 / 纯删除', () => {
    expect(render(diffLines('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c'])
    expect(render(diffLines('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c'])
  })

  it('空行与空白是真实的行内容，不吞不并', () => {
    expect(render(diffLines('a\n\nb', 'a\n \nb'))).toEqual([' a', '-', '+ ', ' b'])
  })

  it('同一段文本里的 LCS：保留公共行，只标注真正变化的两行', () => {
    const lines = diffLines('x\na\ny\nb\nz', 'x\nA\ny\nB\nz')
    expect(render(lines)).toEqual([' x', '-a', '+A', ' y', '-b', '+B', ' z'])
  })

  it('超过渲染上限：头尾各留一半，中间折叠一条 gap', () => {
    const before = Array.from({ length: 1000 }, (_, index) => `line-${index}`)
    const after = before.map((line, index) => (index === 500 ? 'changed' : line))

    const lines = diffLines(before.join('\n'), after.join('\n'))

    expect(lines).toHaveLength(MAX_DIFF_LINES + 1)
    const gapIndex = lines.findIndex((line) => line.kind === 'gap')
    expect(gapIndex).toBeGreaterThan(0)
    expect(lines[gapIndex].text).toMatch(/^中间省略 \d+ 行$/)
    expect(lines.slice(0, gapIndex).every((line) => line.kind !== 'gap')).toBe(true)
  })
})

describe('approvalDiff：从工具入参取素材', () => {
  it('edit：oldText → newText', () => {
    const lines = approvalDiff('edit', { path: 'a.txt', oldText: '旧', newText: '新' })
    expect(render(lines ?? [])).toEqual(['-旧', '+新'])
  })

  it('write：content 全部算新增', () => {
    const lines = approvalDiff('write', { path: 'a.txt', content: '第一行\n第二行' })
    expect(render(lines ?? [])).toEqual(['+第一行', '+第二行'])
  })

  it('MCP 名字按最后一段识别（mcp__fs__write 当 write）', () => {
    expect(approvalDiff('mcp__fs__write', { path: 'a.txt', content: 'x' })).toEqual([
      { kind: 'add', text: 'x' }
    ])
  })

  it('认不出的工具 / 入参形状不对：回 null（卡片退回静态呈现）', () => {
    expect(approvalDiff('mcp__x__do', { anything: 1 })).toBeNull()
    expect(approvalDiff('write', { path: 'a.txt' })).toBeNull()
    expect(approvalDiff('edit', { path: 'a.txt', oldText: 1, newText: 'x' })).toBeNull()
    expect(approvalDiff('write', null)).toBeNull()
  })
})
