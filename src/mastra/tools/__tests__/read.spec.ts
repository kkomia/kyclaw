// @vitest-environment node
/**
 * read 工具：整文件 / 行窗口 / 截断契约（>256KB 提示且不切碎多字节字符）/ 工作区边界 / 已读记录，
 * 以及 round 71 起的**按类型分派**（PDF / Word 抽取、图片交给模型看）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf } from '../../../main/__tests__/pdf-fixture'
import { renderDocx } from '../docx'
import { renderXlsx } from '../excel'
import { createReadTool, READ_MAX_BYTES } from '../read'
import { resetSkillRuntimeFactsSource, setSkillRuntimeFactsSource } from '../../skills/runtime'
import { callTool, createBed, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('read：内容与行窗口', () => {
  it('整文件原样读回（CJK + CRLF 不做任何改写）', async () => {
    const tool = await createReadTool(bed.ctx)
    const content = '第一行\r\n第二行 你好\n第三行 👨‍👩‍👧‍👦'
    writeText(join(bed.root, 'a.txt'), content)
    await expect(callTool(tool, { path: 'a.txt' })).resolves.toBe(content)
  })

  it('offset/limit 按行取窗口，并注明窗口范围与总行数', async () => {
    const tool = await createReadTool(bed.ctx)
    const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`)
    writeText(join(bed.root, 'lines.txt'), lines.join('\n'))

    const out = String(await callTool(tool, { path: 'lines.txt', offset: 3, limit: 4 }))
    expect(out.startsWith('line-3\nline-4\nline-5\nline-6')).toBe(true)
    expect(out).toContain('[只显示第 3-6 行，文件共 10 行]')
  })

  it('offset 超出文件行数：明确报错（不是静默给空）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'two.txt'), 'a\nb')
    await expect(callTool(tool, { path: 'two.txt', offset: 5 })).rejects.toThrow(/超出/)
  })

  it('读过就记进当前会话（edit 的未读先改靠它）；别的会话不算', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'x')

    await callTool(tool, { path: 'a.txt' }, 'thread-1')
    expect(bed.ctx.state.wasRead('thread-1', join(bed.root, 'a.txt'))).toBe(true)
    expect(bed.ctx.state.wasRead('thread-2', join(bed.root, 'a.txt'))).toBe(false)
  })
})

describe('read：截断契约（>256KB）', () => {
  it('超过 256KB 截断：给提示，且不切碎多字节字符（无 U+FFFD）', async () => {
    const tool = await createReadTool(bed.ctx)
    // 刀口落在"好"（3 字节）中间：先铺 (256KB - 2) 个 ASCII，再一串"好"
    const body = 'x'.repeat(READ_MAX_BYTES - 2) + '好'.repeat(64)
    writeText(join(bed.root, 'big.txt'), body)

    const out = String(await callTool(tool, { path: 'big.txt' }))
    expect(out).toContain(`[已截断：文件共 ${Buffer.byteLength(body, 'utf8')} 字节`)
    expect(out).not.toContain('\uFFFD')
    const [content] = out.split('\n\n[')
    expect(content).toBe('x'.repeat(READ_MAX_BYTES - 2))
  })

  it('恰好 256KB 不算截断（边界不多不少）', async () => {
    const tool = await createReadTool(bed.ctx)
    const body = 'a'.repeat(READ_MAX_BYTES)
    writeText(join(bed.root, 'exact.txt'), body)

    const out = String(await callTool(tool, { path: 'exact.txt' }))
    expect(out).toBe(body)
    expect(out).not.toContain('已截断')
  })
})

describe('read：边界与失败', () => {
  it('目标不是文件（目录）：报错并提示用 glob', async () => {
    const tool = await createReadTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))
    await expect(callTool(tool, { path: 'sub' })).rejects.toThrow(/glob/)
  })

  it('工作区外：拒绝（fail closed）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.outside, 'secret.txt'), 'secret')
    await expect(callTool(tool, { path: join(bed.outside, 'secret.txt') })).rejects.toThrow(
      /授权工作区/
    )
    await expect(callTool(tool, { path: '../outside/secret.txt' })).rejects.toThrow(/授权工作区/)
  })

  it('一个工作区都没有：拒绝原因指向设置里的工作区', async () => {
    const tool = await createReadTool(bed.ctx)
    bed.roots.length = 0
    await expect(callTool(tool, { path: 'a.txt' })).rejects.toThrow(/授权工作区/)
  })

  it('文件不存在：报错（不是空内容）', async () => {
    const tool = await createReadTool(bed.ctx)
    await expect(callTool(tool, { path: 'nope.txt' })).rejects.toThrow(/不存在|不是文件/)
  })
})

/* ── round 71：PDF / Word / 图片 ─────────────────────────────────────────────
 * 为什么钉这几条：用户实测反馈——丢来 PDF / Word / 图片时，模型只能去 bash 里想办法或先转格式。
 * read 按类型分派：PDF / Word 走主进程既有抽取器（与"把文件当附件发"那条路同一份实现），
 * 把正文交给模型；图片**不抽文字**，把字节直接交给模型**看**（形状与 render_ppt 的页图一致，
 * 见 tools/render-ppt.ts 头注）。
 * 0.1.2 把办公面铺全（xlsx / pptx / csv 直读、旧 .doc/.xls/.ppt 经转换复用、宏与加密不假读、
 * toModelOutput 形状校验）—— 那一批用例在 `read-formats.spec.ts`，这里保持原有这几条。
 *
 * fixture 全是**真件**：PDF 用 main/__tests__/pdf-fixture 的 buildPdf（pdf.js 能解的真 PDF，
 * 正文必须 ASCII，理由见那份 fixture 的头注）、docx 用仓库自己的产出器 renderDocx、
 * xlsx 用 renderXlsx、图片用真图（base64 内嵌，尺寸写在常量名里，由 Pillow 生成）。
 * 两张"超限"用的 PNG 由本文件按 PNG 规范现造（签名 + IHDR + 真 zlib 流 + CRC）—— Pillow 能解码
 * 它们，所以是合法 PNG，不是为骗过判据拼的空壳。
 */

/** 真 PNG 32×24（Pillow 生成；尺寸是这条用例的断言之一） */
const PNG_32x24 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAANElEQVR4nGOUizrBQEvARFPTGUYtIAKMxgFBMBpEBMFoEBEEo0FEEIwGEUEwGkQEAc2DCAA+4gFw1nh8rAAAAABJRU5ErkJggg=='

/** 真 JPEG 32×24（同上） */
const JPEG_32x24 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlKKKK+6PnAooooAKKKKACiiigD//Z'

/** 真 GIF 32×24（同上） */
const GIF_32x24 =
  'R0lGODdhIAAYAIEAAB5ayAAAAAAAAAAAACwAAAAAIAAYAEAILwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJjQEBADs='

/** 真 WebP 32×24（同上；Pillow 存的是有损 VP8 块） */
const WEBP_32x24 =
  'UklGRkgAAABXRUJQVlA4IDwAAABQAwCdASogABgAPm00lkekIyIhKAgAgA2JZQB2APwAAIMoIAD+75rH//0mzxNnibPhFf//FnIxHZeAAAA='

/** 旧版 Office（.doc/.xls/.ppt）的 OLE 复合文档文件头 —— 这里只给文件头：被测的是**判据**，不是真 .doc */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/**
 * 现造一张**真 PNG**（上限用例用）：签名 + IHDR + IDAT + IEND，灰度 8 位、每行一个 0 号 filter
 * 字节，CRC 用 zlib 的 crc32 算。`level` 直通 deflate：0 = 不压缩（用来把文件撑过**字节**上限），
 * 缺省 6（同样尺寸下文件很小，用来只撞**像素**上限）。
 */
function realPng(width: number, height: number, level = 6): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 0 // 灰度
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height), { level })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function writeBytes(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes)
}

/** 图片档的工具输出（走 json 分支的那一态） */
interface ImageReadShape {
  message: string
  mediaType: string
  width?: number
  height?: number
}

/** toModelOutput：图片到模型手上的那一步（形状与工具定义一致，收工具的输出） */
function mapperOf(tool: unknown): (output: unknown) => Promise<unknown> {
  const mapper = (tool as { toModelOutput?: (output: unknown) => Promise<unknown> }).toModelOutput
  if (mapper === undefined) throw new Error('这个工具没有 toModelOutput：图片到不了模型')
  return mapper
}

/** 审批 gate：与其它工具同一形状（工具定义上的 requireApproval，收工具入参） */
function gateOf(tool: unknown): (input: { path: string }) => boolean {
  return (tool as { requireApproval: (input: { path: string }) => boolean }).requireApproval
}

describe('read：PDF（真件）', () => {
  it('抽文字层：拿到正文与页码标记，不是乱码', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'doc.pdf'),
      buildPdf([['Hello PDF', 'second line'], ['Page two text']])
    )

    const out = String(await callTool(tool, { path: 'doc.pdf' }))

    expect(out).toContain('Hello PDF')
    expect(out).toContain('second line')
    expect(out).toContain('Page two text')
    expect(out).toContain('【第 1 页】')
    expect(out).toContain('【第 2 页】')
    // 旧行为（按 UTF-8 解 PDF 字节）在这里会吐 U+FFFD 与一堆二进制噪声
    expect(out).not.toContain('\uFFFD')
  })

  it('扫描版 PDF（没有文字层）：明说抽不到 + 给下一步，不返回空串', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'scan.pdf'), buildPdf([[], []]))

    const out = String(await callTool(tool, { path: 'scan.pdf' }))

    expect(out).toContain('没有文字层')
    expect(out).toMatch(/下一步/)
    expect(out).toMatch(/图片|截图/)
    expect(out).not.toContain('\uFFFD')
  })

  it('坏 PDF：人话（既不是乱码，也不是原始栈）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'broken.pdf'), 'not a pdf at all')

    const out = String(await callTool(tool, { path: 'broken.pdf' }))

    expect(out).toMatch(/打不开|读不出/)
    expect(out).toMatch(/下一步/)
  })
})

describe('read：Word（真件）', () => {
  it('docx 抽成 markdown：标题与正文都在，且不是原始字节', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'report.docx'),
      await renderDocx({
        title: '季度报告',
        blocks: [
          { type: 'heading', text: '一、结论', level: 1 },
          { type: 'paragraph', text: '整体稳中向好。' }
        ]
      })
    )

    const out = String(await callTool(tool, { path: 'report.docx' }))

    expect(out).toContain('# 季度报告')
    expect(out).toContain('# 一、结论')
    expect(out).toContain('整体稳中向好。')
    expect(out).not.toContain('\uFFFD')
  })

  it('扩展名是 .docx、内容不是 OOXML：说清对不上，不给乱码', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'fake.docx'), '这其实是一个纯文本文件')

    const out = String(await callTool(tool, { path: 'fake.docx' }))

    expect(out).toMatch(/不是 OOXML|文件头/)
    expect(out).toMatch(/下一步/)
  })

  it('旧的 .doc（OLE 二进制）：交给转换器；转不出来时人话 + 下一步（不假装读到）', async () => {
    const tool = await createReadTool(bed.ctx, {
      // 真实转换器要随包 LibreOffice（194MB，单测不装）：注入一个必失败的，钉住"失败怎么说话"
      legacyConverter: async () => {
        throw new Error('本机没有随包 LibreOffice')
      }
    })
    writeBytes(join(bed.root, 'legacy.doc'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'legacy.doc' }))

    expect(out).toContain('转不了')
    expect(out).toContain('本机没有随包 LibreOffice')
    expect(out).toMatch(/另存为|截图/)
    expect(out).not.toContain('\uFFFD')
  })
})

describe('read：认得出的二进制（不是文本）', () => {
  it('OOXML 容器但扩展名对不上（.bin）：说清它是什么、下一步把扩展名改对', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'sheet.bin'),
      await renderXlsx([
        {
          name: '汇总',
          rows: [
            ['月份', '金额'],
            ['1 月', '100']
          ]
        }
      ])
    )

    const out = String(await callTool(tool, { path: 'sheet.bin' }))

    expect(out).toContain('二进制')
    expect(out).toMatch(/OOXML/)
    expect(out).toMatch(/扩展名/)
    expect(out).toMatch(/下一步/)
    expect(out).not.toContain('\uFFFD')
  })

  it('图片改了扩展名（.bin）：说清它其实是一张 PNG，并给出改名的下一步', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'shot.bin'), Buffer.from(PNG_32x24, 'base64'))

    const out = String(await callTool(tool, { path: 'shot.bin' }))

    expect(out).toContain('PNG')
    expect(out).toMatch(/扩展名|改名/)
    expect(out).not.toContain('\uFFFD')
  })

  it('真文本不会被误判成二进制：以 "BM" 开头的文本照常读得到', async () => {
    const tool = await createReadTool(bed.ctx)
    // BMP 的魔数只有两个字节（`BM`），不看一下保留字节就会把这种文本误判成图片
    const content = 'BMW 车型对比\n价格：…'
    writeText(join(bed.root, 'bmw.txt'), content)

    await expect(callTool(tool, { path: 'bmw.txt' })).resolves.toBe(content)
  })
})

describe('read：图片（交给模型看，不抽文字）', () => {
  it('PNG：回执报真实尺寸，toModelOutput 把**原始字节**作为图片交给模型', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

    const result = await callTool(tool, { path: 'shot.png' })
    expect(typeof result).toBe('object')
    const out = result as ImageReadShape
    expect(out.mediaType).toBe('image/png')
    expect(out.width).toBe(32)
    expect(out.height).toBe(24)
    expect(out.message).toContain('图片')

    // 模型手上拿到的是**图**（mediaType + 文件原始字节的 base64），不是抽取出来的文字
    await expect(mapperOf(tool)(result)).resolves.toEqual({
      type: 'content',
      value: [
        { type: 'text', text: out.message },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'data', data: PNG_32x24 }
        }
      ]
    })
  })

  it('JPEG / GIF / WebP 各自认对 mediaType 与尺寸', async () => {
    const tool = await createReadTool(bed.ctx)
    const cases = [
      ['a.jpg', JPEG_32x24, 'image/jpeg'],
      ['b.jpeg', JPEG_32x24, 'image/jpeg'],
      ['c.gif', GIF_32x24, 'image/gif'],
      ['d.webp', WEBP_32x24, 'image/webp']
    ] as const

    for (const [name, base64, mediaType] of cases) {
      writeBytes(join(bed.root, name), Buffer.from(base64, 'base64'))
      const out = (await callTool(tool, { path: name })) as ImageReadShape
      expect([name, out.mediaType, out.width, out.height]).toEqual([name, mediaType, 32, 24])
    }
  })

  it('超过像素上限：不发给模型，回执说清尺寸与下一步', async () => {
    const tool = await createReadTool(bed.ctx)
    // 5000×3500 = 17.5M 像素（>16M 上限），而文件只有十几 KB —— 字节上限拦不住它，像素上限才拦得住
    writeBytes(join(bed.root, 'huge.png'), realPng(5000, 3500))

    const out = await callTool(tool, { path: 'huge.png' })

    expect(typeof out).toBe('string')
    expect(String(out)).toContain('5000×3500')
    expect(String(out)).toMatch(/像素/)
    expect(String(out)).toMatch(/上限/)
    expect(String(out)).toMatch(/下一步/)
  })

  it('超过字节上限：不发给模型，回执说清文件多大、上限多少', async () => {
    const tool = await createReadTool(bed.ctx)
    // 3000×3000 的真 PNG，故意用"不压缩"的 zlib 流撑到 ~9MB（>8MB 上限）
    writeBytes(join(bed.root, 'big.png'), realPng(3000, 3000, 0))

    const out = await callTool(tool, { path: 'big.png' })

    expect(typeof out).toBe('string')
    expect(String(out)).toMatch(/上限/)
    expect(String(out)).toMatch(/MB/)
    expect(String(out)).toMatch(/下一步/)
  })

  it('扩展名对不上（.png 里其实是别的）：不发给模型，说清它其实是什么', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'fake.png'), '这不是一张图片')

    const out = await callTool(tool, { path: 'fake.png' })

    expect(typeof out).toBe('string')
    expect(String(out)).toMatch(/文件头|不是/)
    expect(String(out)).toMatch(/下一步/)
  })

  it('读过的图片也记进当前会话（edit 的未读先改靠这份记录）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

    await callTool(tool, { path: 'shot.png' }, 'thread-1')

    expect(bed.ctx.state.wasRead('thread-1', join(bed.root, 'shot.png'))).toBe(true)
  })
})

describe('read：读图片不审（round 75 用户口径）', () => {
  it('文本 / PDF / Word / 图片一律免审（读一张图与读一个文本没有区别）', async () => {
    const tool = await createReadTool(bed.ctx)
    const gate = gateOf(tool)

    expect(gate({ path: 'a.txt' })).toBe(false)
    expect(gate({ path: 'doc.pdf' })).toBe(false)
    expect(gate({ path: 'report.docx' })).toBe(false)
    expect(gate({ path: 'shot.png' })).toBe(false)
  })

  it('full 工作区 / 有规则 / 没有规则：图片档都是免审（图片不再单独判档）', async () => {
    const full = createBed({ mode: 'full' })
    try {
      expect(gateOf(await createReadTool(full.ctx))({ path: 'shot.png' })).toBe(false)
    } finally {
      full.dispose()
    }

    const allowed = createBed()
    allowed.rules.push({ tool: 'read', workspace: allowed.root, mode: 'allow' })
    try {
      expect(gateOf(await createReadTool(allowed.ctx))({ path: 'shot.png' })).toBe(false)
    } finally {
      allowed.dispose()
    }
  })

  it('目标越界：读不了（执行层 fail closed）；审批这一层不问（批了也不会执行）', async () => {
    const tool = await createReadTool(bed.ctx)
    expect(gateOf(tool)({ path: join(bed.outside, 'shot.png') })).toBe(false)
    // 边界照旧在**执行**里：区外的图仍然读不到
    await expect(callTool(tool, { path: join(bed.outside, 'shot.png') })).rejects.toThrow(/工作区/)
  })

  it('当前模型读不了图（本部署事实 vision=false）：不发字节，回一句人话', async () => {
    setSkillRuntimeFactsSource(() => ({ pptRenderer: null, vision: false }))
    try {
      const tool = await createReadTool(bed.ctx)
      writeBytes(join(bed.root, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

      const out = await callTool(tool, { path: 'shot.png' })

      expect(typeof out).toBe('string')
      expect(String(out)).toMatch(/当前模型看不了图/)
      expect(String(out)).toMatch(/支持图片的模型/)
      // 关键：不是图片档的对象（toModelOutput 不会去附字节）
      const mapped = await mapperOf(tool)(String(out))
      expect(mapped).toBeNull()
    } finally {
      resetSkillRuntimeFactsSource()
    }
  })

  it('视觉能力"未知"（没探到结论）时照旧发：不把"不知道"当成"不能"', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

    const out = await callTool(tool, { path: 'shot.png' })

    expect(typeof out).toBe('object')
  })
})

/**
 * PB-038：read 不能读 .html（用户实测）。根因是文本档把 `sniffFormat` 的**预览标记**
 * `'html' / 'image-svg'` 当二进制；这里钉住「HTML/SVG/XML 等文本档能读」「行窗口正确」
 * 「真二进制仍然拒」「编码嗅探（UTF-8 BOM / UTF-16 / GB18030）」。
 */
describe('read：文本档（PB-038 html / svg / xml + 编码嗅探 + 真二进制）', () => {
  const HTML = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head><meta charset="utf-8"><title>部署页</title></head>',
    '  <body>',
    '    <h1>构建产物</h1>',
    '    <p>这是纯文本部署页。</p>',
    '  </body>',
    '</html>'
  ].join('\n')

  it('.html 按文本读：整文件原样返回（不再被当二进制拒绝）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'index.html'), HTML)
    const out = String(await callTool(tool, { path: 'index.html' }))
    expect(out).toBe(HTML)
    expect(out).not.toContain('二进制')
  })

  it('.html 行窗口正确（offset/limit + 范围注记）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'index.html'), HTML)
    const out = String(await callTool(tool, { path: 'index.html', offset: 2, limit: 2 }))
    expect(out).toContain('<html lang="zh-CN">')
    expect(out).toContain('<head><meta charset="utf-8"><title>部署页</title></head>')
    expect(out).toContain('[只显示第 2-3 行，文件共 8 行]')
  })

  it('.svg / .xml / .css 这些文本族都能读（预览标记不再当二进制）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    writeText(join(bed.root, 'feed.xml'), '<?xml version="1.0"?><rss><channel/></rss>')
    writeText(join(bed.root, 'app.css'), '.a { color: red }')
    await expect(callTool(tool, { path: 'logo.svg' })).resolves.toContain('<rect/>')
    await expect(callTool(tool, { path: 'feed.xml' })).resolves.toContain('<rss>')
    await expect(callTool(tool, { path: 'app.css' })).resolves.toBe('.a { color: red }')
  })

  it('真二进制仍然拒（png / zip / exe / wasm / pdf / mp4），且给可读原因', async () => {
    const tool = await createReadTool(bed.ctx)
    const png = Buffer.from(PNG_32x24, 'base64')
    writeBytes(join(bed.root, 'shot.html'), png) // 扩展名是文本，内容是真 PNG：魔数优先
    writeBytes(join(bed.root, 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
    writeBytes(join(bed.root, 'tool.exe'), Buffer.from('MZ\x90\x00', 'latin1'))
    writeBytes(join(bed.root, 'mod.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0]))
    writeBytes(join(bed.root, 'doc.pdf'), Buffer.from('%PDF-1.7\n', 'latin1'))
    writeBytes(
      join(bed.root, 'clip.mp4'),
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypisom', 'latin1'),
        Buffer.from([0, 0, 0, 0])
      ])
    )
    for (const name of ['shot.html', 'bundle.zip', 'tool.exe', 'mod.wasm', 'clip.mp4']) {
      const out = String(await callTool(tool, { path: name }))
      expect(out, name).toContain('二进制')
      expect(out, name).toContain('下一步：')
    }
    // PDF 走的是 PDF 档（按扩展名分派）：内容是二进制的，结论同样是"拒 + 可读原因"，
    // 只是文案是「打不开这份 PDF / 读不出」而不是"二进制"
    const pdfOut = String(await callTool(tool, { path: 'doc.pdf' }))
    expect(pdfOut).toMatch(/打不开这份 PDF|读不出/)
    expect(pdfOut).toContain('下一步：')
  })

  it('UTF-8 BOM：去掉 BOM 后按文本读（不把 BOM 当内容）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'bom.html'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>你好</p>', 'utf8')])
    )
    const out = String(await callTool(tool, { path: 'bom.html' }))
    expect(out).toBe('<p>你好</p>')
    expect(out.startsWith('\uFEFF')).toBe(false)
  })

  it('UTF-16LE（带 BOM）：能解出来，不乱码', async () => {
    const tool = await createReadTool(bed.ctx)
    const body = '记得保存\n第二行'
    writeBytes(
      join(bed.root, 'note16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])
    )
    const out = String(await callTool(tool, { path: 'note16.txt' }))
    expect(out).toBe(body)
  })

  it('GB18030 文本：解出中文并**标明是推测**（不是二进制）', async () => {
    const tool = await createReadTool(bed.ctx)
    // “中文测试” 的 GB18030 字节
    writeBytes(join(bed.root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]))
    const out = String(await callTool(tool, { path: 'gbk.txt' }))
    expect(out).toContain('中文测试')
    expect(out).toContain('编码按内容推测为 GB18030')
    expect(out).not.toContain('\uFFFD')
  })

  it('带 NUL 的 .txt：仍判二进制（不吐乱码）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'nul.txt'), Buffer.from('前一半\n\u0000后一半\n', 'utf8'))
    const out = String(await callTool(tool, { path: 'nul.txt' }))
    expect(out).toContain('二进制')
    expect(out).not.toContain('前一半')
  })
})
