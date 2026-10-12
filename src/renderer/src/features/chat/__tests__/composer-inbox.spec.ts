import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  CONTEXT_UNSUPPORTED,
  linesOfSelection,
  publishContextItem,
  resolveContextItem,
  subscribeContextItems,
  truncateToBytes,
  utf8ByteLength
} from '@renderer/features/chat/composer-inbox'
import type {
  ContextChannel,
  ContextItem,
  ContextItemResult
} from '@renderer/features/chat/composer-inbox'
import { NO_VISION_MESSAGE } from '@renderer/features/chat/composer-attachments'
import type { PdfExtractor } from '@renderer/features/chat/composer-attachments'
import { ATTACHMENT_MAX_BYTES, IMAGE_MAX_BYTES } from '@shared/attachments'
import type { FileBytesResult } from '@shared/workbench'

/**
 * round 42 的注入通道：两条形状的发布/订阅/退订，以及"把请求解析成附件"的那套判档
 * （文本 / 图片 / PDF / 各种拒收），全部用桩通道打，不碰真 IPC。
 */
const FILE_ITEM: ContextItem = {
  source: 'file',
  threadId: 't1',
  relative: 'src/notes.txt',
  name: 'notes.txt'
}

/** 桩通道（两个方法都包成 spy，用来断言"该拉哪条通道"） */
type ChannelStub = {
  readFile: Mock<ContextChannel['readFile']>
  readBytes: Mock<ContextChannel['readBytes']>
}

const readFileDefault: ContextChannel['readFile'] = async () => ({
  kind: 'text',
  text: '一行内容',
  size: 12,
  truncated: false
})
const readBytesDefault: ContextChannel['readBytes'] = async () =>
  ({ kind: 'unsupported', size: 0 }) satisfies FileBytesResult

function channel(over: Partial<ContextChannel> = {}): ChannelStub {
  return {
    readFile: vi.fn(over.readFile ?? readFileDefault),
    readBytes: vi.fn(over.readBytes ?? readBytesDefault)
  }
}

function resolve(
  item: ContextItem,
  over: { channel?: ContextChannel | null; vision?: boolean; extractPdf?: PdfExtractor } = {}
): Promise<ContextItemResult> {
  return resolveContextItem(item, {
    channel: channel(),
    vision: true,
    extractPdf: async () => ({ ok: false, message: '抽不出文字' }),
    id: 'a1',
    ...over
  })
}

describe('context inbox · 发布 / 订阅', () => {
  it('订阅者按发布顺序收到事件；退订后不再收到', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = subscribeContextItems(first)
    const offSecond = subscribeContextItems(second)

    publishContextItem(FILE_ITEM)
    expect(first).toHaveBeenCalledWith(FILE_ITEM)
    expect(second).toHaveBeenCalledWith(FILE_ITEM)

    offFirst()
    publishContextItem(FILE_ITEM)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)

    offSecond()
  })

  it('两种形状都照原样派发（摘选带文字）', () => {
    const listener = vi.fn()
    const off = subscribeContextItems(listener)

    const selection: ContextItem = {
      source: 'selection',
      threadId: 't1',
      relative: 'a.md',
      name: 'a.md 摘选',
      text: '选中的一段'
    }
    publishContextItem(selection)

    expect(listener).toHaveBeenCalledWith(selection)
    off()
  })

  it('没人在听时发布是空动作（非 chat 路由不该炸）', () => {
    expect(() => publishContextItem(FILE_ITEM)).not.toThrow()
  })

  it('退订是幂等的（重复调用不报错，也不影响别的订阅者）', () => {
    const listener = vi.fn()
    const off = subscribeContextItems(listener)
    off()
    expect(() => off()).not.toThrow()

    publishContextItem(FILE_ITEM)
    expect(listener).not.toHaveBeenCalled()
  })

  it('订阅者中途退订不会漏掉本次派发（派发前先拷一份）', () => {
    const order: string[] = []
    const offInner = subscribeContextItems(() => order.push('inner'))
    subscribeContextItems(() => {
      order.push('outer')
      offInner()
    })

    publishContextItem(FILE_ITEM)
    // 外层订阅者在派发中退订了内层：本次仍在名单里，所以两个都收到
    expect(order).toEqual(['inner', 'outer'])

    order.length = 0
    publishContextItem(FILE_ITEM)
    expect(order).toEqual(['outer'])
  })
})

describe('round 42 · 解析：摘选', () => {
  const item: ContextItem = {
    source: 'selection',
    threadId: 't1',
    relative: 'src/app.ts',
    name: 'app.ts 摘选',
    text: '  const a = 1  '
  }

  it('摘选不读文件：文字直接成附件（名 / 路径 / 引用标记 / 大小如实）', async () => {
    const channelStub = channel()
    const result = await resolve(item, { channel: channelStub })

    expect(result).toEqual({
      attachment: {
        id: 'a1',
        name: 'app.ts 摘选',
        size: utf8ByteLength('  const a = 1  '),
        text: '  const a = 1  ',
        relative: 'src/app.ts',
        quote: true,
        lines: undefined
      },
      note: undefined
    })
    expect(channelStub.readFile).not.toHaveBeenCalled()
    expect(channelStub.readBytes).not.toHaveBeenCalled()
  })

  it('带行号的摘选：位置原样进附件（发布方算、订阅方不瞎编）', async () => {
    const result = await resolve({ ...item, lines: { start: 3, end: 8 } })

    if (!('attachment' in result)) throw new Error('应当收下')
    expect(result.attachment.lines).toEqual({ start: 3, end: 8 })
  })

  it('超上限按字节截断（中文三字节/字也不越界），并给一句人话', async () => {
    const text = '中'.repeat(20 * 1024)
    const result = await resolve({ ...item, text })

    if (!('attachment' in result)) throw new Error('应当收下')
    const kept = result.attachment.text ?? ''
    expect(utf8ByteLength(kept)).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES)
    expect(kept.length).toBeGreaterThan(0)
    expect(result.attachment.size).toBe(utf8ByteLength(kept))
    expect(result.note).toContain('已截断')
  })

  it('空白选区（只有空格）不收，给人话', async () => {
    const result = await resolve({ ...item, text: '   \n ' })
    expect(result).toEqual({ problem: '没有选中文字' })
  })
})

describe('round 42 · 解析：文本文件', () => {
  it('≤16KB 读成文本附件（走文本通道，不碰字节通道；带相对路径）', async () => {
    const channelStub = channel({
      readFile: async () => ({
        kind: 'text',
        text: 'export const a = 1\n',
        size: 19,
        truncated: false
      })
    })
    const result = await resolve(FILE_ITEM, { channel: channelStub })

    expect(result).toEqual({
      attachment: {
        id: 'a1',
        name: 'notes.txt',
        size: 19,
        text: 'export const a = 1\n',
        relative: 'src/notes.txt'
      }
    })
    expect(channelStub.readFile).toHaveBeenCalledWith('t1', 'src/notes.txt')
    expect(channelStub.readBytes).not.toHaveBeenCalled()
  })

  it('超过 16KB 不再拒收：退回路径引用（round 53），内容不进消息', async () => {
    const result = await resolve(FILE_ITEM, {
      channel: channel({
        readFile: async () => ({
          kind: 'text',
          text: 'x'.repeat(64 * 1024),
          size: 64 * 1024,
          truncated: true
        })
      })
    })

    expect(result).toEqual({
      attachment: {
        id: 'a1',
        name: 'notes.txt',
        size: 64 * 1024,
        path: 'src/notes.txt'
      }
    })
  })

  it('二进制与超大也是路径引用（带实际大小），不再给人话拒收', async () => {
    const binary = await resolve(FILE_ITEM, {
      channel: channel({ readFile: async () => ({ kind: 'binary', size: 2048 }) })
    })
    expect(binary).toEqual({
      attachment: { id: 'a1', name: 'notes.txt', size: 2048, path: 'src/notes.txt' }
    })

    const huge = await resolve(FILE_ITEM, {
      channel: channel({ readFile: async () => ({ kind: 'too-large', size: 100 * 1024 * 1024 }) })
    })
    expect(huge).toEqual({
      attachment: { id: 'a1', name: 'notes.txt', size: 100 * 1024 * 1024, path: 'src/notes.txt' }
    })
  })

  it('读不了（通道抛错）：剥掉 IPC 包装，只留人话', async () => {
    const result = await resolve(FILE_ITEM, {
      channel: channel({
        readFile: async () => {
          throw new Error(
            "Error invoking remote method 'workbench:read-file': Error: 这个文件不在磁盘上了"
          )
        }
      })
    })

    expect(result).toEqual({ problem: '这个文件不在磁盘上了' })
  })

  it('通道缺失（没装桥）给人话，不抛', async () => {
    const result = await resolve(FILE_ITEM, { channel: null })
    expect('problem' in result && result.problem).toContain('工作台通道不可用')
  })
})

describe('round 42 · 解析：图片', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const item: ContextItem = {
    source: 'file',
    threadId: 't1',
    relative: '图片.png',
    name: '图片.png'
  }

  function imageChannel(size: number): ContextChannel {
    return channel({
      readBytes: async () => ({ kind: 'bytes', format: 'image-png', bytes: PNG, size })
    })
  }

  it('vision=true：读字节 → data URL 图片附件（不读文本通道）', async () => {
    const channelStub = imageChannel(4)
    const result = await resolve(item, { channel: channelStub })

    expect(result).toEqual({
      attachment: {
        id: 'a1',
        name: '图片.png',
        size: 4,
        image: { url: 'data:image/png;base64,iVBORw==', mediaType: 'image/png' }
      }
    })
    expect(channelStub.readBytes).toHaveBeenCalledWith('t1', '图片.png')
    expect(channelStub.readFile).not.toHaveBeenCalled()
  })

  it('vision=false：人话拒收，连字节都不拉（与 ＋ 上传同一句）', async () => {
    const channelStub = imageChannel(4)
    const result = await resolve(item, { channel: channelStub, vision: false })

    expect(result).toEqual({ problem: NO_VISION_MESSAGE })
    expect(channelStub.readBytes).not.toHaveBeenCalled()
  })

  it('字节通道的三种判别结果各自给人话', async () => {
    const tooLarge = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'too-large', size: 40 << 20, limit: IMAGE_MAX_BYTES })
      })
    })
    expect(tooLarge).toEqual({ problem: '超过 8MB' })

    const missing = await resolve(item, {
      channel: channel({ readBytes: async () => ({ kind: 'missing' }) })
    })
    expect('problem' in missing && missing.problem).toContain('不在磁盘上')

    const unsupported = await resolve(item, {
      channel: channel({ readBytes: async () => ({ kind: 'unsupported', size: 9 }) })
    })
    expect(unsupported).toEqual({ problem: CONTEXT_UNSUPPORTED })
  })

  it('后缀是图片但字节判定成别的格式：按不支持处理（不硬发）', async () => {
    const result = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'bytes', format: 'pdf', bytes: PNG, size: 4 })
      })
    })
    expect(result).toEqual({ problem: CONTEXT_UNSUPPORTED })
  })
})

describe('round 42 · 解析：PDF', () => {
  const item: ContextItem = {
    source: 'file',
    threadId: 't1',
    relative: '报告.pdf',
    name: '报告.pdf'
  }
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

  it('字节 → 主进程抽文字层 → 文本附件（带页数、按 PDF 口径不截断）', async () => {
    const result = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'bytes', format: 'pdf', bytes, size: 4 })
      }),
      extractPdf: async () => ({ ok: true, pages: 3, truncated: true, text: '【第 1 页】正文' })
    })

    expect(result).toEqual({
      attachment: {
        id: 'a1',
        name: '报告.pdf',
        size: 4,
        text: '【第 1 页】正文',
        pdf: { pages: 3, truncated: true },
        relative: '报告.pdf'
      }
    })
  })

  it('抽不出文字（扫描件）原样给人话，不假装收下', async () => {
    const result = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'bytes', format: 'pdf', bytes, size: 4 })
      }),
      extractPdf: async () => ({ ok: false, message: '这个 PDF 没有文字层（可能是扫描件）' })
    })

    expect(result).toEqual({ problem: '这个 PDF 没有文字层（可能是扫描件）' })
  })

  it('抽取通道抛错也算拒收（不炸输入卡）', async () => {
    const result = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'bytes', format: 'pdf', bytes, size: 4 })
      }),
      extractPdf: async () => {
        throw new Error('附件通道不可用（window.kyclaw 缺失）')
      }
    })

    expect(result).toEqual({ problem: '附件通道不可用（window.kyclaw 缺失）' })
  })

  it('超过字节通道上限：按主进程回的上限给人话', async () => {
    const result = await resolve(item, {
      channel: channel({
        readBytes: async () => ({ kind: 'too-large', size: 40 << 20, limit: 32 * 1024 * 1024 })
      })
    })

    expect(result).toEqual({ problem: '超过 32MB' })
  })
})

describe('round 42 二轮 · 选区定位（行号区间）', () => {
  /** 四行源文：每行一个单词，方便手算行号 */
  const SOURCE = 'line one\nline two\nline three\nline four\n'

  it('整段原样对上：按字符偏移换算成 1 基行号', () => {
    expect(linesOfSelection(SOURCE, 'line two\nline three')).toEqual({ start: 2, end: 3 })
    // 从半行开始选也算得准（行号按它所在的行）
    expect(linesOfSelection(SOURCE, 'two\nline three')).toEqual({ start: 2, end: 3 })
  })

  it('首尾空白不进定位（选中时带的换行不把行号带偏）', () => {
    expect(linesOfSelection(SOURCE, '\nline three\n')).toEqual({ start: 3, end: 3 })
  })

  it('markdown 渲染后形状变了：用首行与末行在源文里各自定位（尽力）', () => {
    const markdown = '## 标题\n\n正文第一段\n\n正文第二段\n'
    // 渲染后的选区文本没有 `##`（块之间被插换行）
    expect(linesOfSelection(markdown, '标题\n正文第一段')).toEqual({ start: 1, end: 3 })
    expect(linesOfSelection(markdown, '正文第一段\n正文第二段')).toEqual({ start: 3, end: 5 })
  })

  it('定位不到就回 null（空选区 / 源文里没有这段）', () => {
    expect(linesOfSelection(SOURCE, '   ')).toBeNull()
    expect(linesOfSelection(SOURCE, '完全不存在的段落')).toBeNull()
    expect(linesOfSelection('', 'line one')).toBeNull()
    // 首行找得到、末行找不到（比如选区把预览的提示行也框进来了）：整段都不给位置
    expect(linesOfSelection(SOURCE, 'line one\n只显示前面一部分（共 1.0 KB）')).toBeNull()
  })
})

describe('round 42 · 按字节截断', () => {
  it('没超上限时原样返回', () => {
    expect(truncateToBytes('abc', 16)).toEqual({ text: 'abc', truncated: false })
  })

  it('中文按字节算（不按字符数）', () => {
    const clipped = truncateToBytes('中'.repeat(10), 9)
    expect(clipped.truncated).toBe(true)
    expect(clipped.text).toHaveLength(3)
    expect(utf8ByteLength(clipped.text)).toBe(9)
  })

  it('不劈开代理对（emoji 整字保留）', () => {
    const clipped = truncateToBytes('🙂🙂', 6)
    expect(clipped.text).toBe('🙂')
    expect(utf8ByteLength(clipped.text)).toBe(4)
  })

  it('上限小于一个字时收成空串（不吐半截）', () => {
    expect(truncateToBytes('中', 2)).toEqual({ text: '', truncated: true })
  })
})
