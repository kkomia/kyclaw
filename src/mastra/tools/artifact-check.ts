/**
 * 产出后**结构自检**（check_office 的 TS 形态）：落盘前真解包看一眼容器结构，逐项出 JSON verdict。
 *
 * 为什么要有这一层：xlsx/pptx/docx 是 zip 容器（OOXML 部件打包），"库写成功了"不等于"PowerPoint/Excel
 * 打得开"——`[Content_Types].xml` 少声明一条、主部件路径写歪、rels 指到包外，都是"能落盘、打不开"的坑。
 * 这里做的是**独立于产出库**的读侧校验（自己解 zip、自己核 CRC），所以它证明的是"按 OOXML 规矩落的盘"，
 * 而不是"某个库自己认自己"。
 *
 * 两层口径：
 *   - **结构自检**（永远跑，不给任何期望值时只有固定的那几项）：部件声明、主部件、关系引用、CRC……
 *     结论是"这个包按规矩装好了没有"。
 *   - **断言**（`expect.assert`，只在你/用户提了硬要求时给）：页数是不是正好 N、第 K 页有没有这句话。
 *     结论是"你答应用户的事办到了没有"——用户说"必须 6 页""这页必须有这句话"时，别靠模型自己数。
 *
 * 检查项清单的**设计**参照 DeepSeek Harness 的 `check_office.py`（MIT，DeepSeek 自研）：页数 /
 * 某页必需文本（**排除图表文本与演讲者备注**）/ 部件声明与关系一致性这一组检查项是照它的清单列的；
 * **实现是按 TS 重写的**（自解 zip + 逐项 verdict），没有引入它的代码，措辞也是我们自己的。
 * 第三方来源的登记口径见 `resources/skills/THIRD_PARTY_NOTICES.md`。
 *
 * 分层（测试直接构造/篡改 `Map<string, Buffer>` 走纯检查层，不必造 zip）：
 *   - `readZipEntries`：字节 → 条目表（EOCD 扫描 + 中央目录 + 局部头核对 + inflateRaw + CRC32），失败一律中文；
 *   - `checkEntries`：条目表 → `{ checks, ok, note }`（纯函数，逐项独立）；
 *   - `checkPackage`：字节 → 读包（读不通给 `fatal`）→ `checkEntries`；
 *   - `checkPdf`：PDF 没有包结构，只认 `%PDF-` 头与末尾 `%%EOF`。
 *
 * 范围与三个产出库的现状一致：zip32（zip64/加密直接报错）、条目名 ASCII/UTF-8、压缩方式 store/deflate。
 */
import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL_ENTRY = 0x02014b50
const ZIP_LOCAL_HEADER = 0x04034b50
/** EOCD 的位置在最末尾 22 字节 + 最多 65535 字节注释之内 */
const EOCD_SEARCH_BYTES = 65_557
/** zip64 的哨兵值：我们不支持（三个产出库产出的都是 zip32） */
const ZIP64_COUNT_SENTINEL = 0xffff
const ZIP64_OFFSET_SENTINEL = 0xffffffff

const CONTENT_TYPES = '[Content_Types].xml'
const ROOT_RELS = '_rels/.rels'

/** 详情里最多列几条（坏包可能一次坏很多，回执要留给上下文） */
const DETAIL_ITEMS = 5
/** 断言不过时回显的页内文字上限（一页可能几百字，只给一段让人认得出是哪一页） */
const DETAIL_TEXT_CHARS = 120
/** 断言名字里回显的用户文字上限（长句断言只在详情里点名） */
const ASSERT_TEXT_CHARS = 30

export type PackageKind = 'xlsx' | 'pptx' | 'docx'

/** 每种 OOXML 格式的固定件：主部件路径 + 主部件的 content-type 声明 */
const KINDS: Record<PackageKind, { primary: string; contentType: string }> = {
  xlsx: {
    primary: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  },
  pptx: {
    primary: 'ppt/presentation.xml',
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
  },
  docx: {
    primary: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  }
}

/** pptx 的一页一条 slide 部件 */
const SLIDE_ENTRY = /^ppt\/slides\/slide(\d+)\.xml$/

/** 一项检查的结果：名字是中文、ok 是判定、detail（仅在不过时给）是排障线索 */
export interface CheckItem {
  name: string
  ok: boolean
  detail?: string
  /**
   * 通过、但有话要说的发现（不参与 ok 判定、不进回执）：如"声明了却没落进包的部件"。
   * 与 detail 分开的理由：detail 是"哪里没过必须改"，info 是"看了一眼，不影响打开"——
   * 混在一起会让每份正常产出物的回执都挂一条噪音。
   */
  info?: string
}

/** 一条文本断言：`page` 给了就限定那一件（pptx 第 N 页，1 起、含封面），不给就是"整包任意处" */
export interface PackageTextAssert {
  page?: number
  text: string
}

/** 断言：用户/模型点名过、必须成立的那些事（不给就完全不出这几项检查） */
export interface PackageAssert {
  /** 件数必须正好这么多：pptx = 幻灯片页数（含封面）、xlsx = 工作表张数 */
  count?: number
  /** 文本必须出现（见 PackageTextAssert 的限定口径） */
  contains?: readonly PackageTextAssert[]
}

export interface PackageExpect {
  kind: PackageKind
  /** xlsx：期望的工作表张数（不给就不查这一项） */
  sheets?: number
  /** pptx：期望的幻灯片页数（不给就不查这一项） */
  slides?: number
  /** 样本文本：给了就查"这些文本在包内"（原文或 XML 转义任一命中即过） */
  texts?: readonly string[]
  /** 硬要求（用户提过的页数 / 必须有的话）：见 PackageAssert */
  assert?: PackageAssert
}

export interface PackageCheck {
  /** zip 根本没读通：不是"某项不过"，是"连包都不是" */
  fatal?: string
  checks: CheckItem[]
  ok: boolean
  note: string
}

export interface PdfCheck {
  ok: boolean
  note: string
  /** 不过时的中文原因（调用方拿去抛错） */
  reason?: string
}

/** 自检通过时的统一口径（回执尾部拼的就是它） */
export const CHECK_PASSED = '结构校验通过'

/** zip 读不通时抛的错（工具层据此"抛错不落盘"） */
export function assertPackage(check: PackageCheck): void {
  if (check.fatal !== undefined) {
    throw new Error(`产出物生成失败：结构自检没通过（${check.fatal}）`)
  }
}

/**
 * 解包成 `条目名 → 解压后的字节`（顺序即中央目录顺序）。
 * 每一步都对不上就抛中文错：没有 EOCD / 中央目录签名不对 / 局部头签名不对 / 数据越界 /
 * 不支持的压缩方式 / 解压失败 / CRC32 不符。
 */
export function readZipEntries(bytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(bytes)
  const eocd = findEndOfCentralDirectory(zip)

  const count = zip.readUInt16LE(eocd + 10)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  if (count === ZIP64_COUNT_SENTINEL || centralOffset === ZIP64_OFFSET_SENTINEL) {
    throw new Error('这是 zip64 容器（暂不支持）：请用常规 zip 重新导出')
  }

  const entries = new Map<string, Buffer>()
  let offset = centralOffset

  for (let index = 0; index < count; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== ZIP_CENTRAL_ENTRY) {
      throw new Error(`zip 中央目录第 ${index + 1} 条的签名不对（offset=${offset}）`)
    }
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const expectedCrc = zip.readUInt32LE(offset + 16)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)

    if ((flags & 0x0001) !== 0) throw new Error(`条目 ${name} 是加密的（暂不支持加密 zip）`)

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
      throw new Error(`条目 ${name} 的局部头签名不对（offset=${localOffset}）`)
    }
    // 局部头里的 name/extra 长度可能和中央目录不同（尤其 extra），必须重新读
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > zip.length) {
      throw new Error(`条目 ${name} 的数据越界（zip 被截断或损坏）`)
    }
    const raw = zip.subarray(dataStart, dataStart + compressedSize)

    let data: Buffer
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch {
        throw new Error(`条目 ${name} 解压失败（压缩数据损坏）`)
      }
    } else {
      throw new Error(`条目 ${name} 用了不支持的压缩方式（method=${method}）`)
    }

    const actualCrc = crc32(data)
    if (actualCrc !== expectedCrc) {
      throw new Error(
        `条目 ${name} 的 CRC32 校验失败（目录记 ${hex32(expectedCrc)}，实际 ${hex32(actualCrc)}）：内容被改过或已损坏`
      )
    }
    entries.set(name, data)

    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 纯检查层：条目表 → 逐项 verdict（测试可以直接造/篡改这张表） */
export function checkEntries(entries: Map<string, Buffer>, expect: PackageExpect): PackageCheck {
  const spec = KINDS[expect.kind]
  const checks: CheckItem[] = []
  const textOf = (name: string): string => entries.get(name)?.toString('utf8') ?? ''

  const contentTypes = entries.get(CONTENT_TYPES)
  const declares =
    contentTypes !== undefined && contentTypes.toString('utf8').includes(spec.contentType)
  checks.push(
    item(
      '[Content_Types].xml 声明主部件',
      declares,
      contentTypes === undefined ? `包内没有 ${CONTENT_TYPES}` : `没有声明 ${spec.contentType}`
    )
  )

  // 整本 [Content_Types].xml 对不对得上：少声明（打不开）算不过；多声明（PowerPoint 忽略）只记 info
  if (contentTypes !== undefined)
    checks.push(declarationItem(entries, contentTypes.toString('utf8')))

  const hasPrimary = entries.has(spec.primary)
  checks.push(item(`主部件存在（${spec.primary}）`, hasPrimary, `包内没有 ${spec.primary}`))

  checks.push(relsItem(entries, textOf))

  if (expect.sheets !== undefined) {
    const workbook = textOf(KINDS.xlsx.primary)
    const actual = (workbook.match(/<sheet\b/g) ?? []).length
    checks.push(
      item(
        '工作表张数与声明一致',
        actual === expect.sheets,
        `${KINDS.xlsx.primary} 里 ${actual} 张表，期望 ${expect.sheets} 张`
      )
    )
  }

  if (expect.slides !== undefined) {
    const actual = slideCount(entries)
    checks.push(
      item(
        '幻灯片页数与声明一致',
        actual === expect.slides,
        `包内 ${actual} 页，期望 ${expect.slides} 页`
      )
    )
  }

  const texts = (expect.texts ?? []).filter((text) => text !== '')
  if (texts.length > 0) {
    const bodies = [...entries.values()].map((entry) => entry.toString('utf8'))
    const missing = texts.filter((text) => !bodies.some((body) => hits(body, text)))
    checks.push(item('关键文本在包内', missing.length === 0, `包内找不到：${listOf(missing)}`))
  }

  checks.push(...assertItems(entries, expect, textOf))

  const failed = checks.filter((check) => !check.ok)
  return {
    ok: failed.length === 0,
    checks,
    note:
      failed.length === 0 ? CHECK_PASSED : `结构校验未通过：${failed.map(describeItem).join('；')}`
  }
}

/** 字节 → 读包 → 逐项 verdict；zip 读不通只给 `fatal`（不是"某项不过"） */
export function checkPackage(bytes: Uint8Array, expect: PackageExpect): PackageCheck {
  let entries: Map<string, Buffer>
  try {
    entries = readZipEntries(bytes)
  } catch (error) {
    const fatal = error instanceof Error ? error.message : String(error)
    return { fatal, checks: [], ok: false, note: `结构校验未通过：${fatal}` }
  }
  return checkEntries(entries, expect)
}

/**
 * 一个 .pptx 的**逐页文字**（页号 = 物理页序，与 PowerPoint 一致）—— 断言与"读回源结构"共用这一份
 * 段落口径（段内 run 拼接、段间 `\n`，见 paragraphTexts）。读不通包就抛（中文人话，来自 readZipEntries）。
 *
 * round 76 起 `edit_ppt` 用它做「以文件为准重建源」（文件被用户手改过时，把文字读回来当新源）。
 */
export function packageSlideTexts(bytes: Uint8Array): Array<{ page: number; text: string }> {
  return slideTexts(readZipEntries(bytes))
}

/**
 * 断言项：用户/模型点名过、必须成立的那些事，逐条独立判定。
 * **不给断言就一条都不出**（回执与老口径完全一致）；给了一条没过就一定会出现在回执里。
 */
function assertItems(
  entries: Map<string, Buffer>,
  expect: PackageExpect,
  textOf: (name: string) => string
): CheckItem[] {
  const assert = expect.assert
  if (assert === undefined) return []

  const items: CheckItem[] = []
  if (assert.count !== undefined) items.push(countItem(entries, expect.kind, assert.count))
  for (const want of assert.contains ?? []) {
    if (want.text === '') continue
    items.push(containsItem(entries, expect.kind, want, textOf))
  }
  return items
}

/** 件数断言：pptx 页数 / xlsx 工作表张数（docx 没有可数的口径，如实报"没有这一项"） */
function countItem(entries: Map<string, Buffer>, kind: PackageKind, want: number): CheckItem {
  if (kind === 'docx') {
    return {
      name: '断言：件数',
      ok: false,
      detail: 'docx 没有页数口径（换成文本断言）'
    }
  }
  const actual = kind === 'pptx' ? slideCount(entries) : sheetCount(entries)
  const unit = kind === 'pptx' ? '页' : '张工作表'
  return item(`断言：必须正好 ${want} ${unit}`, actual === want, `包内 ${actual} ${unit}`)
}

/**
 * 文本断言。查的范围按格式定，**排除不该算的地方**（与 dsh 的 `--contains` 同口径）：
 *   - pptx 给了 `page`：只看那一页的 slide 部件 —— 图表文字在 `ppt/charts/`、演讲者备注在
 *     `ppt/notesSlides/`，都是**别的部件**，天然不算；页内文字按 `a:p` 段落拼回（一条要点拆成
 *     "圆点 + 正文"两个 run 也能整句命中），含表格单元格；
 *   - pptx 不给 `page`：所有页里任意一页有就算有；
 *   - docx：只看正文部件 `word/document.xml`（页眉页脚、批注不算）；
 *   - xlsx：看工作表与共享字符串部件（**整本工作簿**，不分工作表）。
 */
function containsItem(
  entries: Map<string, Buffer>,
  kind: PackageKind,
  want: PackageTextAssert,
  textOf: (name: string) => string
): CheckItem {
  const label = `「${clip(want.text, ASSERT_TEXT_CHARS)}」`

  if (kind === 'pptx') {
    const pages = slideTexts(entries)
    const page = want.page
    if (page !== undefined) {
      const name = `断言：第 ${page} 页必须含${label}`
      const found = pages.find((item) => item.page === page)
      if (found === undefined) {
        return { name, ok: false, detail: `包内只有 ${pages.length} 页` }
      }
      if (hits(found.text, want.text)) return { name, ok: true }

      const elsewhere = pages
        .filter((item) => item.page !== page && hits(item.text, want.text))
        .map((item) => String(item.page))
      if (elsewhere.length > 0) {
        return {
          name,
          ok: false,
          detail: `不在第 ${page} 页；第 ${listOf(elsewhere)} 页有这段文字`
        }
      }
      return {
        name,
        ok: false,
        detail: `第 ${page} 页没有这段文字；这一页的文字：${clip(found.text, DETAIL_TEXT_CHARS)}`
      }
    }

    const name = `断言：必须有${label}`
    return item(
      name,
      pages.some((item) => hits(item.text, want.text)),
      '所有页都没有这段文字（图表文本与备注不算）'
    )
  }

  if (kind === 'docx') {
    const name = `断言：正文必须含${label}`
    const document = entries.get(KINDS.docx.primary)
    if (document === undefined) {
      return { name, ok: false, detail: `包内没有 ${KINDS.docx.primary}` }
    }
    const body = paragraphTexts(document.toString('utf8'), 'w:p', 'w:t').join('\n')
    return item(name, hits(body, want.text), `正文（${KINDS.docx.primary}）里没有这段文字`)
  }

  const name = `断言：工作簿里必须含${label}`
  if (want.page !== undefined) {
    return { name, ok: false, detail: 'xlsx 的文本断言按整本工作簿查（不支持限定第 N 张表）' }
  }
  const bodies = [...entries.keys()]
    .filter((part) => WORKBOOK_TEXT_PART.test(part))
    .map((part) => textOf(part))
  return item(
    name,
    bodies.some((body) => hits(body, want.text)),
    '所有工作表的单元格里都没有这段文字'
  )
}

/** xlsx 里承载单元格文字的两个部件族 */
const WORKBOOK_TEXT_PART = /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/

/**
 * 泛型兜底类型：部件**只**被这些类型兜住，等价于"少声明了一条专用声明"——
 * 包本身仍是合法 OPC（`Default Extension="xml"` 确实给了个类型），但消费者按名查出来是
 * `application/xml`，读不出"这是张工作表/一页幻灯片"，Excel/PowerPoint 会当坏文件去修复。
 * 三个产出库都给自己的 xml 部件逐条写了 Override，所以这一条不会误报。
 */
const GENERIC_TYPES = new Set(['application/xml', 'text/xml', 'application/octet-stream'])

/**
 * `[Content_Types].xml` 的声明与实际部件对得上（双向核）：
 *   - **包内有、但没有任何声明覆盖** → 不过；只被泛型类型兜住也算不过（同上，打不开）；
 *   - **声明了、包内没有** → 只记 info：消费方按名查类型，多出来的声明被直接忽略（实测 pptxgenjs
 *     每份演示文稿都多声明几个 `ppt/slideMasters/slideMasterN.xml`），拿它判不过会让每份 PPT 都报错。
 */
function declarationItem(entries: Map<string, Buffer>, xml: string): CheckItem {
  const { overrides, defaults } = contentTypeDecl(xml)
  const parts = [...entries.keys()].filter((name) => !isDirectory(name) && name !== CONTENT_TYPES)
  const undeclared: string[] = []
  const generic: string[] = []

  for (const part of parts) {
    if (overrides.has(part)) continue
    const fallback = defaults.get(extensionOf(part))
    if (fallback === undefined) undeclared.push(part)
    else if (GENERIC_TYPES.has(fallback)) generic.push(part)
  }

  const detail = [
    undeclared.length === 0 ? '' : `没有任何声明覆盖：${listOf(undeclared)}`,
    generic.length === 0 ? '' : `只有泛型兜底（读不出部件类型）：${listOf(generic)}`
  ]
    .filter((line) => line !== '')
    .join('；')

  const result = item(
    '[Content_Types].xml 声明与实际部件对得上',
    undeclared.length === 0 && generic.length === 0,
    detail
  )

  const absent = [...overrides.keys()].filter((name) => !entries.has(name))
  return absent.length === 0
    ? result
    : { ...result, info: `声明的部件不在包内（多余声明，不影响打开）：${listOf(absent)}` }
}

/** 关系引用：**每个** `.rels` 里的 Target 都必须落在包内（External 外链不算） */
function relsItem(entries: Map<string, Buffer>, textOf: (name: string) => string): CheckItem {
  const relsParts = [...entries.keys()].filter((name) => name.endsWith('.rels'))
  const dangling: string[] = []

  for (const part of relsParts) {
    const base = relBaseDir(part)
    for (const target of relationshipTargets(textOf(part))) {
      const resolved = resolveTarget(base, target)
      if (resolved !== null && !entries.has(resolved)) dangling.push(`${part} → ${target}`)
    }
  }

  return item(
    '关系引用都在包内（每个 .rels）',
    relsParts.length > 0 && dangling.length === 0,
    relsParts.length === 0
      ? `包内没有任何 .rels 部件（连 ${ROOT_RELS} 都没有）`
      : `悬空的 Target：${listOf(dangling)}`
  )
}

function item(name: string, ok: boolean, detail?: string): CheckItem {
  return ok || detail === undefined ? { name, ok } : { name, ok, detail }
}

/** 不过的一项在回执里的样子：带 detail（模型据此决定改哪里，别只说"不过"） */
function describeItem(check: CheckItem): string {
  return check.detail === undefined ? check.name : `${check.name}（${check.detail}）`
}

function slideNumber(name: string): number {
  return Number(SLIDE_ENTRY.exec(name)?.[1] ?? 0)
}

function slideCount(entries: Map<string, Buffer>): number {
  return [...entries.keys()].filter((name) => SLIDE_ENTRY.test(name)).length
}

/** 工作表张数（`xl/workbook.xml` 里的 `<sheet>` 条数，与张数检查同一口径） */
function sheetCount(entries: Map<string, Buffer>): number {
  const workbook = entries.get(KINDS.xlsx.primary)?.toString('utf8') ?? ''
  return (workbook.match(/<sheet\b/g) ?? []).length
}

/** 逐页文字：页号 = 物理页序（slideN.xml 的 N，与 PowerPoint 页序一致），顺序按页号排 */
function slideTexts(entries: Map<string, Buffer>): Array<{ page: number; text: string }> {
  return [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
    .map((name) => ({
      page: slideNumber(name),
      text: paragraphTexts(entries.get(name)?.toString('utf8') ?? '', 'a:p', 'a:t').join('\n')
    }))
}

/**
 * XML 里所有段落的文字（段内 run 拼接，段间用 `\n`）。
 * pptx 走 `a:p`/`a:t`、docx 走 `w:p`/`w:t`；pptxgenjs 会把一条要点拆成"圆点"+"正文"两个 run
 * （`<a:t>●</a:t><a:t> 营收增长 12%</a:t>`），所以必须**按段落拼回**再比，逐个 run 比会漏。
 */
function paragraphTexts(xml: string, paragraph: string, run: string): string[] {
  const paragraphs =
    xml.match(new RegExp(`<${paragraph}\\b[^>]*>[\\s\\S]*?</${paragraph}>`, 'g')) ?? []
  const runs = new RegExp(`<${run}\\b[^>]*>([\\s\\S]*?)</${run}>`, 'g')

  return paragraphs.map((para) => {
    let text = ''
    for (const match of para.matchAll(runs)) text += unescapeXml(match[1] ?? '')
    return text
  })
}

/** 命中判定：原文命中，或"XML 转义后的形态"命中（调用方给的可能是任一种写法） */
function hits(haystack: string, needle: string): boolean {
  return haystack.includes(needle) || haystack.includes(escapeXml(needle))
}

/**
 * `[Content_Types].xml` 的两类声明：逐部件的 Override（PartName → 类型）+ 按扩展名的 Default
 * （小写扩展名 → 类型）。同名重复时按"先写的算"（OPC 对重复声明的行为未定义，包不该这么写）。
 */
function contentTypeDecl(xml: string): {
  overrides: Map<string, string>
  defaults: Map<string, string>
} {
  const overrides = new Map<string, string>()
  for (const tag of xml.match(/<Override\b[^>]*>/g) ?? []) {
    const part = attrOf(tag, 'PartName')
    const type = attrOf(tag, 'ContentType')
    if (part !== undefined && part !== '' && !overrides.has(part.replace(/^\/+/, ''))) {
      overrides.set(part.replace(/^\/+/, ''), type ?? '')
    }
  }

  const defaults = new Map<string, string>()
  for (const tag of xml.match(/<Default\b[^>]*>/g) ?? []) {
    const ext = attrOf(tag, 'Extension')?.toLowerCase()
    if (ext !== undefined && ext !== '' && !defaults.has(ext)) {
      defaults.set(ext, attrOf(tag, 'ContentType') ?? '')
    }
  }
  return { overrides, defaults }
}

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1]
}

/** 目录条目（`xl/` 这种 0 字节的收尾斜杠条目）不是部件，不参与声明核对 */
function isDirectory(name: string): boolean {
  return name.endsWith('/')
}

function extensionOf(part: string): string {
  return part.slice(part.lastIndexOf('.') + 1).toLowerCase()
}

/** `.rels` 里所有非 External 的 Target（External 是外链，不要求落在包内） */
function relationshipTargets(xml: string): string[] {
  const targets: string[] = []
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    if (/TargetMode\s*=\s*"External"/i.test(tag)) continue
    const target = attrOf(tag, 'Target')
    if (target !== undefined && target !== '') targets.push(target)
  }
  return targets
}

/** `.rels` 部件的 Target 基准目录：`X/_rels/Y.rels` 的 Target 相对 `X/`（`_rels/.rels` 相对包根） */
function relBaseDir(relsPath: string): string {
  const base = posix.dirname(posix.dirname(relsPath))
  return base === '.' || base === '' ? '' : base
}

/** Target → 包内路径（绝对路径去前导斜杠；相对路径按基准目录归一）；外链/空目标给 null（不核） */
function resolveTarget(baseDir: string, target: string): string | null {
  const trimmed = target.trim()
  if (trimmed === '') return null
  // 带 scheme 的（http:、mailto: 等）是外链：即便没写 TargetMode="External" 也不该要求落在包内
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

  const path = trimmed.startsWith('/') ? trimmed.replace(/^\/+/, '') : posix.join(baseDir, trimmed)
  const normalized = posix.normalize(path)
  return normalized === '.' || normalized === '' ? null : normalized
}

/** XML 文本转义（`& < >`）：包里的文本可能是转义后的形态，两种都认 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g

/** XML 文本反转义（取出的字面值要与用户给的原句比，不能带着 `&amp;`） */
function unescapeXml(text: string): string {
  return text.replace(XML_ENTITY, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&'
      case '&lt;':
        return '<'
      case '&gt;':
        return '>'
      case '&quot;':
        return '"'
      case '&apos;':
        return "'"
      default: {
        const code = entity.startsWith('&#x')
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity
      }
    }
  })
}

/** 回显用：折成一行并截断（长文本只留开头，够认出来就行） */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 详情里的清单一律截断（保护上下文）：最多 DETAIL_ITEMS 条，超了补一句"等 N 条" */
function listOf(items: readonly string[]): string {
  const shown = items.slice(0, DETAIL_ITEMS)
  return items.length > DETAIL_ITEMS
    ? `${shown.join('、')} 等 ${items.length} 条`
    : shown.join('、')
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0')
}

const PDF_HEADER = '%PDF-'
const PDF_TRAILER = '%%EOF'
/** PDF 的尾部标记在文件最后 1KB 内（允许尾部有空白/垃圾） */
const PDF_TAIL_BYTES = 1024

/** PDF 没有包结构：只认开头 5 字节的头与末尾 1KB 内的 `%%EOF`（不通过由调用方抛错，不落盘） */
export function checkPdf(bytes: Uint8Array): PdfCheck {
  const pdf = Buffer.from(bytes)
  const head = pdf.subarray(0, PDF_HEADER.length).toString('latin1')
  if (head !== PDF_HEADER) {
    return pdfFail(`开头不是 ${PDF_HEADER}（拿到的不是 PDF 字节）`)
  }
  const tail = pdf.subarray(Math.max(0, pdf.length - PDF_TAIL_BYTES)).toString('latin1')
  if (!tail.includes(PDF_TRAILER)) {
    return pdfFail(`结尾 1KB 内找不到 ${PDF_TRAILER}（PDF 可能被截断）`)
  }
  return { ok: true, note: CHECK_PASSED }
}

function pdfFail(reason: string): PdfCheck {
  return { ok: false, note: `结构校验未通过：${reason}`, reason }
}

/** CRC32（IEEE，表驱动）：能查出"条目数据被改过"，与 zip 目录里记的值对不上就报错 */
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

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - EOCD_SEARCH_BYTES)
  for (let offset = zip.length - 22; offset >= earliest; offset--) {
    if (zip.readUInt32LE(offset) === ZIP_EOCD) return offset
  }
  throw new Error('这不是一个 zip 容器（找不到中央目录结尾）')
}
