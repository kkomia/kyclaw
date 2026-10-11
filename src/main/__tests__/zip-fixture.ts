/**
 * 最小 zip 写入器（只支持 stored / 不压缩）——**测试夹具专用**，用于造 pptx 夹具。
 *
 * 为什么手写：pptx 的读侧按 OOXML 的部件名走（`ppt/slides/slideN.xml`），而现成的产出库
 * （pptxgenjs）只写它自己那套形状 —— 它不产生标题占位符（`<p:ph type="title"/>`）、
 * 一稿最多 60 页（见 `src/mastra/tools/ppt.ts` 的 MAX_SLIDES），造不出"标题占位符 / 第 10 页
 * 排在第 2 页之后 / 超上限的 101 页"这些夹具。为一个测试再引一个 zip 库不值。
 *
 * 产物交给**产品侧的** `readZipEntries` 解包（它在解压后逐条目校验 CRC32），
 * 所以这个写入器写歪了会当场炸，不会静默出一份假夹具。
 */
export function zipOf(files: Record<string, string>): Buffer {
  const names = Object.keys(files)
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.from(files[name], 'utf8')

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // 需要的版本
    header.writeUInt16LE(0, 6) // 标志位
    header.writeUInt16LE(0, 8) // 压缩方式：stored
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(data.length, 18) // 压缩后大小
    header.writeUInt32LE(data.length, 22) // 原始大小
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // 产出方版本
    entry.writeUInt16LE(20, 6) // 需要的版本
    entry.writeUInt16LE(0, 8) // 标志位
    entry.writeUInt16LE(0, 10) // 压缩方式：stored
    entry.writeUInt32LE(crc32(data), 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42) // 本地头偏移
    central.push(entry, nameBytes)

    offset += header.length + nameBytes.length + data.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16) // 中央目录起点
  return Buffer.concat([...local, ...central, eocd])
}

/** CRC32（IEEE，表驱动）——与 `readZipEntries` 校验用的那一套算法一致 */
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
