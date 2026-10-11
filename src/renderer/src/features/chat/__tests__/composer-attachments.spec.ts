import { describe, expect, it, vi } from 'vitest'
import {
  attachmentProblem,
  composeOutgoing,
  composeOutgoingText,
  imageMediaTypeOf,
  isPdfFile,
  NO_VISION_MESSAGE,
  PDF_MAX_BYTES,
  prepareAttachment
} from '@renderer/features/chat/composer-attachments'
import type { PdfExtractor, PendingAttachment } from '@renderer/features/chat/composer-attachments'
import { IMAGE_MAX_BYTES } from '@shared/attachments'

/**
 * 发送组装（T16 小修批；round 14 起引用改为输入框内联标记，不再单独成段）：正文 → 附件块，块间空行分隔。
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
  it('只有正文：首尾空白去掉；引用标记（若有）内联在正文里原样保留', () => {
    expect(composeOutgoingText({ text: '  看这个  ', attachments: [] })).toBe('看这个')
    expect(
      composeOutgoingText({
        text: '  用【引用】技能：读写文件 改一下  ',
        attachments: []
      })
    ).toBe('用【引用】技能：读写文件 改一下')
  })

  it('附件块：内容包在三反引号里，内容末尾的空行不带上', () => {
    const text = composeOutgoingText({
      text: '看这个文件',
      attachments: [attachment('第一行\n第二行\n\n')]
    })

    expect(text).toBe(`看这个文件\n\n【附件】note.md\n${fence(3)}\n第一行\n第二行\n${fence(3)}`)
  })
})

describe('composeOutgoingText · 围栏加固（内容自带反引号）', () => {
  it('内容里出现 ``` → 围栏加长到 4，围栏之间原样保留内容', () => {
    const body = '写法：\n```ts\nconst a = 1\n```\n就这样'
    const text = composeOutgoingText({ text: '', attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(4)}\n${body}\n${fence(4)}`)
    expect(text).toContain(`\n${fence(4)}\n`)
  })

  it('内容里最长的一段是 4 个反引号 → 围栏 5（严格长于内容里的任意一段）', () => {
    const body = 'a ````b``` c'
    const text = composeOutgoingText({ text: '', attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(5)}\n${body}\n${fence(5)}`)
  })

  it('只有一个反引号（行内代码）→ 围栏仍是 3，不无谓加长', () => {
    const body = '行内代码 `value` 不动围栏'
    const text = composeOutgoingText({ text: '', attachments: [attachment(body)] })

    expect(text).toBe(`【附件】note.md\n${fence(3)}\n${body}\n${fence(3)}`)
  })

  it('两段附件各自按自己的内容取围栏（互不牵连）', () => {
    const text = composeOutgoingText({
      text: '',
      attachments: [attachment('普通内容', 'a.txt'), attachment('含 ``` 的内容', 'b.txt')]
    })

    expect(text).toBe(
      `【附件】a.txt\n${fence(3)}\n普通内容\n${fence(3)}\n\n【附件】b.txt\n${fence(4)}\n含 \`\`\` 的内容\n${fence(4)}`
    )
  })
})

/** 一个假抽取器：默认成功，用例可以改返回值 */
function extractor(result?: Awaited<ReturnType<PdfExtractor>>): PdfExtractor {
  return vi.fn(
    async () =>
      result ?? { ok: true as const, pages: 2, truncated: false, text: '【第 1 页】\n正文' }
  )
}

describe('模块 2 · 附件路由（vision × 类别）', () => {
  it('图片：vision=false → 人话拒收（带"去哪开"）；vision=true 才收', () => {
    const image = new File(['x'], 'shot.png', { type: 'image/png' })
    expect(attachmentProblem(image, { vision: false })).toBe(NO_VISION_MESSAGE)
    expect(attachmentProblem(image, { vision: true })).toBeNull()
  })

  it('图片：认不出 MIME 时按扩展名兜底（.jpg 也走图片那一路），上限 8MB', () => {
    expect(imageMediaTypeOf(new File(['x'], 'a.jpg', { type: '' }))).toBe('image/jpeg')
    expect(imageMediaTypeOf(new File(['x'], 'a.webp', { type: '' }))).toBe('image/webp')
    expect(imageMediaTypeOf(new File(['x'], 'a.txt', { type: '' }))).toBeNull()

    const big = new File([new Uint8Array(IMAGE_MAX_BYTES + 1)], 'big.png', { type: 'image/png' })
    expect(attachmentProblem(big, { vision: true })).toBe('超过 8MB')
    // 不认视觉的模型先撞"不支持看图"，不去比大小
    expect(attachmentProblem(big, { vision: false })).toBe(NO_VISION_MESSAGE)
  })

  it('PDF：不看视觉能力（所有模型都走主进程文本抽取）；只拦大小', () => {
    const pdf = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })
    expect(isPdfFile(pdf)).toBe(true)
    expect(attachmentProblem(pdf, { vision: false })).toBeNull()
    expect(attachmentProblem(pdf, { vision: true })).toBeNull()

    const big = new File([new Uint8Array(PDF_MAX_BYTES + 1)], 'big.pdf', {
      type: 'application/pdf'
    })
    expect(attachmentProblem(big, { vision: false })).toBe('超过 64MB')
  })

  it('文本类口径不变：≤16KB、认文本 MIME 与常见扩展名；其余不是文本文件', () => {
    const ok = new File(['hello'], 'note.txt', { type: 'text/plain' })
    expect(attachmentProblem(ok, { vision: false })).toBeNull()
    // 空 MIME 按扩展名兜底
    expect(attachmentProblem(new File(['a'], 'a.ts', { type: '' }), { vision: false })).toBeNull()

    const tooBig = new File([new Uint8Array(17 * 1024)], 'big.txt', { type: 'text/plain' })
    expect(attachmentProblem(tooBig, { vision: false })).toBe('超过 16KB')
    expect(
      attachmentProblem(new File(['x'], 'a.zip', { type: 'application/zip' }), { vision: false })
    ).toBe('不是文本文件')
  })
})

describe('模块 2 · prepareAttachment（＋ 上传与拖拽共用的那一刻）', () => {
  it('图片：读成 data URL，附件带 image（url + mediaType）', async () => {
    const image = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    const result = await prepareAttachment(image, {
      vision: true,
      extractPdf: extractor(),
      id: 'a1'
    })

    expect('attachment' in result).toBe(true)
    if (!('attachment' in result)) return
    expect(result.attachment.image?.mediaType).toBe('image/png')
    expect(result.attachment.image?.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.attachment.text).toBeUndefined()
  })

  it('vision=false 的图片：连读都不读，直接回那句人话', async () => {
    const result = await prepareAttachment(new File(['x'], 'shot.png', { type: 'image/png' }), {
      vision: false,
      extractPdf: extractor(),
      id: 'a1'
    })
    expect(result).toEqual({ problem: NO_VISION_MESSAGE })
  })

  it('PDF 成功：文本带页码标记进附件，页数与截断标记一起留档', async () => {
    const result = await prepareAttachment(
      new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }),
      { vision: false, extractPdf: extractor(), id: 'p1' }
    )

    expect('attachment' in result).toBe(true)
    if (!('attachment' in result)) return
    expect(result.attachment.text).toContain('【第 1 页】')
    expect(result.attachment.pdf).toEqual({ pages: 2, truncated: false })
  })

  it('扫描件（抽取回 ok:false）：原样把那句人话当拒收原因', async () => {
    const scanned = extractor({ ok: false, message: '这个 PDF 没有文字层（可能是扫描件）' })
    const result = await prepareAttachment(
      new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }),
      { vision: false, extractPdf: scanned, id: 'p1' }
    )
    expect(result).toEqual({ problem: '这个 PDF 没有文字层（可能是扫描件）' })
  })

  it('抽取通道抛异常：不炸，回一句人话', async () => {
    const broken: PdfExtractor = vi.fn(async () => {
      throw new Error('附件通道不可用')
    })
    const result = await prepareAttachment(
      new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }),
      { vision: false, extractPdf: broken, id: 'p1' }
    )
    expect(result).toEqual({ problem: '附件通道不可用' })
  })

  it('文本：读成原文（口径不变）', async () => {
    const result = await prepareAttachment(new File(['正文'], 'note.txt', { type: 'text/plain' }), {
      vision: false,
      extractPdf: extractor(),
      id: 't1'
    })
    expect(result).toEqual({
      attachment: { id: 't1', name: 'note.txt', size: 6, text: '正文' }
    })
  })
})

describe('模块 2 · composeOutgoing（正文与"真发的文件"分道）', () => {
  it('图片进 files；文本/PDF 进正文围栏；只有图片时正文为空串', () => {
    const image: PendingAttachment = {
      id: 'i1',
      name: 'shot.png',
      size: 10,
      image: { url: 'data:image/png;base64,AAA', mediaType: 'image/png' }
    }
    const pdf: PendingAttachment = {
      id: 'p1',
      name: 'doc.pdf',
      size: 20,
      text: '【第 1 页】\n正文',
      pdf: { pages: 1, truncated: false }
    }

    const withText = composeOutgoing({ text: '看看', attachments: [image, pdf] })
    expect(withText.text).toBe('看看\n\n【附件】doc.pdf\n```\n【第 1 页】\n正文\n```')
    expect(withText.files).toEqual([
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,AAA',
        filename: 'shot.png'
      }
    ])

    const imageOnly = composeOutgoing({ text: '   ', attachments: [image] })
    expect(imageOnly.text).toBe('')
    expect(imageOnly.files).toHaveLength(1)
  })
})
