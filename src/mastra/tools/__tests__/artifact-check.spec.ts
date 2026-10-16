// @vitest-environment node
/**
 * 产出后结构自检（模块 4 加固 §C）的用例：
 *   - 三种真实产出（renderXlsx / renderPptx / renderDocx）走 `checkPackage` 全过，note 是统一口径；
 *   - **篡改条目地图**走纯检查层（`checkEntries`）：逐项独立、命中就是命中那一项；
 *   - **断言**（round 68）：页数 / 某页必需文本，不给断言时一条都不出（回执与老口径一致），
 *     给了而没过则点名"哪一条、差在哪"；页文本只看那一页的 slide 部件（图表与备注不算）；
 *   - **声明与关系**：每个 `.rels` 的 Target 都要落在包内；`[Content_Types].xml` 要覆盖所有部件
 *     （声明了却没落进包的只记 info，见用例）；
 *   - zip 损坏（截断丢 EOCD / 改中央目录 CRC / 改条目数据字节）→ `fatal` 或抛 CRC 错；
 *   - **外来容器的预检**：`readZipEntries(bytes, limits)` 给了上限才设限（不给就是老口径）；
 *     `assertOfficeArchiveSafe` 是固定 20000 条 / 单条 64MiB / 合计 256MiB 的那一份——声明先于解压
 *     校验、`maxOutputLength` 真卡住撒谎的声明、实际长度与累计都要对得上、重复条目名与越出包根拒。
 *     这组用例自己造 zip（`buildZip`，声明与事实可以分开指定），好写产出库造不出的坏形状；
 *   - PDF 只认 `%PDF-` 头与末尾 `%%EOF`。
 *
 * `assertOfficeArchiveSafe` 的"不保留内容"（解一条丢一条、不建条目表）是**结构性质**：它不返回
 * 条目，用例侧没法直接断言堆里没留东西，所以那条靠代码结构（`decodeEntry` 的结果只取 `.length`）
 * 保证，不在下面的用例里声称验过。
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  assertOfficeArchiveSafe,
  assertPackage,
  checkEntries,
  checkPackage,
  checkPdf,
  OFFICE_ARCHIVE_LIMITS,
  readZipEntries,
  type CheckItem,
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

function itemNamed(check: PackageCheck, name: string): CheckItem {
  const found = check.checks.find((item) => item.name.startsWith(name))
  if (found === undefined)
    throw new Error(`没有这项检查：${name}；实际：${check.checks.map((c) => c.name).join('、')}`)
  return found
}

/** 给 `[Content_Types].xml` 补一条 Override（造"部件存在且声明齐全"的样本用） */
function withOverride(xml: string, partName: string, contentType: string): string {
  return xml.replace(
    '</Types>',
    `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`
  )
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

/** 写进包里的一个部件：`payload` 是事实，`declared*` / `local*` 是两份声明里的说法（默认按事实给） */
interface ZipPart {
  name: string
  /** 写进包里的字节（stored = 原文；deflate = 压缩后的字节） */
  payload: Buffer
  /** 解压后的原文（deflate 时给；默认的声明值按它算） */
  original?: Buffer
  method: 0 | 8
  /** 中央目录里的标志位（局部头默认同值） */
  flags?: number
  /** 局部头单独的标志位（另给 = 造"两侧各说一套"的样本） */
  localFlags?: number
  /** 局部头单独的压缩方式 / 名字（另给 = 造两侧不一致） */
  localMethod?: number
  localName?: string
  /** 中央目录里的声明（另给 = 造"声明撒谎"的样本） */
  declaredSize?: number
  declaredCrc?: number
  declaredCompressedSize?: number
}

/** stored 部件（不压缩）：`text` 就是包里的字节 */
function stored(name: string, text: string, extra: Partial<ZipPart> = {}): ZipPart {
  return { name, method: 0, payload: Buffer.from(text, 'utf8'), ...extra }
}

/** deflated 部件（压缩）：声明默认按原文算 */
function deflated(name: string, original: Buffer, extra: Partial<ZipPart> = {}): ZipPart {
  return { name, method: 8, payload: deflateRawSync(original), original, ...extra }
}

/**
 * 造一份 zip：声明与事实分开填，所以"中央目录写 1KB / 实际 8MiB"、"EOCD 条数撒谎"、
 * "局部头与中央目录不一致"这些形状都能手写出来（产出库造不出这些，也不该造）。
 */
function buildZip(parts: readonly ZipPart[], declaredCount?: number): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const part of parts) {
    const source = part.original ?? part.payload
    const nameBytes = Buffer.from(part.name, 'utf8')
    const localNameBytes = Buffer.from(part.localName ?? part.name, 'utf8')

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // 需要的版本
    header.writeUInt16LE(part.localFlags ?? part.flags ?? 0, 6) // 标志位
    header.writeUInt16LE(part.localMethod ?? part.method, 8) // 压缩方式
    header.writeUInt32LE(part.declaredCrc ?? crc32(source), 14)
    header.writeUInt32LE(part.payload.length, 18) // 压缩后大小
    header.writeUInt32LE(part.declaredSize ?? source.length, 22) // 原始大小
    header.writeUInt16LE(localNameBytes.length, 26)
    local.push(header, localNameBytes, part.payload)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // 产出方版本
    entry.writeUInt16LE(20, 6) // 需要的版本
    entry.writeUInt16LE(part.flags ?? 0, 8) // 标志位
    entry.writeUInt16LE(part.method, 10) // 压缩方式
    entry.writeUInt32LE(part.declaredCrc ?? crc32(source), 16)
    entry.writeUInt32LE(part.declaredCompressedSize ?? part.payload.length, 20)
    entry.writeUInt32LE(part.declaredSize ?? source.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42) // 本地头偏移
    central.push(entry, nameBytes)

    offset += header.length + localNameBytes.length + part.payload.length
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(declaredCount ?? parts.length, 8)
  eocd.writeUInt16LE(declaredCount ?? parts.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16) // 中央目录起点
  return Buffer.concat([...local, ...central, eocd])
}

/** CRC32（IEEE，表驱动）——与产品侧校验用的同一套算法（夹具写入器不能自己算错） */
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

describe('checkPackage：三种真实产出物全过', () => {
  it('xlsx：六项检查全过，note 是统一口径', async () => {
    const bytes = await renderXlsx(XLSX_SHEETS)
    const result = checkPackage(bytes, { kind: 'xlsx', sheets: 2, texts: ['名称'] })

    expect(result.fatal).toBeUndefined()
    expect(result.checks.map((item) => item.name)).toEqual([
      '[Content_Types].xml 声明主部件',
      '[Content_Types].xml 声明与实际部件对得上',
      '主部件存在（xl/workbook.xml）',
      '关系引用都在包内（每个 .rels）',
      '工作表张数与声明一致',
      '关键文本在包内'
    ])
    expect(result.checks.every((item) => item.ok)).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('pptx：页数与封面标题都核得上', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    // 老形状现在是 封面 + 正文页（不再自动补结尾页）
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
      '[Content_Types].xml 声明与实际部件对得上',
      '主部件存在（word/document.xml）',
      '关系引用都在包内（每个 .rels）',
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

describe('断言：不给就不出，给了就逐条报（回执不静默）', () => {
  it('不给断言（或给空对象）：checks 里没有任何"断言"项，回执与老口径一致', async () => {
    const rendered = await renderPptx(PPT_INPUT)

    for (const withoutAssert of [
      { kind: 'pptx' as const, slides: rendered.slides },
      { kind: 'pptx' as const, slides: rendered.slides, assert: {} }
    ]) {
      const result = checkPackage(rendered.data, withoutAssert)
      expect(result.checks.filter((item) => item.name.startsWith('断言'))).toEqual([])
      expect(result.note).toBe('结构校验通过')
    }
  })

  it('页数断言与按页文本断言都过：note 是统一口径', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const result = checkPackage(rendered.data, {
      kind: 'pptx',
      slides: rendered.slides,
      assert: {
        count: 2,
        contains: [
          { page: 1, text: '季度汇报' },
          { page: 2, text: '结论' },
          // 圆点与正文是两个 run（`<a:t>●</a:t><a:t> 营收增长 12%</a:t>`）：按段落拼回才命中
          { page: 2, text: '营收增长 12%' }
        ]
      }
    })

    expect(result.checks.every((item) => item.ok)).toBe(true)
    expect(itemNamed(result, '断言：必须正好 2 页').ok).toBe(true)
    expect(itemNamed(result, '断言：第 2 页必须含「营收增长 12%」').ok).toBe(true)
    expect(result.note).toBe('结构校验通过')
  })

  it('页数不对 + 那页没有那句话：回执点名哪一条没过、差在哪（两条都报）', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const result = checkPackage(rendered.data, {
      kind: 'pptx',
      slides: rendered.slides,
      assert: {
        count: 6,
        contains: [
          // 这句话在第 2 页，用户要的是第 1 页 —— 详情要说清"在哪一页找到了"
          { page: 1, text: '营收增长 12%' },
          { page: 2, text: '这句压根没有' }
        ]
      }
    })

    expect(result.ok).toBe(false)
    expect(result.note).toContain('断言：必须正好 6 页（包内 2 页）')
    expect(result.note).toContain(
      '断言：第 1 页必须含「营收增长 12%」（不在第 1 页；第 2 页有这段文字）'
    )
    expect(result.note).toContain(
      '断言：第 2 页必须含「这句压根没有」（第 2 页没有这段文字；这一页的文字：'
    )
    // 断言不过**不拦落盘**：抛错只留给"连包都不是"的 fatal
    expect(() => assertPackage(result)).not.toThrow()
  })

  it('页号超出包内页数：如实报"包内只有几页"，不假装查过', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const result = checkPackage(rendered.data, {
      kind: 'pptx',
      assert: { contains: [{ page: 9, text: '季度汇报' }] }
    })

    expect(itemNamed(result, '断言：第 9 页必须含').detail).toBe('包内只有 2 页')
  })

  it('页文本断言只认那一页的 slide 部件：图表与演讲者备注里的字不算', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const entries = readZipEntries(rendered.data)
    // 备注与图表各塞一句独有标记（dsh 的 `--contains` 口径：这两处不算"这一页的文字"）
    entries.set(
      'ppt/notesSlides/notesSlide1.xml',
      Buffer.from(
        '<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:p><a:r><a:t>备注专用标记</a:t></a:r></a:p></p:spTree></p:cSld></p:notes>',
        'utf8'
      )
    )
    entries.set(
      'ppt/charts/chart1.xml',
      Buffer.from(
        '<c:chartSpace xmlns:c="c" xmlns:a="a"><a:p><a:r><a:t>图表专用标记</a:t></a:r></a:p></c:chartSpace>',
        'utf8'
      )
    )
    // 声明补齐图表部件：让"查不到"是**因为文本不算这一页**，而不是因为包不自洽
    entries.set(
      '[Content_Types].xml',
      Buffer.from(
        withOverride(
          zipText(entries, '[Content_Types].xml'),
          '/ppt/charts/chart1.xml',
          'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
        ),
        'utf8'
      )
    )

    for (const marker of ['备注专用标记', '图表专用标记']) {
      const result = checkEntries(entries, {
        kind: 'pptx',
        assert: { contains: [{ page: 1, text: marker }, { text: marker }] }
      })
      expect(itemNamed(result, `断言：第 1 页必须含「${marker}」`).ok).toBe(false)
      expect(itemNamed(result, `断言：必须有「${marker}」`).ok).toBe(false)
    }

    // 对照：老的"关键文本在包内"是**全包扫**（连备注/图表部件一起扫），两边口径的差别是有意为之
    const legacy = checkEntries(entries, { kind: 'pptx', texts: ['备注专用标记'] })
    expect(itemNamed(legacy, '关键文本在包内').ok).toBe(true)
  })

  it('xlsx：张数断言 + 整本工作簿的文本断言（限定工作表如实报不支持）', async () => {
    const bytes = await renderXlsx(XLSX_SHEETS)
    const entries = readZipEntries(bytes)

    const ok = checkEntries(entries, {
      kind: 'xlsx',
      assert: { count: 2, contains: [{ text: '下周再看' }] }
    })
    expect(ok.checks.every((item) => item.ok)).toBe(true)

    const bad = checkEntries(entries, {
      kind: 'xlsx',
      assert: { count: 3, contains: [{ page: 1, text: '名称' }] }
    })
    expect(itemNamed(bad, '断言：必须正好 3 张工作表').detail).toBe('包内 2 张工作表')
    expect(itemNamed(bad, '断言：工作簿里必须含').detail).toContain('不支持限定第 N 张表')
  })

  it('docx：只看正文部件（正文命中即过；页眉页脚那类别的部件不算）', async () => {
    const entries = readZipEntries(await renderDocx(DOCX_INPUT))

    const ok = checkEntries(entries, {
      kind: 'docx',
      assert: { contains: [{ text: '三步走完。' }] }
    })
    expect(ok.checks.every((item) => item.ok)).toBe(true)

    const bad = checkEntries(entries, {
      kind: 'docx',
      assert: { contains: [{ text: '这句没有' }] }
    })
    expect(itemNamed(bad, '断言：正文必须含「这句没有」').detail).toContain('word/document.xml')
  })

  it('docx 没有页数口径：如实报"没有这一项"，不假装通过', async () => {
    const entries = readZipEntries(await renderDocx(DOCX_INPUT))
    const result = checkEntries(entries, { kind: 'docx', assert: { count: 3 } })

    expect(itemNamed(result, '断言：件数').ok).toBe(false)
    expect(itemNamed(result, '断言：件数').detail).toContain('没有页数口径')
  })
})

describe('声明与关系：每个 .rels 都在包内，声明要覆盖所有部件', () => {
  it('少声明一个部件：声明项不过，并点名是哪个部件', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    const types = zipText(entries, '[Content_Types].xml')
    const without = types.replace(/<Override PartName="\/xl\/worksheets\/sheet2\.xml"[^>]*\/>/, '')
    expect(without).not.toBe(types)
    entries.set('[Content_Types].xml', Buffer.from(without, 'utf8'))

    const result = checkEntries(entries, { kind: 'xlsx' })

    const declared = itemNamed(result, '[Content_Types].xml 声明与实际部件对得上')
    expect(declared.ok).toBe(false)
    expect(declared.detail).toContain('xl/worksheets/sheet2.xml')
    // 主部件的声明还在：这两项各管各的
    expect(itemNamed(result, '[Content_Types].xml 声明主部件').ok).toBe(true)
  })

  it('声明了却没落进包：只记 info（实测 pptxgenjs 每份都多声明几个 slideMaster），不判不过、不进回执', async () => {
    const result = checkPackage((await renderPptx(PPT_INPUT)).data, { kind: 'pptx' })

    const declared = itemNamed(result, '[Content_Types].xml 声明与实际部件对得上')
    expect(declared.ok).toBe(true)
    expect(declared.info).toContain('slideMaster')
    expect(declared.info).toContain('不影响打开')
    expect(result.note).toBe('结构校验通过')
  })

  it('非根 rels 的悬空 Target 也报（不止 _rels/.rels）', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const entries = readZipEntries(rendered.data)
    const part = 'ppt/slides/_rels/slide2.xml.rels'
    const rels = zipText(entries, part)
    entries.set(
      part,
      Buffer.from(
        rels.replace(
          '</Relationships>',
          '<Relationship Id="rDangling" Type="x" Target="../../../outside.xml"/></Relationships>'
        ),
        'utf8'
      )
    )

    const result = checkEntries(entries, { kind: 'pptx' })

    const relItem = itemNamed(result, '关系引用都在包内')
    expect(relItem.ok).toBe(false)
    expect(relItem.detail).toContain('ppt/slides/_rels/slide2.xml.rels')
    expect(relItem.detail).toContain('../../../outside.xml')
  })
})

describe('checkEntries：篡改条目地图，逐项命中', () => {
  it('缺 [Content_Types].xml：只有这一项失败，note 点它的名（带原因）', async () => {
    const entries = readZipEntries(await renderXlsx(XLSX_SHEETS))
    entries.delete('[Content_Types].xml')

    const result = checkEntries(entries, { kind: 'xlsx', sheets: 2 })

    expect(failedNames(result)).toEqual(['[Content_Types].xml 声明主部件'])
    expect(itemNamed(result, '[Content_Types].xml 声明主部件').detail).toContain('没有')
    expect(result.note).toBe(
      '结构校验未通过：[Content_Types].xml 声明主部件（包内没有 [Content_Types].xml）'
    )
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

  it('少一页 slide：页数项失败（presentation.xml.rels 也悬空了，两条都报）', async () => {
    const rendered = await renderPptx(PPT_INPUT)
    const entries = readZipEntries(rendered.data)
    entries.delete('ppt/slides/slide2.xml')

    const result = checkEntries(entries, { kind: 'pptx', slides: rendered.slides })

    expect(failedNames(result)).toEqual(['关系引用都在包内（每个 .rels）', '幻灯片页数与声明一致'])
    expect(itemNamed(result, '幻灯片页数').detail).toContain('包内 1 页，期望 2 页')
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
      '[Content_Types].xml 声明与实际部件对得上',
      '主部件存在（xl/workbook.xml）',
      '关系引用都在包内（每个 .rels）'
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

describe('readZipEntries(bytes, limits)：给了上限才设限（不给就是老口径）', () => {
  const LIMITS = { maxEntries: 100, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }

  it('真实产出物：不给 limits 与给 OFFICE_ARCHIVE_LIMITS 读到的是同一份条目（预检不误报）', async () => {
    const bytes = await renderXlsx(XLSX_SHEETS)
    const legacy = readZipEntries(bytes)
    const bounded = readZipEntries(bytes, OFFICE_ARCHIVE_LIMITS)

    expect([...bounded.keys()]).toEqual([...legacy.keys()])
    for (const [name, data] of legacy) expect(bounded.get(name)?.equals(data)).toBe(true)
  })

  it('单条上限：声明超了就在解压前拒（压缩数据是垃圾也不该走到"解压失败"）', () => {
    const bytes = buildZip([
      { name: 'a.bin', method: 8, payload: Buffer.from([1, 2, 3]), declaredSize: 2 * 1024 * 1024 }
    ])

    expect(() => readZipEntries(bytes, LIMITS)).toThrow(/单条上限/)
    expect(() => readZipEntries(bytes, LIMITS)).not.toThrow(/解压失败/)
  })

  it('单条上限：声明撒谎（写 1KB、实际 8MiB）→ maxOutputLength 真卡住', () => {
    const bytes = buildZip([
      deflated('boom.bin', Buffer.alloc(8 * 1024 * 1024), { declaredSize: 1024 })
    ])

    expect(() => readZipEntries(bytes, LIMITS)).toThrow(/单条上限/)
  })

  it('累计上限：单条都不超、加起来超了 → 拒；边界内则过', () => {
    const parts = ['a', 'b', 'c'].map((name) => stored(`${name}.txt`, 'x'.repeat(1024)))
    const bytes = buildZip(parts)

    expect(() => readZipEntries(bytes, { maxEntryBytes: 2048, maxTotalBytes: 3000 })).toThrow(
      /累计/
    )
    expect([...readZipEntries(bytes, { maxEntryBytes: 2048, maxTotalBytes: 4000 }).keys()]).toEqual(
      ['a.txt', 'b.txt', 'c.txt']
    )
  })

  it('累计比单条更紧时按累计卡（maxOutputLength 取两个上限里更紧的那个）', () => {
    const bytes = buildZip([deflated('grow.bin', Buffer.alloc(4096), { declaredSize: 512 })])

    expect(() =>
      readZipEntries(bytes, { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 })
    ).toThrow(/累计/)
  })

  it('实际长度与声明对不上：有上限就拒，没上限照旧不查（向后兼容）', () => {
    const bytes = buildZip([
      { name: 'short.bin', method: 0, payload: Buffer.from('abc', 'utf8'), declaredSize: 10 }
    ])

    expect(readZipEntries(bytes).get('short.bin')?.toString('utf8')).toBe('abc')
    expect(() => readZipEntries(bytes, LIMITS)).toThrow(/与声明对不上/)
  })

  it('重复条目名：有上限就拒（老口径是后者覆盖前者——正是要防的绕过形状）', () => {
    const bytes = buildZip([stored('xl/a.xml', '先写的'), stored('xl/a.xml', '后写的')])

    expect(readZipEntries(bytes).get('xl/a.xml')?.toString('utf8')).toBe('后写的')
    expect(() => readZipEntries(bytes, LIMITS)).toThrow(/重复条目名/)
  })

  it('同一路径的不同写法（./xl/a.xml 与 xl/a.xml）也算重复', () => {
    const bytes = buildZip([stored('xl/a.xml', 'one'), stored('./xl/a.xml', 'two')])

    expect(readZipEntries(bytes).size).toBe(2)
    expect(() => readZipEntries(bytes, LIMITS)).toThrow(/重复条目名/)
  })

  it('越出包根（../x）与空名：拒', () => {
    expect(() => readZipEntries(buildZip([stored('../x.txt', 'x')]), LIMITS)).toThrow(/越出包根/)
    expect(() => readZipEntries(buildZip([stored('', 'x')]), LIMITS)).toThrow(/没名字/)
  })

  it('加密：中央目录标了就拒（老口径也拒）；只标在局部头的，有上限才拒', () => {
    expect(() => readZipEntries(buildZip([stored('a.txt', 'x', { flags: 1 })]))).toThrow(/加密/)

    const localOnly = buildZip([stored('a.txt', 'x', { localFlags: 1 })])
    expect(readZipEntries(localOnly).has('a.txt')).toBe(true)
    expect(() => readZipEntries(localOnly, LIMITS)).toThrow(/加密/)
  })

  it('两侧声明不一致（局部头的名字 / 压缩方式）：有上限就拒', () => {
    expect(() =>
      readZipEntries(buildZip([stored('a.txt', 'x', { localName: 'b.txt' })]), LIMITS)
    ).toThrow(/局部头名字/)
    expect(() =>
      readZipEntries(buildZip([stored('a.txt', 'x', { localMethod: 8 })]), LIMITS)
    ).toThrow(/压缩方式/)
  })

  it('条数撒谎（EOCD 记 1 条、中央目录里 2 条）：有上限就拒，老口径只读 1 条', () => {
    const two = [stored('a.txt', 'x'), stored('b.txt', 'y')]

    expect(readZipEntries(buildZip(two, 1)).size).toBe(1)
    expect(() => readZipEntries(buildZip(two, 1), LIMITS)).toThrow(/条数与实际不符/)
  })
})

describe('assertOfficeArchiveSafe：外来文件的固定口径（20000 条 / 64MiB / 256MiB）', () => {
  it('三个固定上限就是拍板的那个数', () => {
    expect(OFFICE_ARCHIVE_LIMITS).toEqual({
      maxEntries: 20_000,
      maxEntryBytes: 64 * 1024 * 1024,
      maxTotalBytes: 256 * 1024 * 1024
    })
  })

  it('真实产出物与手写 zip 都过：预检不拦正经文件', async () => {
    const files = [
      await renderXlsx(XLSX_SHEETS),
      (await renderPptx(PPT_INPUT)).data,
      await renderDocx(DOCX_INPUT),
      buildZip([
        stored('[Content_Types].xml', '<Types/>'),
        deflated('word/document.xml', Buffer.from('<w:document/>', 'utf8'))
      ])
    ]

    for (const bytes of files) expect(() => assertOfficeArchiveSafe(bytes)).not.toThrow()
  })

  it('声明解压后 70MiB（超 64MiB 单条）：拒，且是解压之前就拒（压缩数据是垃圾也只报上限）', () => {
    const bytes = buildZip([
      {
        name: 'huge.bin',
        method: 8,
        payload: Buffer.from([9, 9, 9]),
        declaredSize: 70 * 1024 * 1024
      }
    ])

    expect(() => assertOfficeArchiveSafe(bytes)).toThrow(/单条上限/)
    expect(() => assertOfficeArchiveSafe(bytes)).not.toThrow(/解压失败/)
  })

  it('累计声明超 256MiB：拒（前四条各 60MiB 都合法，第五条把总和推到 300MiB），且是解压之前就拒', () => {
    // 算术：head.txt(1) + 4×60MiB = 240MiB+1 **还没到** 256MiB —— 只造四条永远进不了累计那一支，
    // 会掉到解压后的"声明对不上"（旧夹具就是这么红的：那条断言其实测不到累计）。**五条** 60MiB
    // 才把总和推到 300MiB+1。载荷一律 2 字节（声明 60MiB）：真去解压会立刻报"对不上"，
    // 所以下面第二条断言正是"整目录声明先查完、再 inflate"的证据。
    const parts: ZipPart[] = [stored('head.txt', 'x')]
    for (let index = 0; index < 5; index++) {
      parts.push({
        name: `big${index}.bin`,
        method: 0,
        payload: Buffer.from('xx', 'utf8'),
        declaredSize: 60 * 1024 * 1024
      })
    }

    expect(() => assertOfficeArchiveSafe(buildZip(parts))).toThrow(/累计/)
    expect(() => assertOfficeArchiveSafe(buildZip(parts))).not.toThrow(/对不上/)
  })

  it('条目数：20000 条放行、20001 条拒（固定上限的边界）', () => {
    const many = (count: number): ZipPart[] =>
      Array.from({ length: count }, (_, index) => stored(`f${index}.txt`, ''))

    expect(() => assertOfficeArchiveSafe(buildZip(many(20_000)))).not.toThrow()
    expect(() => assertOfficeArchiveSafe(buildZip(many(20_001)))).toThrow(/条目数/)
  })

  it('损坏的包（截断 / 改中央目录 CRC / 改条目数据字节）：拒', async () => {
    const bytes = Buffer.from(await renderXlsx(XLSX_SHEETS))

    expect(() => assertOfficeArchiveSafe(bytes.subarray(0, bytes.length - 64))).toThrow()

    const badCrc = Buffer.from(bytes)
    badCrc[firstEntryLayout(badCrc).crcOffset] ^= 0xff
    expect(() => assertOfficeArchiveSafe(badCrc)).toThrow(/CRC32 校验失败/)

    const badData = Buffer.from(bytes)
    const layout = firstEntryLayout(badData)
    badData[layout.dataStart + Math.floor(layout.compressedSize / 2)] ^= 0xff
    expect(() => assertOfficeArchiveSafe(badData)).toThrow(/解压失败|CRC32 校验失败|与声明对不上/)
  })

  it('zip64 哨兵：拒（继承老口径）', () => {
    const bytes = Buffer.from(buildZip([stored('a.txt', 'x')]))
    bytes.writeUInt16LE(0xffff, eocdOffset(bytes) + 10)

    expect(() => assertOfficeArchiveSafe(bytes)).toThrow(/zip64/)
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
