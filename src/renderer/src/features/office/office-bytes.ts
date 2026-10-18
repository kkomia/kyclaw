/**
 * PB-023：Office 文件字节的快速合法性检查。
 *
 * docx / xlsx / pptx 都是 ZIP 容器；损坏文件（如 16B 坏 zip）在部分上游引擎里会「静默挂起」
 * （xlsx 实测：既不 ready 也不报错，骨架无限）。打开前先看 ZIP 魔数，坏文件立刻给人话错误，
 * 不等引擎超时。
 */
export const INVALID_OFFICE_FILE_MESSAGE = '无法打开该文件：不是有效的 Office 文档'

/** 合法 ZIP：本地文件头 PK\x03\x04 / 空归档 PK\x05\x06 / 分卷 PK\x07\x08 */
export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  const third = bytes[2]
  const fourth = bytes[3]
  return (
    (third === 0x03 && fourth === 0x04) ||
    (third === 0x05 && fourth === 0x06) ||
    (third === 0x07 && fourth === 0x08)
  )
}
