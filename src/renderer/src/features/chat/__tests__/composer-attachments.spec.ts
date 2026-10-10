import { describe, expect, it } from 'vitest'
import { composeOutgoingText } from '@renderer/features/chat/composer-attachments'
import type { PendingAttachment } from '@renderer/features/chat/composer-attachments'

/**
 * 发送组装（T16 小修批）：正文 → 【引用】行 → 附件块，块间空行分隔。
 * 重点是**围栏加固**：附件原文包在反引号围栏里，围栏长度必须压过内容里最长的一段连续反引号，
 * 否则内容自带的 ``` 会把围栏提前收尾，后半段原文漏成正文（模型读到的就不是"一个文件"了）。
 */
function attachment(text: string, name = 'note.md'): PendingAttachment {
  return { id: `${name}-1`, name, size: text.length, text }
}

/** 反引号围栏（测试里写 n 个反引号不数眼睛） */
function fence(count: number): string {
  return '`'.repeat(count)
}

describe('composeOutgoingText · 段落组装', () => {
  it('只有正文：首尾空白去掉', () => {
    expect(composeOutgoingText({ text: '  看这个  ', references: [], attachments: [] })).toBe(
      '看这个'
    )
  })

  it('引用行：一个【引用】段，多项用「；」分隔', () => {
    const text = composeOutgoingText({
      text: '帮我改一下',
      references: [
        { id: 'r1', kind: '技能', label: '读写文件' },
        { id: 'r2', kind: '插件', label: '回显服务' }
      ],
      attachments: []
    })

    expect(text).toBe('帮我改一下\n\n【引用】技能：读写文件；插件：回显服务')
  })

  it('附件块：内容包在三反引号里，内容末尾的空行不带上', () => {
    const text = composeOutgoingText({
      text: '看这个文件',
      references: [],
      attachments: [attachment('第一行\n第二行\n\n')]
    })

    expect(text).toBe(`看这个文件\n\n【附件】note.md\n${fence(3)}\n第一行\n第二行\n${fence(3)}`)
  })
})

describe('composeOutgoingText · 围栏加固（内容自带反引号）', () => {
  it('内容里出现 ``` → 围栏加长到 4，围栏之间原样保留内容', () => {
    const body = '写法：\n```ts\nconst a = 1\n```\n就这样'
    const text = composeOutgoingText({ text: '', references: [], attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(4)}\n${body}\n${fence(4)}`)
    expect(text).toContain(`\n${fence(4)}\n`)
  })

  it('内容里最长的一段是 4 个反引号 → 围栏 5（严格长于内容里的任意一段）', () => {
    const body = 'a ````b``` c'
    const text = composeOutgoingText({ text: '', references: [], attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(5)}\n${body}\n${fence(5)}`)
  })

  it('只有一个反引号（行内代码）→ 围栏仍是 3，不无谓加长', () => {
    const body = '行内代码 `value` 不动围栏'
    const text = composeOutgoingText({ text: '', references: [], attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(3)}\n${body}\n${fence(3)}`)
  })

  it('两段附件各自按自己的内容取围栏（互不牵连）', () => {
    const text = composeOutgoingText({
      text: '',
      references: [],
      attachments: [attachment('普通内容', 'a.txt'), attachment('含 ``` 的内容', 'b.txt')]
    })

    expect(text).toBe(
      `【附件】a.txt\n${fence(3)}\n普通内容\n${fence(3)}\n\n【附件】b.txt\n${fence(4)}\n含 \`\`\` 的内容\n${fence(4)}`
    )
  })
})
