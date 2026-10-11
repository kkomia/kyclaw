/**
 * 产出后**结构自检**（check_office 的 TS 形态）：落盘前真解包看一眼容器结构，逐项出 JSON verdict。
 *
 * 为什么要有这一层：xlsx/pptx/docx 是 zip 容器（OOXML 部件打包），"库写成功了"不等于"PowerPoint/Excel
 * 打得开"——`[Content_Types].xml` 少声明一条、主部件路径写歪、rels 指到包外，都是"能落盘、打不开"的坑。
 * 这里做的是**独立于产出库**的读侧校验（自己解 zip、自己核 CRC），所以它证明的是"按 OOXML 规矩落的盘"，
 * 而不是"某个库自己认自己"。
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
const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/

/** 一项检查的结果：名字是中文、ok 是判定、detail（仅在不过时给）是排障线索 */
export interface CheckItem {
  name: string
  ok: boolean
  detail?: string
}

export interface PackageExpect {
  kind: PackageKind
  /** xlsx：期望的工作表张数（不给就不查这一项） */
  sheets?: number
  /** pptx：期望的幻灯片页数（不给就不查这一项） */
  slides?: number
  /** 样本文本：给了就查"这些文本在包内"（原文或 XML 转义任一命中即过） */
  texts?: readonly string[]
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

  const hasPrimary = entries.has(spec.primary)
  checks.push(item(`主部件存在（${spec.primary}）`, hasPrimary, `包内没有 ${spec.primary}`))

  const rels = entries.get(ROOT_RELS)
  const dangling =
    rels === undefined
      ? []
      : relationshipTargets(rels.toString('utf8')).filter(
          (target) => !entries.has(normalizeTarget(target))
        )
  checks.push(
    item(
      `关系引用都在包内（${ROOT_RELS}）`,
      rels !== undefined && dangling.length === 0,
      rels === undefined ? `包内没有 ${ROOT_RELS}` : `悬空的 Target：${dangling.join('、')}`
    )
  )

  if (expect.sheets !== undefined) {
    const workbook = entries.get(KINDS.xlsx.primary)?.toString('utf8') ?? ''
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
    const actual = [...entries.keys()].filter((name) => SLIDE_ENTRY.test(name)).length
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
    const missing = texts.filter((text) => {
      const escaped = escapeXml(text)
      return !bodies.some((body) => body.includes(text) || body.includes(escaped))
    })
    checks.push(item('关键文本在包内', missing.length === 0, `包内找不到：${missing.join('、')}`))
  }

  const failed = checks.find((check) => !check.ok)
  return {
    ok: failed === undefined,
    checks,
    note: failed === undefined ? CHECK_PASSED : `结构校验未通过：${failed.name}`
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

function item(name: string, ok: boolean, detail?: string): CheckItem {
  return ok || detail === undefined ? { name, ok } : { name, ok, detail }
}

/** `_rels/.rels` 里所有非 External 的 Target（External 是外链，不要求落在包内） */
function relationshipTargets(xml: string): string[] {
  const targets: string[] = []
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    if (/TargetMode\s*=\s*"External"/i.test(tag)) continue
    const target = /Target\s*=\s*"([^"]*)"/i.exec(tag)?.[1]
    if (target !== undefined && target !== '') targets.push(target)
  }
  return targets
}

/** 包根相对路径归一：去前导斜杠 + posix normalize（`/xl/workbook.xml` 与 `xl/workbook.xml` 等价） */
function normalizeTarget(target: string): string {
  return posix.normalize(target.replace(/^\/+/, ''))
}

/** XML 文本转义（`& < >`）：包里的文本可能是转义后的形态，两种都认 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0')
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
