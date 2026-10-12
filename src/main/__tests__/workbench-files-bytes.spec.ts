// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderDocx } from '../../mastra/tools/docx'
import { renderXlsx } from '../../mastra/tools/excel'
import { renderPptx } from '../../mastra/tools/ppt'
import {
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_PDF_MAX_BYTES
} from '../../shared/workbench'
import { readFileBytes, sniffFormat } from '../workbench-files'

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-outside-'))
  mkdirSync(join(root, '目录.png'))
  writeFileSync(join(root, '图片.png'), PNG)
  writeFileSync(join(root, '照片.JPG'), JPG)
  writeFileSync(join(root, '动图.gif'), GIF)
  writeFileSync(join(root, '新格式.webp'), WEBP)
  writeFileSync(join(root, '位图.bmp'), BMP)
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
  it('六种认得出来的格式各自对号', () => {
    expect(sniffFormat(PDF)).toBe('pdf')
    expect(sniffFormat(PNG)).toBe('image-png')
    expect(sniffFormat(JPG)).toBe('image-jpeg')
    expect(sniffFormat(GIF)).toBe('image-gif')
    expect(sniffFormat(WEBP)).toBe('image-webp')
    expect(sniffFormat(BMP)).toBe('image-bmp')
  })

  it('zip 头归成 ooxml（docx/xlsx/pptx 同一个头，光看字节分不出是哪件）', () => {
    expect(sniffFormat(Buffer.from('PK\x03\x04rest', 'latin1'))).toBe('ooxml')
    expect(sniffFormat(Buffer.from('PK\x05\x06rest', 'latin1'))).toBe('ooxml')
  })

  it('认不出的头（含空文件、文本）给 null', () => {
    expect(sniffFormat(Buffer.alloc(0))).toBeNull()
    expect(sniffFormat(Buffer.from('hello', 'latin1'))).toBeNull()
    expect(sniffFormat(Buffer.from('姓名,年龄\r\n', 'utf8'))).toBeNull()
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
  it('六种字节格式：回字节 + 格式 + 大小（字节是真的）', async () => {
    const cases: Array<[string, string, Buffer]> = [
      ['图片.png', 'image-png', PNG],
      ['照片.JPG', 'image-jpeg', JPG],
      ['动图.gif', 'image-gif', GIF],
      ['新格式.webp', 'image-webp', WEBP],
      ['位图.bmp', 'image-bmp', BMP],
      ['报告.pdf', 'pdf', PDF]
    ]
    for (const [name, format, source] of cases) {
      const result = await readFileBytes(root, name)
      expect(result.kind).toBe('bytes')
      if (result.kind !== 'bytes') continue
      expect(result.format).toBe(format)
      expect(result.size).toBe(source.length)
      expect(Buffer.from(result.bytes)).toEqual(source)
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
})
