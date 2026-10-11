import { describe, expect, it } from 'vitest'
import {
  insertReferenceMarker,
  parseReferenceMarkers
} from '@renderer/features/chat/reference-markers'

/**
 * 引用标记（round 14）：`【引用】<kind>：<label>` 的解析与光标处插入。
 * 单条 / 多条 / 旧「；」合并格式 / 非标记文本 / 标记被删到一半的边界。
 */
describe('parseReferenceMarkers · 解析', () => {
  it('单条标记：前文 + 引用段 + 后文（label 以空白为界，光标后继续打的字不被吞）', () => {
    expect(parseReferenceMarkers('看看【引用】技能：整理笔记 这个')).toEqual([
      { kind: 'text', text: '看看' },
      { kind: 'reference', refs: [{ kind: '技能', label: '整理笔记' }] },
      { kind: 'text', text: ' 这个' }
    ])
  })

  it('多条标记：逐段拆出；一行里两个标记互不粘', () => {
    expect(parseReferenceMarkers('用【引用】技能：A 整理【引用】上下文：工作区 B')).toEqual([
      { kind: 'text', text: '用' },
      { kind: 'reference', refs: [{ kind: '技能', label: 'A' }] },
      { kind: 'text', text: ' 整理' },
      { kind: 'reference', refs: [{ kind: '上下文', label: '工作区' }] },
      { kind: 'text', text: ' B' }
    ])
  })

  it('旧「；」合并格式（round 7-13 的发送形态）：一段里拆成多条 refs', () => {
    expect(parseReferenceMarkers('【引用】技能：读写文件；插件：回显服务；上下文：默认')).toEqual([
      {
        kind: 'reference',
        refs: [
          { kind: '技能', label: '读写文件' },
          { kind: '插件', label: '回显服务' },
          { kind: '上下文', label: '默认' }
        ]
      }
    ])
  })

  it('非标记文本：整体一段纯文本（含单独的【引用】两个字也不算）', () => {
    expect(parseReferenceMarkers('普通的一句话')).toEqual([{ kind: 'text', text: '普通的一句话' }])
    expect(parseReferenceMarkers('【引用】后面没跟种类')).toEqual([
      { kind: 'text', text: '【引用】后面没跟种类' }
    ])
    expect(parseReferenceMarkers('【引用】别的：x')).toEqual([
      { kind: 'text', text: '【引用】别的：x' }
    ])
  })

  it('标记被删到一半（label 空 / 只剩前缀）：回落成普通文本，不半渲染', () => {
    expect(parseReferenceMarkers('【引用】技能：')).toEqual([
      { kind: 'text', text: '【引用】技能：' }
    ])
    expect(parseReferenceMarkers('abc【引用】')).toEqual([{ kind: 'text', text: 'abc【引用】' }])
    // 删掉条目但留下「；」：前一条仍是合法标记（照常出 pill），多余的「；」按文本留着
    expect(parseReferenceMarkers('【引用】技能：A；')).toEqual([
      { kind: 'reference', refs: [{ kind: '技能', label: 'A' }] },
      { kind: 'text', text: '；' }
    ])
  })
})

describe('insertReferenceMarker · 光标处插入', () => {
  it('插在中段：标记 + 尾随空格，光标落在标记后面；前后文原样', () => {
    const result = insertReferenceMarker('先写一句 收尾', 4, '技能', '整理笔记')
    expect(result.text).toBe('先写一句【引用】技能：整理笔记  收尾')
    expect(result.caret).toBe('先写一句【引用】技能：整理笔记 '.length)
  })

  it('空输入框：光标 0 处插入', () => {
    expect(insertReferenceMarker('', 0, '上下文', '工作区')).toEqual({
      text: '【引用】上下文：工作区 ',
      caret: '【引用】上下文：工作区 '.length
    })
  })

  it('光标越界：夹回 [0, 长度]（不会抛，也不会丢字）', () => {
    expect(insertReferenceMarker('abc', 99, '插件', 'p').text).toBe('abc【引用】插件：p ')
    expect(insertReferenceMarker('abc', -3, '插件', 'p').text).toBe('【引用】插件：p abc')
  })
})
