// @vitest-environment node
/**
 * 产出后结构自检（模块 4 加固 §C）的用例：
 *   - 三种真实产出（renderXlsx / renderPptx / renderDocx）走 `checkPackage` 全过，note 是统一口径；
 *   - **篡改条目地图**走纯检查层（`checkEntries`）：逐项独立、命中就是命中那一项；
 *   - zip 损坏（截断丢 EOCD / 改中央目录 CRC / 改条目数据字节）→ `fatal` 或抛 CRC 错；
 *   - PDF 只认 `%PDF-` 头与末尾 `%%EOF`。
 */
import { describe, expect, it } from 'vitest'
import {
  assertPackage,
  checkEntries,
  checkPackage,
  checkPdf,
  readZipEntries,
  type PackageCheck
} from '../artifact-check'
import { renderDocx } from '../docx'
import { renderXlsx } from '../excel'
import { renderPptx } from '../ppt'
import { zipText } from './zip'

const XLSX_SHEETS = [
  {
    name: '销量',
    rows: [
      ['名称', '数量'],
      ['甲', 42]
    ]
  },
  { name: '备注', rows: [['下周再看']] }
]

const PPT_INPUT = {
  title: '季度汇报',
  slides: [{ title: '结论', bullets: ['营收增长 12%'] }]
}

const DOCX_INPUT = {
  title: '实施方案',
  blocks: [
    { type: 'heading' as const, text: '目标', level: 2 },
    { type: 'paragraph' as const, text: '三步走完。' }
  ]
}

function failedNames(check: PackageCheck): string[] {
  return check.checks.filter((item) => !item.ok).map((item) => item.name)
}

function itemNamed(check: PackageCheck, name: string): { ok: boolean; detail?: string } {
  const found = check.checks.find((item) => item.name.startsWith(name))
  if (found === undefined)
    throw new Error(`没有这项检查：${name}；实际：${check.checks.map((c) => c.name).join('、')}`)
  return found
}

/** EOCD 的签名位置（篡改用例定位用） */
function eocdOffset(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('这份字节里找不到 EOCD，用例的前提不成立')
}

/** 中央目录里第一条的核心字段（篡改用例定位 CRC 与条目数据） */
function firstEntryLayout(zip: Buffer): {
  crcOffset: number
  dataStart: number
  compressedSize: number
  name: string
} {
  const centralOffset = zip.readUInt32LE(eocdOffset(zip) + 16)
  const nameLength = zip.readUInt16LE(centralOffset + 28)
  const localOffset = zip.readUInt32LE(centralOffset + 42)
  const localNameLength = zip.readUInt16LE(localOffset + 26)
  const localExtraLength = zip.readUInt16LE(localOffset + 28)
  return {
    crcOffset: centralOffset + 16,
    dataStart: localOffset + 30 + localNameLength + localExtraLength,
    compressedSize: zip.readUInt32LE(centralOffset + 20),
    name: zip.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength)
  }
}

describe('checkPackage：三种真实产出物全过', () => {
  it('xlsx：五项检查全过，note 是统一口径', async () => {
    const bytes = await renderXlsx(XLSX_SHEETS)
    const result = checkPackage(bytes, { kind: 'xlsx', sheets: 2, texts: ['名称'] })

    expect(result.fatal).toBeUndefined()
    expect(result.checks.map((item) => item.name)).toEqual([
      '[Content_Types].xml 声明主部件',
      '主部件存在（xl/workbook.xml）',
      '关系引用都在包内（_rels/.rels）',
      '工作表张数与声明一致',
      '关键文本在包内'
    ])
    expect(result.checks.every((item) => item.ok)).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('pptx：页数与封面标题都核得上', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    expect(rendered.slides).toBe(2)

    const result = checkPackage(rendered.data, {
      kind: 'pptx',
      slides: rendered.slides,
      texts: ['季度汇报']
    })

    expect(result.fatal).toBeUndefined()
    expect(result.checks.every((item) => item.ok)).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('docx：主部件与样本文本都在', async () => {
    const bytes = await renderDocx(DOCX_INPUT)
    const result = checkPackage(bytes, { kind: 'docx', texts: ['实施方案'] })

    expect(result.fatal).toBeUndefined()
    expect(result.checks.map((item) => item.name)).toEqual([
      '[Content_Types].xml 声明主部件',
      '主部件存在（word/document.xml）',
      '关系引用都在包内（_rels/.rels）',
      '关键文本在包内'
    ])
    expect(result.ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('文本样本按 XML 转义形态认（& < > 两种形式任一命中即过）', async () => {
    const bytes = await renderXlsx([{ name: 'S', rows: [['A & B <3>']] }])
    const result = checkPackage(bytes, { kind: 'xlsx', texts: ['A & B <3>'] })

    expect(result.ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('不是 zip 容器：给 fatal（不是"某项不过"）', () => {
    const result = checkPackage(Buffer.from('这不是 zip，是一段普通文本', 'utf8'), { kind: 'xlsx' })

    expect(result.fatal).toBe('这不是一个 zip 容器（找不到中央目录结尾）')
    expect(result.checks).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.note).toContain('结构校验未通过')
    expect(() => assertPackage(result)).toThrow(/产出物生成失败：结构自检没通过/)
  })
})

describe('checkEntries：篡改条目地图，逐项命中', () => {
  it('缺 [Content_Types].xml：只有这一项失败，note 点它的名', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    entries.delete('[Content_Types].xml')

    const result = checkEntries(entries, { kind: 'xlsx', sheets: 2 })

    expect(failedNames(result)).toEqual(['[Content_Types].xml 声明主部件'])
    expect(itemNamed(result, '[Content_Types].xml 声明主部件').detail).toContain('没有')
    expect(result.note).toBe('结构校验未通过：[Content_Types].xml 声明主部件')
  })

  it('缺主部件：主部件项失败（rels 悬空也跟着报）', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    entries.delete('xl/workbook.xml')

    const result = checkEntries(entries, { kind: 'xlsx' })

    expect(itemNamed(result, '主部件存在').ok).toBe(false)
    expect(itemNamed(result, '[Content_Types].xml').ok).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('rels 指向包外：关系项失败并点出悬空的 Target', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    const rels = zipText(entries, '_rels/.rels')
    entries.set(
      '_rels/.rels',
      Buffer.from(
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rDangling" Type="x" Target="xl/nope.xml"/></Relationships>'
        ),
        'utf8'
      )
    )

    const result = checkEntries(entries, { kind: 'xlsx' })

    const relItem = itemNamed(result, '关系引用都在包内')
    expect(relItem.ok).toBe(false)
    expect(relItem.detail).toContain('xl/nope.xml')
  })

  it('少一张表：张数项失败（其余项仍过）', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    const workbook = zipText(entries, 'xl/workbook.xml')
    const tampered = workbook.replace(/<sheet\b[^>]*\/>/, '')
    expect(tampered).not.toBe(workbook)
    entries.set('xl/workbook.xml', Buffer.from(tampered, 'utf8'))

    const result = checkEntries(entries, { kind: 'xlsx', sheets: 2 })

    expect(failedNames(result)).toEqual(['工作表张数与声明一致'])
    expect(itemNamed(result, '工作表张数').detail).toContain('期望 2 张')
  })

  it('少一页 slide：页数项失败', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const entries = readZipEntries(rendered.data)
    entries.delete('ppt/slides/slide2.xml')

    const result = checkEntries(entries, { kind: 'pptx', slides: rendered.slides })

    expect(failedNames(result)).toEqual(['幻灯片页数与声明一致'])
    expect(itemNamed(result, '幻灯片页数').detail).toContain('包内 1 页')
  })

  it('样本文本不在包内：文本项失败并列出来', async () => {
    const entries = readZipEntries(await renderDocx(DOCX_INPUT))
    const result = checkEntries(entries, { kind: 'docx', texts: ['这句话不在文档里'] })

    expect(failedNames(result)).toEqual(['关键文本在包内'])
    expect(itemNamed(result, '关键文本').detail).toContain('这句话不在文档里')
  })

  it('不给期望值就不出对应检查项（不臆测）', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    const result = checkEntries(entries, { kind: 'xlsx' })

    expect(result.checks.map((item) => item.name)).toEqual([
      '[Content_Types].xml 声明主部件',
      '主部件存在（xl/workbook.xml）',
      '关系引用都在包内（_rels/.rels）'
    ])
    expect(result.ok).toBe(true)
  })
})

describe('readZipEntries：损坏的 zip 一律中文报错', () => {
  it('截断（丢 EOCD）：checkPackage 给 fatal，readZipEntries 抛错', async () => {
    const bytes = await renderXlsx(XLSX_SHEETS)
    const truncated = bytes.subarray(0, bytes.length - 64)

    expect(() => readZipEntries(truncated)).toThrow()
    const result = checkPackage(truncated, { kind: 'xlsx', sheets: 2 })
    expect(result.fatal).toBeDefined()
    expect(result.ok).toBe(false)
    expect(() => assertPackage(result)).toThrow(/结构自检没通过/)
  })

  it('改中央目录里的 CRC：抛 CRC32 校验失败', async () => {
    const bytes = Buffer.from(await renderXlsx(XLSX_SHEETS))
    const layout = firstEntryLayout(bytes)
    bytes[layout.crcOffset] ^= 0xff

    expect(() => readZipEntries(bytes)).toThrow(/CRC32 校验失败/)
  })

  it('改条目的数据字节：解压失败或 CRC 校验失败', async () => {
    const bytes = Buffer.from(await renderXlsx(XLSX_SHEETS))
    const layout = firstEntryLayout(bytes)
    expect(layout.compressedSize).toBeGreaterThan(2)
    bytes[layout.dataStart + Math.floor(layout.compressedSize / 2)] ^= 0xff

    expect(() => readZipEntries(bytes)).toThrow(/解压失败|CRC32 校验失败/)
  })
})

describe('checkPdf：头与尾', () => {
  it('最小合法样本：过，note 统一口径', () => {
    const result = checkPdf(Buffer.from('%PDF-1.4\n1 0 obj\nendobj\n%%EOF\n', 'utf8'))

    expect(result.ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('头不对 / 末尾没有 %%EOF：不过且给中文原因', () => {
    const noHead = checkPdf(Buffer.from('<html>不是 PDF</html>', 'utf8'))
    expect(noHead.ok).toBe(false)
    expect(noHead.reason).toContain('%PDF-')
    expect(noHead.note).toContain('结构校验未通过')

    const noTrailer = checkPdf(Buffer.from('%PDF-1.4\n1 0 obj\n', 'utf8'))
    expect(noTrailer.ok).toBe(false)
    expect(noTrailer.reason).toContain('%%EOF')
  })
})
