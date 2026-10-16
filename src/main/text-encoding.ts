/**
 * 表格档（CSV）的**文本解码**：BOM 认得出就照 BOM 解，认不出就"严格 UTF-8 → GB18030"两段式。
 *
 * 为什么单独一份：CSV 是唯一"编码全靠导出方心情"的格式 —— 同一张表，Excel 简体中文版导出来是
 * GB18030（老版本）或带 BOM 的 UTF-8（新版本）、记事本另存可能是 UTF-16LE/BE。按 UTF-8 硬解会得到
 * 一整片 U+FFFD（用户看到的是"文件坏了"，其实是编码不同）；反过来"猜错了也不说"更糟 —— 所以：
 *
 *   - **有 BOM 就信 BOM**（UTF-8 BOM / UTF-16LE / UTF-16BE），不算推测；
 *   - **没有 BOM 先看像不像 UTF-16**（一半字节成规模地是 0x00，另一半几乎没有）—— 这个判据是**猜的**，
 *     回执里必须如实标"按内容推测"；判据故意保守：不确定就不猜；
 *   - **再试严格 UTF-8**（`fatal: true`，有非法字节就抛）——过得去就是 UTF-8，不算推测；
 *   - **最后回退 GB18030**（GB18030 几乎接受任何字节序列，是中文本地文件的兜底），同样标"推测"；
 *   - 连 GB18030 都解不了（Node 的 ICU 不完整，`TextDecoder` 不认这个 label）→ **不糊弄**：
 *     返回一句人话，让调用方原样告诉用户/模型（下一步：另存为 UTF-8 再读）。
 *
 * 只用 `globalThis.TextDecoder`（不 import util）——测试可以替换全局来验证"ICU 不可用"那条路。
 * 空文件、纯 ASCII 都走 UTF-8 分支（无 BOM、严格解码必过）。
 */

/** 认得出的编码（回执照这个说） */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030'

export interface DecodedText {
  text: string
  encoding: TextEncoding
  /** 编码是**按内容推测**的（没有 BOM，也不严格是 UTF-8）—— 回执里要如实说 */
  inferred: boolean
}

/** 解码结果：解不了是**一等结果**（ICU 不完整），不是异常 */
export type TextDecodeResult = ({ ok: true } & DecodedText) | { ok: false; message: string }

/** 编码 → 人话（回执里报的**真实**编码） */
export function describeEncoding(encoding: TextEncoding): string {
  switch (encoding) {
    case 'utf-8':
      return 'UTF-8'
    case 'utf-8-bom':
      return 'UTF-8（带 BOM）'
    case 'utf-16le':
      return 'UTF-16LE'
    case 'utf-16be':
      return 'UTF-16BE'
    case 'gb18030':
      return 'GB18030（简体中文常见编码）'
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

/**
 * 按 label 解码：label 认不出（ICU 没带这个编码）返回 null，不抛给上层 —— 那是一条要走人话的路。
 * 别的异常（比如实现层面的怪错误）也不往上层扔：解码这条路上"解不了"就该说人话。
 */
function decodeWith(label: string, bytes: Uint8Array): { text: string } | { unsupported: true } {
  try {
    return { text: new globalThis.TextDecoder(label).decode(bytes) }
  } catch {
    return { unsupported: true }
  }
}

/** 严格 UTF-8：有非法字节就返回 null（不静默塞 U+FFFD） */
function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 一个字节是不是 NUL */
function isZero(byte: number | undefined): boolean {
  return byte === 0
}

/**
 * 没有 BOM 时"像不像 UTF-16"：UTF-16 的 ASCII 文本在每个 2 字节里有一个 0x00
 * （LE 在奇位、BE 在偶位）。判据故意保守 —— 一个半区的 NUL 占比 > 30%、另一个 < 5% 才认，
 * 且至少要 8 字节（太短没有统计意义）。认不出返回 null（**不猜**）。
 */
function guessUtf16(bytes: Uint8Array): 'le' | 'be' | null {
  if (bytes.length < 8 || bytes.length % 2 !== 0) return null
  let evenZero = 0
  let oddZero = 0
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    if (isZero(bytes[index])) evenZero += 1
    if (isZero(bytes[index + 1])) oddZero += 1
  }
  const pairs = bytes.length / 2
  const evenRatio = evenZero / pairs
  const oddRatio = oddZero / pairs
  if (oddRatio > 0.3 && evenRatio < 0.05) return 'le'
  if (evenRatio > 0.3 && oddRatio < 0.05) return 'be'
  return null
}

/** ICU 不完整时的统一人话（调用方原样用） */
function unsupportedMessage(what: string): string {
  return (
    `本机的 Node 没有带 ${what} 解码能力（ICU 不完整），这份文件又不是 UTF-8，所以解不出来。` +
    '下一步：请用户把这份表格另存为 UTF-8（Excel 导出时选「CSV UTF-8」）再读。'
  )
}

/**
 * 一份表格文本的字节 → 文本 + **实际用的编码**。见文件头注。
 */
export function decodeTextBytes(bytes: Uint8Array): TextDecodeResult {
  if (bytes.length === 0) return { ok: true, text: '', encoding: 'utf-8', inferred: false }

  // ① BOM 说了算
  if (startsWith(bytes, [0xff, 0xfe])) {
    const decoded = decodeWith('utf-16le', bytes.subarray(2))
    if ('unsupported' in decoded) return { ok: false, message: unsupportedMessage('UTF-16LE') }
    return { ok: true, text: decoded.text, encoding: 'utf-16le', inferred: false }
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    const decoded = decodeWith('utf-16be', bytes.subarray(2))
    if ('unsupported' in decoded) return { ok: false, message: unsupportedMessage('UTF-16BE') }
    return { ok: true, text: decoded.text, encoding: 'utf-16be', inferred: false }
  }
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const decoded = decodeWith('utf-8', bytes.subarray(3))
    if ('unsupported' in decoded) return { ok: false, message: unsupportedMessage('UTF-8') }
    return { ok: true, text: decoded.text, encoding: 'utf-8-bom', inferred: false }
  }

  // ② 没有 BOM：先看像不像 UTF-16（这一步是**猜**，回执会标出来）
  const guessed = guessUtf16(bytes)
  if (guessed !== null) {
    const label = guessed === 'le' ? 'utf-16le' : 'utf-16be'
    const decoded = decodeWith(label, bytes)
    if (!('unsupported' in decoded)) {
      return {
        ok: true,
        text: decoded.text,
        encoding: label === 'utf-16le' ? 'utf-16le' : 'utf-16be',
        inferred: true
      }
    }
    // ICU 不认 UTF-16BE：继续往下走（严格 UTF-8 多半也过不去 → 会落到 GB18030 / 人话）
  }

  // ③ 严格 UTF-8：过得去就是它（有非法字节返回 null，不塞 U+FFFD）
  const strict = decodeStrictUtf8(bytes)
  if (strict !== null) return { ok: true, text: strict, encoding: 'utf-8', inferred: false }

  // ④ 回退 GB18030（中文本地文件的兜底；这一步同样是**猜**）
  const gb = decodeWith('gb18030', bytes)
  if ('unsupported' in gb) return { ok: false, message: unsupportedMessage('GB18030') }
  return { ok: true, text: gb.text, encoding: 'gb18030', inferred: true }
}
