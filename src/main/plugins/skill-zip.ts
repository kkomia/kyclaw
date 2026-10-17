import { inflateRawSync } from 'node:zlib'
import { isWindowsReservedName } from '../../shared/skills'

/**
 * 技能 zip 的**最小读入**（round 94）：把一份技能包安全地读成"内存里的文件表"。
 *
 * 为什么不复用 `mastra/tools/artifact-check` 的 `readZipEntries`：那份是 OOXML 结构自检的读侧，
 * 条目表是 `Map<string, Buffer>` —— **拿不到 unix mode 与目录位**，而技能导入恰恰要靠这两个位
 * 挡掉 symlink 条目（解出来的"链接"如果被当普通文件写盘，语义就变了）与目录条目。
 * 这里只做一件事：给"外来 zip"一条**能逐条说清拒绝理由**的读法；OOXML 那条路一字不动。
 *
 * 拒绝面（每一条都是"外来包"才需要的，全部给人话中文）：
 *   - 结构：找不到 EOCD / 中央目录越界 / 局部头签名不对 / **zip64 哨兵**（`0xffff`/`0xffffffff`
 *     出现在条数或偏移上就不当 zip32 读）；
 *   - 条目名：`..` 段（zip-slip 的原料）、绝对路径与盘符、`\` 归一后仍越界、
 *     **Windows 保留名**（`con`/`nul`/`com1`…，落盘在 Windows 上会打不开）、**保留字符与控制符**
 *     （`* ? " < > |` 与 `0x00-0x1f`：落盘会被拒或被改写）、**段尾的点或空格**（Windows 会静默改写，
 *     于是"校验的名字"与"落盘的名字"不是同一个）、段里的 `:`（ADS）
 *     —— 以及**大小写只差一档的重名**：Windows/macOS 落盘会撞同一个文件，读侧与写侧取的可能不是同一条；
 *   - 条目属性：**symlink**（unix mode 的 `0xA000`）与 fifo/socket 等非常规类型、加密标记（bit0）、
 *     压缩方式不是 store/deflate；
 *   - 体量：声明条数/单条/合计超限先拒，**压缩数据本身超过单条上限的 `compressBound` 也先拒**
 *     （不可压缩内容用 deflate 会略微变大，所以闸门按 zlib 的 compressBound 公式留出合法余量；
 *     同步 inflate 的工作量因此被钉在单条上限量级）；**解压用 `maxOutputLength` 卡上限**
 *     （声明撒谎的炸弹包：中央目录写 1KB、实际解出 4GB 的那种，这一层才是硬闸），
 *     解出来的实际长度与声明、CRC32 都要对得上；
 *   - **两处声明对读**：局部头与中央目录的压缩方式、名字必须一致（读侧第三方库与"按局部头流式解"
 *     的实现可能各取一侧，只看一侧的检查就会被另一侧绕过）。
 */
export interface SkillZipLimits {
  /** 最多几个文件（目录条目不算） */
  maxFiles: number
  /** 单个文件解压后的字节上限 */
  maxEntryBytes: number
  /** 全部文件解压后的字节上限（合计） */
  maxTotalBytes: number
}

export interface SkillZipFile {
  /** 归一后的包内路径（正斜杠、无前导 `./`） */
  path: string
  data: Buffer
}

const EOCD = 0x06054b50
const CENTRAL_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
/** EOCD 在最末尾 22 字节 + 最多 65535 字节注释之内 */
const EOCD_SEARCH_BYTES = 65_557
/** zip64 的哨兵值：我们不支持（zip32 之外的写法一律拒，绝不"尽力猜"） */
const ZIP64_COUNT = 0xffff
const ZIP64_OFFSET = 0xffffffff
/** unix mode 的文件类型位（external attributes 的高 16 位） */
const MODE_TYPE = 0xf000
const MODE_SYMLINK = 0xa000
const MODE_DIR = 0x4000
const MODE_REGULAR = 0x8000

interface CentralEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  mode: number
  localOffset: number
}

/** zip 字节 → 文件表（目录条目跳过；任何一条不过关就抛人话，不返回半截） */
export function readSkillZip(bytes: Uint8Array, limits: SkillZipLimits): SkillZipFile[] {
  const zip = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const entries = readCentralDirectory(zip)
  const seen = new Set<string>()
  const files: SkillZipFile[] = []
  let declaredTotal = 0

  for (const entry of entries) {
    const normalized = normalizeEntryName(entry.name, seen)
    if (normalized === null) continue // 目录条目（名字以 / 结尾）
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(
        `条目 ${entry.name} 的压缩方式不支持（${entry.method}）：只认 store 与 deflate`
      )
    }
    const type = entry.mode & MODE_TYPE
    if (type === MODE_SYMLINK) {
      throw new Error(`条目 ${entry.name} 是符号链接：技能包里不接收链接条目`)
    }
    if (type !== 0 && type !== MODE_REGULAR && type !== MODE_DIR) {
      throw new Error(`条目 ${entry.name} 不是普通文件（类型位 ${type.toString(16)}）：拒绝读入`)
    }
    if (entry.size > limits.maxEntryBytes) {
      throw new Error(
        `条目 ${entry.name} 声明 ${entry.size} 字节，超过单条上限（${limits.maxEntryBytes} 字节）`
      )
    }
    /**
     * 压缩数据本身也卡一道（在碰 zlib 之前），但**必须留出 deflate 的合法膨胀余量**：
     * 不可压缩的内容（随机字节）用 deflate 反而会略微变大 —— 每个 65535 字节的 stored 块加
     * 5 字节头，2MiB 约多 170 字节。所以这道闸按 zlib 的 `compressBound` 公式取
     * `n + (n>>12) + (n>>14) + (n>>25) + 13`，不是"压缩后不得大于 n"（那会误拒正好贴着上限的
     * 正常不可压缩数据）。真正的炸弹防护仍是下面的 `maxOutputLength` 硬闸。
     */
    const compressedBudget = deflateBound(limits.maxEntryBytes)
    if (entry.compressedSize > compressedBudget) {
      throw new Error(
        `条目 ${entry.name} 的压缩数据有 ${entry.compressedSize} 字节，超过单条上限的 compressBound（${compressedBudget} 字节）：拒绝读入`
      )
    }
    declaredTotal += entry.size
    if (declaredTotal > limits.maxTotalBytes) {
      throw new Error(
        `zip 声明解压后合计 ${declaredTotal} 字节，超过上限（${limits.maxTotalBytes} 字节）`
      )
    }
    if (files.length >= limits.maxFiles) {
      throw new Error(`zip 里的文件数超过上限（${limits.maxFiles} 个）：只接收一个技能包`)
    }
    files.push({ path: normalized, data: decodeEntry(zip, entry, limits, files) })
  }

  return files
}

/**
 * 中央目录（EOCD → 逐条 46 字节头）。拒绝面见文件头注；`seen` 在名字归一里做大小写碰撞。
 * 返回顺序 = 包内顺序（调用方按路径查 SKILL.md，不看顺序）。
 */
function readCentralDirectory(zip: Buffer): CentralEntry[] {
  const eocdAt = findEocd(zip)
  if (eocdAt === -1) throw new Error('这不是一个 zip 文件（找不到中央目录尾部记录）')
  const count = zip.readUInt16LE(eocdAt + 10)
  const size = zip.readUInt32LE(eocdAt + 12)
  const offset = zip.readUInt32LE(eocdAt + 16)
  if (count === ZIP64_COUNT || size === ZIP64_OFFSET || offset === ZIP64_OFFSET) {
    throw new Error('这是 zip64 格式的包（条目数或偏移用了 zip64 哨兵）：暂不支持')
  }
  if (offset + size > zip.length) {
    throw new Error('zip 的中央目录越出了文件范围（包被截断或声明不实）')
  }

  const entries: CentralEntry[] = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_ENTRY) {
      throw new Error('zip 的中央目录签名不对（第 ' + (index + 1) + ' 条）：包已损坏或被改过')
    }
    const flags = zip.readUInt16LE(cursor + 8)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if ((flags & 0x0001) !== 0) {
      throw new Error(`条目 ${name} 是加密的：暂不支持加密 zip`)
    }
    entries.push({
      name,
      method: zip.readUInt16LE(cursor + 10),
      crc: zip.readUInt32LE(cursor + 16),
      compressedSize: zip.readUInt32LE(cursor + 20),
      size: zip.readUInt32LE(cursor + 24),
      mode: zip.readUInt32LE(cursor + 38) >>> 16,
      localOffset: zip.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 从末尾往回找 EOCD（注释最多 65535 字节）；找不到回 -1 */
function findEocd(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - EOCD_SEARCH_BYTES)
  for (let cursor = zip.length - 22; cursor >= earliest; cursor -= 1) {
    if (zip.readUInt32LE(cursor) === EOCD) return cursor
  }
  return -1
}

/**
 * deflate 输出的上界（zlib 的 `compressBound` 公式）：`n + (n>>12) + (n>>14) + (n>>25) + 13`。
 * 不可压缩的数据走 stored 块，每个 65535 字节块多 5 字节头 —— 这个公式正好覆盖那种合法膨胀。
 */
function deflateBound(n: number): number {
  return n + (n >> 12) + (n >> 14) + (n >> 25) + 13
}

/**
 * 条目名 → 归一化包内路径（正斜杠、去前导 `./`），目录条目回 null。回 null 之外的违规一律抛：
 *   - **Windows 危险名**（保留设备名、段尾点/空格、段里的 `:`）：这些名字在 Windows 上落盘会被
 *     改写或打不开 —— "校验过的名字"与"真落盘的名字"分叉，正是路径类漏洞的老形状；
 *   - **`..` / 绝对路径 / 盘符**：zip-slip 的原料，归一后还要有有效路径段；
 *   - **大小写仅差一档的重名**：Windows/macOS 上它们落同一个文件，读侧与写侧可能各取一条。
 */
function normalizeEntryName(raw: string, seen: Set<string>): string | null {
  if (raw.includes('\0')) throw new Error('条目名里有 NUL 字节：拒绝读入')
  const slashed = raw.replace(/\\/g, '/')
  if (slashed.endsWith('/')) {
    assertSegments(slashed, raw)
    return null // 目录条目：不落盘（文件自带父目录）
  }

  const parts: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error(`条目名 ${raw} 越出包根（含 .. 段）：拒绝读入`)
    parts.push(segment)
  }
  if (parts.length === 0) throw new Error(`条目名 ${raw} 不合法（没有有效路径段）：拒绝读入`)
  assertSegments(slashed, raw)

  const normalized = parts.join('/')
  const key = normalized.toLowerCase()
  if (seen.has(key)) {
    throw new Error(`zip 里有大小写仅差一档的重名条目（${normalized}）：拒绝读入`)
  }
  seen.add(key)
  return normalized
}

/** 段级检查：盘符/绝对路径、Windows 保留名、**保留字符/控制符**、段尾点空格、段里的冒号 */
function assertSegments(slashed: string, raw: string): void {
  if (slashed.startsWith('/')) throw new Error(`条目名 ${raw} 是绝对路径：拒绝读入`)
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') continue
    if (/^[a-zA-Z]:/.test(segment)) throw new Error(`条目名 ${raw} 带盘符：拒绝读入`)
    if (segment.includes(':'))
      throw new Error(`条目名 ${raw} 的路径段里有冒号（Windows 上会被当成数据流）：拒绝读入`)
    // Windows 文件名里非法的那几个字符 + 控制符（0x00-0x1f）：落盘会被拒或被改写，
    // 于是"校验过的名字"与"真落盘的名字"分叉 —— 与保留设备名同一类问题，一并挡在写盘之前
    if (/[*?"<>|]/.test(segment)) {
      throw new Error(`条目名 ${raw} 的路径段里有 Windows 不接受的字符（* ? " < > |）：拒绝读入`)
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(segment)) {
      throw new Error(`条目名 ${raw} 的路径段里有控制字符：拒绝读入`)
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`条目名 ${raw} 的路径段以点或空格结尾（Windows 会改写它）：拒绝读入`)
    }
    if (isWindowsReservedName(segment)) {
      throw new Error(
        `条目名 ${raw} 里有 Windows 保留名（${segment}）：落盘会打不开或被改写，拒绝读入`
      )
    }
  }
}

/**
 * 一条条目的字节：局部头核对 → 解压 → 实际长度 → CRC32。
 *
 * `maxOutputLength` 取"单条上限"与"合计还剩多少"里更紧的那个 —— 声明撒谎的炸弹包只有这一层拦得住
 * （中央目录写 1KB、实际 deflate 流解出 4GB 的那种，不能先解到内存里再判）。
 */
function decodeEntry(
  zip: Buffer,
  entry: CentralEntry,
  limits: SkillZipLimits,
  done: readonly SkillZipFile[]
): Buffer {
  const dataStart = localDataStart(zip, entry)
  const raw = zip.subarray(dataStart, dataStart + entry.compressedSize)
  if (raw.length < entry.compressedSize) {
    throw new Error(`条目 ${entry.name} 的数据越出了文件范围（zip 被截断）`)
  }
  const used = done.reduce((total, file) => total + file.data.length, 0)
  const room = limits.maxTotalBytes - used
  if (room <= 0) {
    throw new Error(
      `zip 解压后合计已到上限（${limits.maxTotalBytes} 字节）：条目 ${entry.name} 还有内容`
    )
  }

  let data: Buffer
  if (entry.method === 0) {
    data = raw
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxEntryBytes, room) })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(
          `条目 ${entry.name} 解压后超过上限（单条 ${limits.maxEntryBytes} / 合计 ${limits.maxTotalBytes} 字节）：中央目录里的声明（${entry.size} 字节）不可信，拒绝读入`
        )
      }
      throw new Error(`条目 ${entry.name} 解压失败（压缩数据损坏）`)
    }
  }

  if (data.length !== entry.size) {
    throw new Error(
      `条目 ${entry.name} 的解压后大小与声明不符（声明 ${entry.size} 字节，实际 ${data.length} 字节）：中央目录的声明不可信`
    )
  }
  if (used + data.length > limits.maxTotalBytes) {
    throw new Error(
      `zip 解压后合计（${used + data.length} 字节）超过上限（${limits.maxTotalBytes} 字节）：读到条目 ${entry.name} 就超了`
    )
  }
  const actual = crc32(data)
  if (actual !== entry.crc) {
    throw new Error(
      `条目 ${entry.name} 的 CRC32 校验失败（目录记 ${hex32(entry.crc)}，实际 ${hex32(actual)}）：内容被改过或已损坏`
    )
  }
  return data
}

/**
 * 局部头 → 数据起点。**两处声明对读**（与 artifact-check 同一理由）：局部头的名字与压缩方式
 * 必须和中央目录一致 —— 读侧的第三方库与"按局部头流式解"的实现可能各取一侧，只看一侧的检查
 * 会被另一侧绕过（中央目录说 store、局部头写 deflate 这类形状）。
 */
function localDataStart(zip: Buffer, entry: CentralEntry): number {
  const at = entry.localOffset
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_HEADER) {
    throw new Error(`条目 ${entry.name} 的局部头签名不对：包已损坏或被改过`)
  }
  const nameLength = zip.readUInt16LE(at + 26)
  const extraLength = zip.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLength + extraLength
  if (dataStart > zip.length) {
    throw new Error(`条目 ${entry.name} 的局部头越界（zip 被截断）`)
  }
  const localName = zip.toString('utf8', at + 30, at + 30 + nameLength)
  const localMethod = zip.readUInt16LE(at + 8)
  if (localName !== entry.name || localMethod !== entry.method) {
    throw new Error(
      `条目 ${entry.name} 的局部头与中央目录不一致（名字/压缩方式对不上）：两处声明不一的包不读`
    )
  }
  return dataStart
}

/** CRC32（IEEE；zip 用的就是它）——不依赖 Node 版本里有没有 `zlib.crc32` */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0')
}
