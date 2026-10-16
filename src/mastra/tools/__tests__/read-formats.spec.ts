// @vitest-environment node
/**
 * read 的**办公格式分派**（0.1.2）：xlsx / pptx / csv / docx 直读、旧版 .doc/.xls/.ppt 经转换后复用、
 * 宏 / 加密 / 只读二进制不假读，以及 `toModelOutput` 的**形状校验**（错误对象不许被当成图片）。
 *
 * fixture 与 read.spec.ts 同口径：能真件就真件（`renderDocx` / `renderXlsx` / `renderPptx`），
 * 转换器走**注入**（单测不装 194MB 的随包 LibreOffice，注入假转换器就能把"转换后复用现代抽取"
 * 这条链覆盖到）。全程只碰内存与临时目录。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderDocx } from '../docx'
import { renderXlsx } from '../excel'
import { renderPptx } from '../ppt'
import { createReadTool, type LegacyConverter } from '../read'
import { callTool, createBed, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

/** 旧版 Office 的 OLE 复合文档头（`sniffFormat` 不认它，read 用它判"这是旧三格式"） */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 真 PNG 32×24（改名/误扩展名用例） */
const PNG_32x24 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAANElEQVR4nGOUizrBQEvARFPTGUYtIAKMxgFBMBpEBMFoEBEEo0FEEIwGEUEwGkQEAc2DCAA+4gFw1nh8rAAAAABJRU5ErkJggg=='

function writeBytes(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes)
}

/** 工具输出里"到模型手上的那一步"（与 read.spec.ts 同一个取法） */
function mapperOf(tool: unknown): (output: unknown) => Promise<unknown> {
  const mapper = (tool as { toModelOutput?: (output: unknown) => Promise<unknown> }).toModelOutput
  if (mapper === undefined) throw new Error('这个工具没有 toModelOutput')
  return mapper
}

describe('read：Excel（.xlsx 直读）', () => {
  it('真件：表格内容读得到（带工作表名与行号），不再是一句"二进制"', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'sheet.xlsx'),
      await renderXlsx([
        {
          name: '汇总',
          rows: [
            ['月份', '金额'],
            ['1 月', 100]
          ]
        }
      ])
    )

    const out = String(await callTool(tool, { path: 'sheet.xlsx' }))

    expect(out).toContain('工作表「汇总」')
    expect(out).toContain('行 1: 月份 | 金额')
    expect(out).toContain('行 2: 1 月 | 100')
    expect(out).not.toContain('二进制')
    expect(out).not.toContain('\uFFFD')
  })

  it('扩展名是 .xlsx、内容不是 OOXML（纯文本）：说清对不上，不给乱码', async () => {
    const tool = await createReadTool(bed.ctx)
    writeFileSync(join(bed.root, 'fake.xlsx'), '这不是一个工作簿')

    const out = String(await callTool(tool, { path: 'fake.xlsx' }))

    expect(out).toMatch(/文件头|不是 OOXML/)
    expect(out).toMatch(/下一步/)
  })

  it('加过密码的 OOXML（内容是 OLE 复合文档）：说清是加密件，不假读', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'locked.xlsx'), Buffer.concat([OLE_HEAD, Buffer.alloc(128)]))

    const out = String(await callTool(tool, { path: 'locked.xlsx' }))

    expect(out).toContain('密码')
    expect(out).toMatch(/OLE|加密/)
    expect(out).toMatch(/下一步/)
  })

  it('启用宏的工作簿（.xlsm）：**明确拒绝**，不读一半装作读全（哪怕内容是合法 OOXML）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'macro.xlsm'),
      await renderXlsx([{ name: '数据', rows: [['甲', 1]] }])
    )

    const out = String(await callTool(tool, { path: 'macro.xlsm' }))

    expect(out).toContain('没读')
    expect(out).toContain('宏')
    expect(out).toMatch(/另存为/)
    // 数据一格都不许漏出来（漏了就是"读了一半"）
    expect(out).not.toContain('甲')
  })

  it('启用宏的演示文稿（.pptm）：同样明确拒绝', async () => {
    const tool = await createReadTool(bed.ctx)
    const { data } = await renderPptx({ title: '带宏', slides: [{ title: '正文页' }] })
    writeBytes(join(bed.root, 'macro.pptm'), data)

    const out = String(await callTool(tool, { path: 'macro.pptm' }))

    expect(out).toContain('没读')
    expect(out).toContain('宏')
    expect(out).not.toContain('正文页')
  })

  it('模板变体（.dotx / .ppsx）：不宣称支持，给"另存为"的下一步', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'tpl.dotx'),
      await renderDocx({ blocks: [{ type: 'paragraph', text: '模板' }] })
    )
    writeBytes(join(bed.root, 'show.ppsx'), (await renderPptx({ title: '放映', slides: [] })).data)

    const docxTemplate = String(await callTool(tool, { path: 'tpl.dotx' }))
    expect(docxTemplate).toContain('没读')
    expect(docxTemplate).toContain('模板')
    expect(docxTemplate).toMatch(/另存为 .docx/)

    const pptxShow = String(await callTool(tool, { path: 'show.ppsx' }))
    expect(pptxShow).toContain('没读')
    expect(pptxShow).toMatch(/另存为 .pptx/)
  })

  it('二进制工作簿（.xlsb）：点名拒掉，不按文本解', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'bin.xlsb'), Buffer.from([0x09, 0x08, 0x06, 0x00, 0x00]))

    const out = String(await callTool(tool, { path: 'bin.xlsb' }))

    expect(out).toContain('xlsb')
    expect(out).toMatch(/下一步/)
  })
})

describe('read：CSV（编码与表格）', () => {
  it('UTF-8：直接读成表格（行号 + ` | `）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeFileSync(join(bed.root, 'plain.csv'), '甲,乙\n丙,丁\n')

    const out = String(await callTool(tool, { path: 'plain.csv' }))

    expect(out).toContain('表格「plain」')
    expect(out).toContain('行 1: 甲 | 乙')
    expect(out).toContain('行 2: 丙 | 丁')
    // 纯 UTF-8 不用报编码（报了就成噪音）
    expect(out).not.toContain('编码：')
  })

  it('UTF-16LE（带 BOM）：按 BOM 解码并如实报编码', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(
      join(bed.root, 'utf16.csv'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('甲,乙\n', 'utf16le')])
    )

    const out = String(await callTool(tool, { path: 'utf16.csv' }))

    expect(out).toContain('行 1: 甲 | 乙')
    expect(out).toContain('编码：UTF-16LE')
  })

  it('GB18030（不是合法 UTF-8）：回退解出来，并**标明是推测**', async () => {
    const tool = await createReadTool(bed.ctx)
    // '中文,abc' 的 GB18030 字节（中 = D6 D0、文 = CE C4）
    writeBytes(
      join(bed.root, 'gbk.csv'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x61, 0x62, 0x63])
    )

    const out = String(await callTool(tool, { path: 'gbk.csv' }))

    expect(out).toContain('行 1: 中文 | abc')
    expect(out).toContain('按内容推测')
    expect(out).toContain('GB18030')
  })

  it('扩展名是 .csv、内容其实是图片：说清它是什么，不按文本解', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'fake.csv'), Buffer.from(PNG_32x24, 'base64'))

    const out = String(await callTool(tool, { path: 'fake.csv' }))

    expect(out).toContain('PNG')
    expect(out).toMatch(/下一步/)
    expect(out).not.toContain('\uFFFD')
  })
})

describe('read：PowerPoint（.pptx 直读）', () => {
  it('真件：逐页文字读得到（封面 + 内容页），带页号', async () => {
    const tool = await createReadTool(bed.ctx)
    const { data } = await renderPptx({
      title: '汇报',
      slides: [{ title: '进展', bullets: ['第一条'] }]
    })
    writeBytes(join(bed.root, 'deck.pptx'), data)

    const out = String(await callTool(tool, { path: 'deck.pptx' }))

    expect(out).toContain('第 1 页')
    expect(out).toContain('汇报')
    expect(out).toContain('进展')
    expect(out).not.toContain('\uFFFD')
  })
})

describe('read：旧版 Office（.doc / .xls / .ppt）经转换后复用', () => {
  it('.doc：转换后按 Word 抽（转换器拿到的是**原路径**），并说清原件没动、宏不在结果里', async () => {
    const docx = await renderDocx({
      title: '旧报告',
      blocks: [{ type: 'paragraph', text: '老文件里的正文' }]
    })
    const calls: Array<{ abs: string; kind: string }> = []
    const converter: LegacyConverter = async (abs, kind) => {
      calls.push({ abs, kind })
      return { bytes: Buffer.from(docx), format: 'docx' }
    }
    const tool = await createReadTool(bed.ctx, { legacyConverter: converter })
    writeBytes(join(bed.root, 'old.doc'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'old.doc' }))

    expect(out).toContain('老文件里的正文')
    expect(out).toContain('原件没有被改动')
    expect(calls).toEqual([{ abs: join(bed.root, 'old.doc'), kind: 'doc' }])
  })

  it('.xls：转换器出 .xlsx → 走表格抽取（行列定位也在）', async () => {
    const xlsx = await renderXlsx([{ name: '老表', rows: [['甲', 1]] }])
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => ({ bytes: Buffer.from(xlsx), format: 'xlsx' })
    })
    writeBytes(join(bed.root, 'old.xls'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'old.xls' }))

    expect(out).toContain('行 1: 甲 | 1')
    expect(out).toContain('旧版')
  })

  it('.ppt：转换器出 .pptx → 走逐页抽取', async () => {
    const { data } = await renderPptx({ title: '老讲稿', slides: [{ title: '正文页' }] })
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => ({ bytes: Buffer.from(data), format: 'pptx' })
    })
    writeBytes(join(bed.root, 'old.ppt'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'old.ppt' }))

    expect(out).toContain('第 1 页')
    expect(out).toContain('老讲稿')
  })

  it('转换失败（没装转换器 / 文件坏了）：报出原因 + 下一步，绝不假装读到了', async () => {
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        throw new Error('本机没有随包 LibreOffice，转不了')
      }
    })
    writeBytes(join(bed.root, 'broken.doc'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'broken.doc' }))

    expect(out).toContain('转不了')
    expect(out).toContain('本机没有随包 LibreOffice')
    expect(out).toMatch(/另存为/)
  })

  it('用户中止（AbortError）：按"中止"说，不读成"转不了"', async () => {
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        const error = new Error('已被用户中止：没有转换 old.doc')
        error.name = 'AbortError'
        throw error
      }
    })
    writeBytes(join(bed.root, 'aborted.doc'), Buffer.concat([OLE_HEAD, Buffer.alloc(64)]))

    const out = String(await callTool(tool, { path: 'aborted.doc' }))

    expect(out).toContain('已被用户中止')
    expect(out).not.toContain('转不了')
  })

  it('.doc 里其实是 OOXML（改过扩展名）：说清真实格式，**不**去调转换器', async () => {
    let called = 0
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        called += 1
        return { bytes: Buffer.alloc(0), format: 'docx' }
      }
    })
    writeBytes(
      join(bed.root, 'actually.docx.doc'),
      await renderDocx({ blocks: [{ type: 'paragraph', text: '新版内容' }] })
    )

    const out = String(await callTool(tool, { path: 'actually.docx.doc' }))

    expect(out).toContain('OOXML')
    expect(out).toMatch(/扩展名/)
    expect(called).toBe(0)
  })

  it('.doc 文件头既不是 OLE 也不是 OOXML：说清对不上，不送去转换', async () => {
    let called = 0
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        called += 1
        return { bytes: Buffer.alloc(0), format: 'docx' }
      }
    })
    writeFileSync(join(bed.root, 'not-really.doc'), '这其实是一个纯文本文件')

    const out = String(await callTool(tool, { path: 'not-really.doc' }))

    expect(out).toContain('OLE')
    expect(out).toMatch(/下一步/)
    expect(called).toBe(0)
  })

  it('后缀是 .doc 内容却是 RTF：指出真实格式与下一步，不送去转换', async () => {
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        throw new Error('不该被调用')
      }
    })
    writeFileSync(join(bed.root, 'rtf.doc'), '{\\rtf1\\ansi 这是 RTF}')

    const out = String(await callTool(tool, { path: 'rtf.doc' }))

    expect(out).toContain('RTF')
    expect(out).toMatch(/\.rtf/)
  })

  it('后缀是 .xls 内容却是 HTML（不少系统的"导出 Excel"）：指出真实格式与下一步', async () => {
    const tool = await createReadTool(bed.ctx, {
      legacyConverter: async () => {
        throw new Error('不该被调用')
      }
    })
    writeFileSync(join(bed.root, 'export.xls'), '<html><table><tr><td>1</td></tr></table></html>')

    const out = String(await callTool(tool, { path: 'export.xls' }))

    expect(out).toContain('HTML')
    expect(out).toMatch(/另存为|xlsx/)
  })
})

describe('read：toModelOutput 的形状校验（错误对象不许被当成图片）', () => {
  it('形状不对的错误对象：不做映射（返回 null），也不去读盘', async () => {
    const tool = await createReadTool(bed.ctx)
    const mapper = mapperOf(tool)

    // schema 校验失败的对象（多一个 error 字段、缺 mediaType/abs）—— 旧实现会拿 result.abs 去读盘
    await expect(mapper({ error: '未知错误', message: '出错了' })).resolves.toBeNull()
  })

  it('字段类型不对的对象（abs 不是字符串）：同样不做映射', async () => {
    const tool = await createReadTool(bed.ctx)
    const mapper = mapperOf(tool)

    await expect(
      mapper({ message: '这是一张图片', path: 'a.png', abs: 42, mediaType: 'image/png', bytes: 1 })
    ).resolves.toBeNull()
  })

  it('文本档（字符串）：不做映射（与旧行为一致）', async () => {
    const tool = await createReadTool(bed.ctx)
    await expect(mapperOf(tool)('一段普通文本')).resolves.toBeNull()
  })

  it('真正的图片档：照旧把原始字节交给模型（形状校验不误伤）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeBytes(join(bed.root, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

    const result = (await callTool(tool, { path: 'shot.png' })) as { message: string }
    const mapped = (await mapperOf(tool)(result)) as {
      type: string
      value: Array<{ type: string; mediaType?: string; data?: { data: string } }>
    }

    expect(mapped.type).toBe('content')
    expect(mapped.value[1].type).toBe('file')
    expect(mapped.value[1].mediaType).toBe('image/png')
    expect(mapped.value[1].data?.data).toBe(PNG_32x24)
  })
})
