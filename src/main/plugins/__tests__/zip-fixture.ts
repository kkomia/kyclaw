import { deflateRawSync } from 'node:zlib'

/**
 * 测试用的**最小 zip 构造器**（round 94）：手工拼局部头 / 中央目录 / EOCD，每一个字段都能改
 * ——安全用例要造的形状（`..` 条目名、symlink 的 unix mode、加密标记、zip64 哨兵、声明撒谎的
 * 炸弹包、局部头与中央目录对不上）用现成的打包库造不出来，而 skill-zip 的拒绝面必须逐条钉死。
 *
 * 只支持单盘、无注释、zip32；压缩走 `deflateRawSync`（method 8）或 store（method 0）。
 */
export interface ZipFixtureEntry {
  /** 条目名（原样写进中央目录；可以是 `../x` 这种危险形状） */
  name: string
  /** 内容（字符串按 UTF-8） */
  data?: string | Buffer
  /** 0 = store（缺省）/ 8 = deflate；给别的值只为造"不支持的压缩方式" */
  method?: number
  /** 直接用这段压缩数据（炸弹用例：声明 1KB、实际解出 4MiB） */
  raw?: Buffer
  /** 覆盖中央目录声明的解压后大小（缺省 = 真实长度） */
  declaredSize?: number
  /** 覆盖中央目录的 CRC32（缺省按真实内容算） */
  declaredCrc?: number
  /** 中央目录 external attributes 的高 16 位（unix mode；symlink = 0xA1FF） */
  unixMode?: number
  /** 通用位标记（bit0 = 加密；bit3 = data descriptor） */
  flags?: number
  /** 局部头里的名字（与中央目录不一致的用例） */
  localName?: string
}

/** 覆盖 EOCD 的声明（条数 / 中央目录偏移撒谎的用例） */
export interface ZipFixtureOptions {
  /** EOCD 里声明的条目数（缺省 = 真实条数） */
  count?: number
  /** EOCD 里声明的中央目录偏移（缺省 = 真实偏移） */
  centralOffset?: number
  /** 给中央目录每条加一段 extra（形状无关紧要，钉"extra 存在也能读"） */
  centralExtra?: Buffer
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_ENTRY = 0x02014b50
const EOCD = 0x06054b50

export function makeZip(
  entries: readonly ZipFixtureEntry[],
  options: ZipFixtureOptions = {}
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const payload = entry.raw ?? (method === 8 ? deflateRawSync(content) : content)
    const name = Buffer.from(entry.name, 'utf8')
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8')
    const crc = entry.declaredCrc ?? crc32(content)
    const size = entry.declaredSize ?? content.length

    const local = Buffer.alloc(30 + localName.length)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(localName.length, 26)
    local.writeUInt16LE(0, 28)
    localName.copy(local, 30)
    locals.push(local, payload)

    const extra = options.centralExtra ?? Buffer.alloc(0)
    const central = Buffer.alloc(46 + name.length + extra.length)
    central.writeUInt32LE(CENTRAL_ENTRY, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((entry.unixMode ?? 0x81a4) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    extra.copy(central, 46 + name.length)
    centrals.push(central)

    offset += local.length + payload.length
  }

  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(options.count ?? entries.length, 8)
  eocd.writeUInt16LE(options.count ?? entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(options.centralOffset ?? offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralDir, eocd])
}

/** zip 的 CRC32（与读侧同算法；测试用它造"CRC 不符"的包） */
export function crc32(bytes: Uint8Array): number {
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
