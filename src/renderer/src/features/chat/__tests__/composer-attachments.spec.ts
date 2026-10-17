import { describe, expect, it, vi } from 'vitest'
import {
  attachmentProblem,
  composeOutgoing,
  composeOutgoingText,
  imageMediaTypeOf,
  isPdfFile,
  NO_VISION_MESSAGE,
  PDF_MAX_BYTES,
  prepareAttachment,
  relativeInRoot
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

describe('0.1.3 / 013 返工 · composeOutgoing：回复选段仍带完整原文', () => {
  const original = '第一段原文\n第二段原文'
  const quote: PendingAttachment = {
    id: 'q1',
    name: '回复选段',
    size: original.length,
    text: original,
    quote: true,
    quoteFrom: 'reply',
    origin: 'AI 回复',
    originRef: 'AI 回复（消息 a1）'
  }

  it('抬头写「【引用】回复：…」，围栏里是完整原文（不是卡上的摘要）', () => {
    const text = composeOutgoingText({ text: '', attachments: [quote] })
    expect(text).toBe(`【引用】回复：回复选段\n${fence(3)}\n${original}\n${fence(3)}`)
  })

  it('展示上下文仍按 006 的形状生成：kind=quote、source 可追溯到消息、append 摘录不复制大段正文', () => {
    const outgoing = composeOutgoing({ text: '', attachments: [quote] })
    const entry = outgoing.context?.entries[0]
    expect(entry).toMatchObject({
      kind: 'quote',
      name: '回复选段',
      source: 'AI 回复（消息 a1）'
    })
    expect(entry?.append).toBeDefined()
    expect(entry?.append?.length).toBe(
      `【引用】回复：回复选段\n${fence(3)}\n${original}\n${fence(3)}`.length
    )
    // 头尾摘录有上限（≤48 字），大段原文不会整段复制进 metadata
    expect(entry?.append?.head.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48)
    expect(entry?.append?.tail.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48)
  })

  it('文件摘选的既有抬头不变（【引用】文件：…）', () => {
    const fileQuote: PendingAttachment = {
      id: 'q2',
      name: 'app.ts 摘选',
      size: 3,
      text: 'abc',
      relative: 'src/app.ts',
      quote: true,
      lines: { start: 3, end: 8 }
    }
    expect(composeOutgoingText({ text: '', attachments: [fileQuote] })).toBe(
      `【引用】文件：src/app.ts（第 3–8 行）\n${fence(3)}\nabc\n${fence(3)}`
    )
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

  it('文本类（无路径兜底闸门）：≤16KB、认文本 MIME 与常见扩展名；其余不是文本文件', () => {
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

describe('round 53 · 路径引用（非图片非 PDF 的载荷 = 路径，不读内容）', () => {
  /** 一个"文件名 → 绝对路径"的假桥（不在表里的回空 = 拿不到路径） */
  function paths(map: Record<string, string>): (file: File) => string {
    return (file) => map[file.name] ?? ''
  }

  /** 三件共用的基础观测（`rootPath` 与 `pathForFile` 各用例自己给） */
  const base = { vision: false, extractPdf: extractor(), id: 'f1' }

  it('根内：载荷 = 工作区相对路径（正斜杠）；绝对路径另存一份（chip 的 tooltip）', async () => {
    const result = await prepareAttachment(new File(['x'], 'note.txt', { type: 'text/plain' }), {
      ...base,
      rootPath: 'D:\\工作区',
      pathForFile: paths({ 'note.txt': 'D:\\工作区\\src\\note.txt' })
    })

    expect(result).toEqual({
      attachment: {
        id: 'f1',
        name: 'note.txt',
        size: 1,
        path: 'src/note.txt',
        absolute: 'D:\\工作区\\src\\note.txt'
      }
    })
  })

  it('根外（比如 Downloads）：原样绝对路径（不拦 —— 模型用 bash 读得到）', async () => {
    const result = await prepareAttachment(new File(['x'], 'a.bin', { type: '' }), {
      ...base,
      rootPath: 'D:\\工作区',
      pathForFile: paths({ 'a.bin': 'C:\\Users\\me\\Downloads\\a.bin' })
    })

    expect(result).toEqual({
      attachment: {
        id: 'f1',
        name: 'a.bin',
        size: 1,
        path: 'C:\\Users\\me\\Downloads\\a.bin',
        absolute: 'C:\\Users\\me\\Downloads\\a.bin'
      }
    })
  })

  it('exe / 10MB 大文件：不再按大小或二进制拒收（旧口径在这里说"超过 16KB"）', async () => {
    const exe = new File([new Uint8Array(10 * 1024 * 1024)], 'mediacreationtool.exe', {
      type: 'application/x-msdownload'
    })
    const result = await prepareAttachment(exe, {
      ...base,
      rootPath: 'D:\\工作区',
      pathForFile: paths({ 'mediacreationtool.exe': 'C:\\Downloads\\mediacreationtool.exe' })
    })

    expect('attachment' in result).toBe(true)
    if (!('attachment' in result)) return
    expect(result.attachment.path).toBe('C:\\Downloads\\mediacreationtool.exe')
    expect(result.attachment.text).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('太大')
    expect(JSON.stringify(result)).not.toContain('不是文本文件')
  })

  it('有路径就一个字节都不读（FileReader 不被碰）', async () => {
    const spy = vi.spyOn(FileReader.prototype, 'readAsText')
    const result = await prepareAttachment(new File(['正文'], 'note.txt', { type: 'text/plain' }), {
      ...base,
      pathForFile: paths({ 'note.txt': 'D:\\ws\\note.txt' })
    })
    spy.mockRestore()

    expect('attachment' in result).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('拿不到路径（桥缺失 / 回空）：兜底旧行为（≤16KB 文本内联；大文件旧拒收文案）', async () => {
    const inline = await prepareAttachment(new File(['正文'], 'note.txt', { type: 'text/plain' }), {
      ...base
    })
    expect(inline).toEqual({ attachment: { id: 'f1', name: 'note.txt', size: 6, text: '正文' } })

    const empty = await prepareAttachment(new File(['x'], 'a.zip', { type: 'application/zip' }), {
      ...base,
      pathForFile: paths({})
    })
    expect(empty).toEqual({ problem: '不是文本文件' })
  })
})

describe('round 53 · relativeInRoot（根内 → 相对；根外/根自己/判不出 → null）', () => {
  it('大小写不敏感、正反斜杠都认、尾部分隔符无所谓', () => {
    expect(relativeInRoot('D:\\WS\\src\\a.ts', 'd:/ws')).toBe('src/a.ts')
    expect(relativeInRoot('D:/ws/src/a.ts', 'D:\\ws\\')).toBe('src/a.ts')
  })

  it('按路径段比较：相邻前缀不算根内（D:\\ws 不吃 D:\\ws2\\a）', () => {
    expect(relativeInRoot('D:\\ws2\\a.ts', 'D:\\ws')).toBeNull()
  })

  it('根自己 / 根外 / 没有根：null（调用方原样保留绝对路径）', () => {
    expect(relativeInRoot('D:\\ws', 'D:\\ws')).toBeNull()
    expect(relativeInRoot('C:\\other\\a.ts', 'D:\\ws')).toBeNull()
    expect(relativeInRoot('D:\\ws\\a.ts', null)).toBeNull()
    expect(relativeInRoot('D:\\ws\\a.ts', '')).toBeNull()
  })
})

describe('round 53 · composeOutgoingText：路径引用只发抬头那一行', () => {
  const exe: PendingAttachment = {
    id: 'e1',
    name: 'mediacreationtool.exe',
    size: 10 * 1024 * 1024,
    path: 'C:\\Downloads\\mediacreationtool.exe',
    absolute: 'C:\\Downloads\\mediacreationtool.exe'
  }

  it('没有围栏、没有内容（不假装给了内容）；正文与它之间仍空行分隔', () => {
    expect(composeOutgoingText({ text: '看看这个', attachments: [exe] })).toBe(
      '看看这个\n\n【附件】C:\\Downloads\\mediacreationtool.exe'
    )
    expect(composeOutgoingText({ text: '', attachments: [exe] })).toBe(
      '【附件】C:\\Downloads\\mediacreationtool.exe'
    )
  })

  it('与文本附件混排：文本那份照旧进围栏，路径那份只落抬头', () => {
    const text: PendingAttachment = { id: 't1', name: 'note.md', size: 4, text: '内容' }
    expect(composeOutgoingText({ text: '', attachments: [text, exe] })).toBe(
      '【附件】note.md\n```\n内容\n```\n\n【附件】C:\\Downloads\\mediacreationtool.exe'
    )
  })

  it('根内相对路径的引用：抬头就是相对路径（与文件树引用同一条口径）', () => {
    const relative: PendingAttachment = {
      id: 'r1',
      name: 'note.txt',
      size: 3,
      path: 'src/note.txt',
      absolute: 'D:\\ws\\src\\note.txt'
    }
    expect(composeOutgoingText({ text: '', attachments: [relative] })).toBe('【附件】src/note.txt')
  })
})
