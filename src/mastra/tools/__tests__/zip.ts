// @vitest-environment node
/**
 * 最小 zip 读取器（测试专用）：xlsx / pptx / docx 都是 **zip 容器**（OOXML 部件打包）。
 *
 * 为什么不用新依赖（如 yauzl/jszip）：产出物测试要的是"**真解包**看一眼容器结构"——
 * 中央目录 + 局部头 + inflateRaw 就够，几十行、只读、零依赖。比"同库读回"更硬的一点是：
 * 它能证明 [Content_Types].xml / word/document.xml / ppt/slides/slideN.xml 这些**部件路径**真的按
 * OOXML 规矩落了，而不是某个库私有的中间格式。
 *
 * 只支持这一场景需要的范围：zip32、无加密、条目名 UTF-8/ASCII（三个库产出的都是 ASCII 名）。
 */
import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

/** 解包成 `条目名 → 解压后的字节`（顺序即中央目录顺序） */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(zip)
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()

  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`zip 中央目录第 ${index + 1} 条的签名不对（offset=${offset}）`)
    }
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`zip 局部头签名不对：${name}`)
    }
    // 局部头里的 name/extra 长度可能和中央目录不同（尤其 extra），必须重新读
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = zip.subarray(dataStart, dataStart + compressedSize)

    entries.set(name, method === 0 ? raw : inflateRawSync(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 取条目文本；条目不在时把"有哪些条目"一起抛出来（排障用） */
export function zipText(entries: Map<string, Buffer>, name: string): string {
  const entry = entries.get(name)
  if (entry === undefined) {
    throw new Error(`zip 里没有 ${name}；实际条目：${[...entries.keys()].join(', ')}`)
  }
  return entry.toString('utf8')
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - 65_557)
  for (let offset = zip.length - 22; offset >= earliest; offset--) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  throw new Error('这不是一个 zip 容器（找不到中央目录结尾）')
}
