// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fixtureDocx as renderDocx,
  fixturePptx as renderPptx,
  fixtureXlsx as renderXlsx
} from './fixtures/office-fixtures'
import {
  PREVIEW_HTML_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_PDF_MAX_BYTES,
  PREVIEW_TABLE_MAX_BYTES
} from '../../shared/workbench'
import { readFileBytes, readTableBytes, sniffFormat } from '../workbench-files'

/**
 * 带类型字节通道：扩展名 + 文件头双重判定、按格式分桶的上限、缺失/目录/越界、
 * "头与扩展名对不上"一律按不支持（fail closed）。
 *
 * 办公三件（docx/xlsx/pptx）与表格（csv/tsv）的**内容**抽得对不对，用例在
 * `workbench-office.spec.ts`（那一份直接打读取器）；这里只管**通道**：认不认路、
 * 上限、头与后缀对不对得上、文件没了/是目录/越界怎么回。
 * 全在 mkdtemp 的真目录上跑，不碰用户目录。
 */
let root: string
let outside: string

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Buffer.from('GIF89a....', 'latin1')
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1')
])
const BMP = Buffer.from('BMxxxxxx', 'latin1')
const PDF = Buffer.from('%PDF-1.7\n...', 'latin1')
/** SVG：带 XML 声明（最常见的写法） */
const SVG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n',
  'utf8'
)
/** SVG：只带 UTF-8 BOM、没有 XML 声明 */
const SVG_BOM = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
])
/** ICO：头 4 字节 00 00 01 00 */
const ICO = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x18, 0x00]),
  Buffer.alloc(16, 0x22)
])
/** HTML：完整文档 */
const HTML = Buffer.from(
  '<!DOCTYPE html>\n<html lang="zh"><head><title>预览</title></head><body><p>正文</p></body></html>\n',
  'utf8'
)

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-outside-'))
  mkdirSync(join(root, '目录.png'))
  writeFileSync(join(root, '图片.png'), PNG)
  writeFileSync(join(root, '照片.JPG'), JPG)
  writeFileSync(join(root, '动图.gif'), GIF)
  writeFileSync(join(root, '新格式.webp'), WEBP)
  writeFileSync(join(root, '位图.bmp'), BMP)
  writeFileSync(join(root, '矢量图.svg'), SVG)
  writeFileSync(join(root, '图标.ico'), ICO)
  writeFileSync(join(root, '页面.html'), HTML)
  writeFileSync(join(root, '页面.htm'), HTML)
  writeFileSync(join(root, '报告.pdf'), PDF)
  // 改名的可执行文件：后缀说是 png，内容不是
  writeFileSync(join(root, '伪装.png'), Buffer.from('MZ\x90\x00', 'latin1'))
  writeFileSync(join(root, '笔记.txt'), '纯文本\n')
  writeFileSync(join(root, '空.png'), Buffer.alloc(0))
  writeFileSync(join(outside, '外部.png'), PNG)

  // 办公档的真件（产出器就是产真文件的；这里只为"通道"用例准备几个）
  writeFileSync(
    join(root, '方案.docx'),
    await renderDocx({ title: '方案', blocks: [{ type: 'paragraph', text: '正文一段' }] })
  )
  writeFileSync(
    join(root, '台账.xlsx'),
    await renderXlsx([
      {
        name: '汇总',
        rows: [
          ['项目', '金额'],
          ['房租', '1200']
        ]
      }
    ])
  )
  writeFileSync(
    join(root, '汇报.pptx'),
    (await renderPptx({ title: '汇报', slides: [{ bullets: ['第一条'] }] })).data
  )
  writeFileSync(join(root, '名单.csv'), '\uFEFF姓名,年龄\r\n张三,28\r\n')
  writeFileSync(join(root, '名单.tsv'), '姓名\t年龄\r\n张三\t28\r\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('sniffFormat：文件头判定', () => {
  it('九种认得出来的格式各自对号（含本轮新增的 svg / ico / html）', () => {
    expect(sniffFormat(PDF)).toBe('pdf')
    expect(sniffFormat(PNG)).toBe('image-png')
    expect(sniffFormat(JPG)).toBe('image-jpeg')
    expect(sniffFormat(GIF)).toBe('image-gif')
    expect(sniffFormat(WEBP)).toBe('image-webp')
    expect(sniffFormat(BMP)).toBe('image-bmp')
    expect(sniffFormat(ICO)).toBe('image-ico')
    expect(sniffFormat(SVG)).toBe('image-svg')
    expect(sniffFormat(SVG_BOM)).toBe('image-svg')
    expect(sniffFormat(HTML)).toBe('html')
  })

  it('文本族（svg / html）容错：BOM、XML 声明、前导注释、doctype 都不影响判定', () => {
    // BOM + 声明 + 注释 + doctype 叠在一起（真实文件常见写法）
    const messy = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        '<?xml version="1.0"?>\n<!-- 生成器 -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg></svg>',
        'utf8'
      )
    ])
    expect(sniffFormat(messy)).toBe('image-svg')

    // html：只有 doctype 没有 <html>；只写 <head>；前导注释 + <html>
    expect(sniffFormat(Buffer.from('<!DOCTYPE html>', 'utf8'))).toBe('html')
    expect(sniffFormat(Buffer.from('<head><title>x</title></head>', 'utf8'))).toBe('html')
    expect(sniffFormat(Buffer.from('<!-- 注释 --><!DOCTYPE html><html>', 'utf8'))).toBe('html')

    // UTF-16LE/BE（BOM 明示）也认 —— 与渲染端 decodeText 同一组
    const utf16le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<!DOCTYPE html><html></html>', 'utf16le')
    ])
    expect(sniffFormat(utf16le)).toBe('html')
    const utf16beBody = Buffer.from('<!DOCTYPE html><html></html>', 'utf16le')
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16beBody).swap16()])
    expect(sniffFormat(utf16be)).toBe('html')
  })

  it('**不**把带 `<` 的普通文本 / csv 当 HTML（表格那条路不能被文本族判据吃掉）', () => {
    expect(sniffFormat(Buffer.from('a<b,c>d\n1,2\n', 'utf8'))).toBeNull()
    expect(sniffFormat(Buffer.from('姓名,年龄\r\n张三,28\r\n', 'utf8'))).toBeNull()
    // `<` 后跟空格 / 数字不是标签
    expect(sniffFormat(Buffer.from('< 3 and > 5', 'utf8'))).toBeNull()
    expect(sniffFormat(Buffer.from('<div>片段</div>', 'utf8'))).toBeNull() // 不是文档级首标签
    // 不带 BOM 的 UTF-16：不猜编码（LE/BE 都不认 —— 解出来是乱码，认不出按不支持走）
    const le = Buffer.from('<!DOCTYPE html><html>', 'utf16le')
    expect(sniffFormat(le)).toBeNull()
    expect(sniffFormat(Buffer.from(le).swap16())).toBeNull()
  })

  it('zip 头归成 ooxml（docx/xlsx/pptx 同一个头，光看字节分不出是哪件）', () => {
    expect(sniffFormat(Buffer.from('PK\x03\x04rest', 'latin1'))).toBe('ooxml')
    expect(sniffFormat(Buffer.from('PK\x05\x06rest', 'latin1'))).toBe('ooxml')
  })

  it('认不出的头（含空文件、文本）给 null', () => {
    expect(sniffFormat(Buffer.alloc(0))).toBeNull()
    expect(sniffFormat(Buffer.from('hello', 'latin1'))).toBeNull()
    expect(sniffFormat(Buffer.from('姓名,年龄\r\n', 'utf8'))).toBeNull()
    // `.cur` 的头是 00 00 02 00，不认成 ico
    expect(sniffFormat(Buffer.from([0x00, 0x00, 0x02, 0x00, 0x01, 0x00]))).toBeNull()
    // RIFF 但不是 WEBP（wav 之类）不算图片
    expect(
      sniffFormat(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.alloc(4),
          Buffer.from('WAVE', 'latin1')
        ])
      )
    ).toBeNull()
  })
})

describe('readFileBytes：扩展名 + 文件头双重判定', () => {
  it('九种字节格式：回字节 + 格式 + 大小（字节是真的）', async () => {
    const cases: Array<[string, string, Buffer]> = [
      ['图片.png', 'image-png', PNG],
      ['照片.JPG', 'image-jpeg', JPG],
      ['动图.gif', 'image-gif', GIF],
      ['新格式.webp', 'image-webp', WEBP],
      ['位图.bmp', 'image-bmp', BMP],
      ['矢量图.svg', 'image-svg', SVG],
      ['图标.ico', 'image-ico', ICO],
      ['报告.pdf', 'pdf', PDF],
      ['页面.html', 'html', HTML],
      ['页面.htm', 'html', HTML]
    ]
    for (const [name, format, source] of cases) {
      const result = await readFileBytes(root, name)
      expect(result.kind, name).toBe('bytes')
      if (result.kind !== 'bytes') continue
      expect(result.format, name).toBe(format)
      expect(result.size, name).toBe(source.length)
      expect(Buffer.from(result.bytes), name).toEqual(source)
    }
  })

  it('认不出的后缀 / 空文件 / 头与后缀对不上：都按不支持（不猜内容）', async () => {
    expect(await readFileBytes(root, '笔记.txt')).toEqual({
      kind: 'unsupported',
      size: Buffer.byteLength('纯文本\n')
    })
    expect(await readFileBytes(root, '空.png')).toEqual({ kind: 'unsupported', size: 0 })
    // 伪装成 png 的可执行文件：后缀认得、头不认 → 不画
    expect((await readFileBytes(root, '伪装.png')).kind).toBe('unsupported')
    // 换名的：后缀说 svg / html，内容不是 → 一样按不支持（文本族判据要真的对得上）
    writeFileSync(join(root, '其实是文本.svg'), '这不是矢量图\n')
    writeFileSync(join(root, '其实是图片.html'), PNG)
    expect((await readFileBytes(root, '其实是文本.svg')).kind).toBe('unsupported')
    expect((await readFileBytes(root, '其实是图片.html')).kind).toBe('unsupported')
  })

  it('文件没了回 missing（不抛）', async () => {
    expect(await readFileBytes(root, '没有这个.png')).toEqual({ kind: 'missing' })
    expect(await readFileBytes(root, '没有这个.docx')).toEqual({ kind: 'missing' })
  })

  it('目录抛人话（调用方按后缀路由，正常到不了）', async () => {
    await expect(readFileBytes(root, '目录.png')).rejects.toThrow(/文件夹/)
  })

  it('越界路径一律拒（fail closed）', async () => {
    await expect(readFileBytes(root, '../外部.png')).rejects.toThrow(/在工作区之外|路径不可用/)
    await expect(readFileBytes(root, outside)).rejects.toThrow(/在工作区之外|路径不可用/)
    await expect(readFileBytes(root, '\\\\server\\share\\a.png')).rejects.toThrow(/UNC|路径不可用/)
  })

  it('穿过符号链接的路径也拒', async () => {
    try {
      symlinkSync(outside, join(root, '链接'), 'junction')
    } catch {
      return
    }
    await expect(readFileBytes(root, '链接/外部.png')).rejects.toThrow(/在工作区之外/)
  })
})

describe('readFileBytes：办公三件与表格（抽结构那条路）', () => {
  it('docx → markdown；xlsx → 表；pptx → 文字提要；csv/tsv → 一张表', async () => {
    const docx = await readFileBytes(root, '方案.docx')
    expect(docx.kind).toBe('docx')
    if (docx.kind === 'docx') {
      expect(docx.markdown).toContain('正文一段')
      expect(docx.truncated).toBe(false)
    }

    const xlsx = await readFileBytes(root, '台账.xlsx')
    expect(xlsx.kind).toBe('xlsx')
    if (xlsx.kind === 'xlsx') {
      expect(xlsx.sheets).toEqual([
        {
          name: '汇总',
          rows: [
            ['项目', '金额'],
            ['房租', '1200']
          ],
          truncated: false
        }
      ])
      expect(xlsx.truncated).toBe(false)
    }

    const pptx = await readFileBytes(root, '汇报.pptx')
    expect(pptx.kind).toBe('pptx')
    if (pptx.kind === 'pptx') {
      expect(pptx.slides[0]).toEqual({ index: 1, lines: ['汇报'] })
      expect(pptx.truncated).toBe(false)
    }

    const csv = await readFileBytes(root, '名单.csv')
    // 表名取文件名（去后缀）
    expect(csv).toEqual({
      kind: 'xlsx',
      sheets: [
        {
          name: '名单',
          rows: [
            ['姓名', '年龄'],
            ['张三', '28']
          ],
          truncated: false
        }
      ],
      truncated: false
    })

    const tsv = await readFileBytes(root, '名单.tsv')
    expect(tsv.kind === 'xlsx' && tsv.sheets[0].rows[1]).toEqual(['张三', '28'])
  })

  it('后缀是办公档、内容不是（文本 / png）：按不支持走，不进解包', async () => {
    writeFileSync(join(root, '假的.docx'), '这就是一段文本')
    writeFileSync(join(root, '假的.xlsx'), PNG)
    writeFileSync(join(root, '假的.pptx'), '也不是 zip')
    writeFileSync(join(root, '假的.csv'), PNG)

    expect((await readFileBytes(root, '假的.docx')).kind).toBe('unsupported')
    expect((await readFileBytes(root, '假的.xlsx')).kind).toBe('unsupported')
    expect((await readFileBytes(root, '假的.pptx')).kind).toBe('unsupported')
    // csv 没有 magic：要求"不是别的已知二进制格式"
    expect((await readFileBytes(root, '假的.csv')).kind).toBe('unsupported')
  })

  it('zip 头对但包坏了：抛中文人话（能过两道闸的文件再读不通就是它坏了）', async () => {
    writeFileSync(join(root, '坏掉.pptx'), Buffer.from('PK\x03\x04乱码乱码', 'latin1'))
    await expect(readFileBytes(root, '坏掉.pptx')).rejects.toThrow(/读不出这个 PPT 文件/)
  })

  it('office 上限 32MB：超了 too-large（连字节都不传）', async () => {
    const name = '超大.xlsx'
    writeFileSync(
      join(root, name),
      Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(PREVIEW_OFFICE_MAX_BYTES + 1)])
    )

    const result = await readFileBytes(root, name)

    expect(result.kind).toBe('too-large')
    if (result.kind !== 'too-large') return
    expect(result.limit).toBe(PREVIEW_OFFICE_MAX_BYTES)
    expect(result.size).toBe(PREVIEW_OFFICE_MAX_BYTES + 5)
  })
})

describe('readFileBytes：按格式分桶的上限', () => {
  it('图片预览上限 = 30MB（round 53 起独立于发送口径的 8MB，别合并回去）', () => {
    expect(PREVIEW_IMAGE_MAX_BYTES).toBe(30 * 1024 * 1024)
  })

  it('图片超过 30MB → too-large（连字节都不传）', async () => {
    const name = '大图.png'
    const file = join(root, name)
    writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES)]))
    const result = await readFileBytes(root, name)
    expect(result.kind).toBe('too-large')
    if (result.kind !== 'too-large') return
    expect(result.limit).toBe(PREVIEW_IMAGE_MAX_BYTES)
    expect(result.size).toBe(PREVIEW_IMAGE_MAX_BYTES + PNG.length)
  })

  it('PDF / office 的上限更宽（32MB）：30MB 的 PDF 仍然读得回来', async () => {
    const name = '大报告.pdf'
    writeFileSync(join(root, name), Buffer.concat([PDF, Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES + 1)]))
    const result = await readFileBytes(root, name)
    expect(result.kind).toBe('bytes')
    expect(PREVIEW_PDF_MAX_BYTES).toBeGreaterThan(PREVIEW_IMAGE_MAX_BYTES)
    expect(PREVIEW_OFFICE_MAX_BYTES).toBe(PREVIEW_PDF_MAX_BYTES)
  })

  it('HTML 单独一档 8MB（比图片/PDF 紧：成本在清洗，不在传字节）', async () => {
    expect(PREVIEW_HTML_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(PREVIEW_HTML_MAX_BYTES).toBeLessThan(PREVIEW_IMAGE_MAX_BYTES)
    const name = '大页面.html'
    writeFileSync(join(root, name), Buffer.concat([HTML, Buffer.alloc(PREVIEW_HTML_MAX_BYTES)]))
    const result = await readFileBytes(root, name)
    expect(result.kind).toBe('too-large')
    if (result.kind !== 'too-large') return
    expect(result.limit).toBe(PREVIEW_HTML_MAX_BYTES)
    expect(result.size).toBe(PREVIEW_HTML_MAX_BYTES + HTML.length)
  })

  it('svg / ico 走图片那一档（8MB 的 svg 仍读得回来，不是 HTML 的紧上限）', async () => {
    const name = '大矢量图.svg'
    writeFileSync(join(root, name), Buffer.concat([SVG, Buffer.alloc(8 * 1024 * 1024 + 1)]))
    const result = await readFileBytes(root, name)
    expect(result.kind).toBe('bytes')
    if (result.kind !== 'bytes') return
    expect(result.format).toBe('image-svg')
  })
})

describe('readTableBytes / readFileBytes：表格那条路不被文本族判据吃掉（回归）', () => {
  it('带 `<` 的普通 csv：仍回原始字节（表）与抽好的结构，不被判成 HTML', async () => {
    writeFileSync(join(root, '带尖括号.csv'), 'a<b,c>d\n1,2\n')
    expect(sniffFormat(readFileSync(join(root, '带尖括号.csv')))).toBeNull()
    expect(await readTableBytes(root, '带尖括号.csv')).toMatchObject({
      kind: 'bytes',
      format: 'csv'
    })
    expect((await readFileBytes(root, '带尖括号.csv')).kind).toBe('xlsx')
  })

  it('名字是 .csv、内容是 HTML：表格那条路 fail closed（不给一份"表"）', async () => {
    writeFileSync(join(root, '其实是网页.csv'), HTML)
    expect(await readTableBytes(root, '其实是网页.csv')).toMatchObject({ kind: 'unsupported' })
    // read-bytes 那条路同样按不支持走（表路径要求"不是任何已知格式"，对不上就是 unsupported）
    expect((await readFileBytes(root, '其实是网页.csv')).kind).toBe('unsupported')
  })
})

describe('readTableBytes：表格原始字节通道（xls / xlsx / csv / tsv）', () => {
  /** 旧版 Office 的 OLE 复合文档头（xls 就靠它对暗号） */
  const OLE = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(24, 0x11)
  ])

  it('xls（OLE 头）回原始字节', async () => {
    writeFileSync(join(root, '旧台账.xls'), OLE)
    const result = await readTableBytes(root, '旧台账.xls')
    expect(result.kind).toBe('bytes')
    if (result.kind !== 'bytes') return
    expect(result.format).toBe('xls')
    expect(result.size).toBe(OLE.byteLength)
    expect(Buffer.from(result.bytes)).toEqual(OLE)
  })

  it('xlsx / csv / tsv 各自回原始字节（**不抽结构**，与 read-bytes 那条路分开）', async () => {
    const xlsx = await readTableBytes(root, '台账.xlsx')
    expect(xlsx.kind).toBe('bytes')
    if (xlsx.kind !== 'bytes') return
    expect(xlsx.format).toBe('xlsx')
    // 真的整份字节：与磁盘逐字节一致（不是抽好的表矩阵）
    const onDisk = readFileSync(join(root, '台账.xlsx'))
    expect(Buffer.from(xlsx.bytes)).toEqual(onDisk)
    expect(xlsx.size).toBe(onDisk.byteLength)

    const csv = await readTableBytes(root, '名单.csv')
    expect(csv.kind).toBe('bytes')
    if (csv.kind !== 'bytes') return
    expect(csv.format).toBe('csv')
    // BOM 原样保留（二进制就是二进制，解码是渲染端的事）
    expect(Buffer.from(csv.bytes).toString('utf8')).toBe('\uFEFF姓名,年龄\r\n张三,28\r\n')

    const tsv = await readTableBytes(root, '名单.tsv')
    expect(tsv).toMatchObject({ kind: 'bytes', format: 'tsv' })
  })

  it('后缀不在四种里：unsupported（不猜）', async () => {
    expect(await readTableBytes(root, '笔记.txt')).toMatchObject({ kind: 'unsupported' })
    expect(await readTableBytes(root, '方案.docx')).toMatchObject({ kind: 'unsupported' })
    expect(await readTableBytes(root, '报告.pdf')).toMatchObject({ kind: 'unsupported' })
  })

  it('文件头与后缀对不上：unsupported（改名的可执行 / 图片一律不进）', async () => {
    writeFileSync(join(root, '伪装.xls'), 'MZ\x90\x00')
    writeFileSync(join(root, '伪装.xlsx'), Buffer.from('not a zip', 'latin1'))
    writeFileSync(join(root, '伪装.csv'), PNG)
    for (const name of ['伪装.xls', '伪装.xlsx', '伪装.csv']) {
      expect(await readTableBytes(root, name), name).toMatchObject({ kind: 'unsupported' })
    }
  })

  it('空的 csv 也算一份（0 字节）', async () => {
    writeFileSync(join(root, '空表.csv'), '')
    const result = await readTableBytes(root, '空表.csv')
    expect(result).toMatchObject({ kind: 'bytes', format: 'csv', size: 0 })
  })

  it('文件没了回 missing；是目录抛人话；越权路径拒（fail closed）', async () => {
    expect(await readTableBytes(root, '没有.csv')).toEqual({ kind: 'missing' })
    await expect(readTableBytes(root, '目录.png')).rejects.toThrow(/这是一个文件夹/)
    await expect(readTableBytes(root, '../外面.csv')).rejects.toThrow(/路径不可用/)
    // 绝对路径（区外）同样拒：这条通道只认"相对会话根"
    await expect(readTableBytes(root, join(outside, '外部.png'))).rejects.toThrow(/路径不可用/)
  })

  it('超过 32MB 上限：too-large（连字节都不传，limit 就是那个上限）', async () => {
    const name = '巨大.csv'
    writeFileSync(
      join(root, name),
      Buffer.concat([Buffer.from('a,b\n'), Buffer.alloc(PREVIEW_TABLE_MAX_BYTES)])
    )
    const result = await readTableBytes(root, name)
    expect(result.kind).toBe('too-large')
    if (result.kind !== 'too-large') return
    expect(result.limit).toBe(PREVIEW_TABLE_MAX_BYTES)
    expect(result.size).toBe(PREVIEW_TABLE_MAX_BYTES + 4)
  })
})
