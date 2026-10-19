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

/**
 * **文本扩展名白名单**（PB-038）：这些扩展名按"文本文件"读，不需要先猜字节。
 *
 * 为什么要这份名单：read 的文本档以前只按 UTF-8 硬解，且把"内容嗅探到 HTML/SVG"当成二进制
 * （那是工作台预览找渲染器的标记）。名单把"确定是文本"的路由钉住；**不在名单里的扩展名仍按文本读**
 * （保持 read 原有行为：`.conf` / `.env` / 无扩展名脚本不该因为没登记就变二进制），真二进制由文件头判定。
 */
export const TEXT_EXTENSIONS: readonly string[] = [
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.md',
  '.markdown',
  '.txt',
  '.svg',
  '.xml',
  '.csv',
  '.tsv',
  '.log',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.rb',
  '.php',
  '.lua',
  '.kt',
  '.swift',
  '.dockerfile',
  '.gitignore',
  '.env'
]

/** 无扩展名但公认是文本的文件名（大小写不敏感；`Dockerfile.dev` 这类前缀也认） */
const TEXT_BARE_NAMES: readonly string[] = ['Makefile', 'Dockerfile', 'LICENSE', 'NOTICE', 'README', 'CHANGELOG']

/** 这份文件名是不是"已知文本"（按扩展名/常见无扩展名规则；不读内容） */
export function isKnownTextPath(pathOrName: string): boolean {
  const name = pathOrName.replace(/\\/g, '/').split('/').pop() ?? ''
  if (name === '') return false
  const lower = name.toLowerCase()
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true
  return TEXT_BARE_NAMES.some(
    (bare) => lower === bare.toLowerCase() || lower.startsWith(`${bare.toLowerCase()}.`)
  )
}

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

/** ICU 不完整时的统一人话（表格档：调用方原样用） */
function unsupportedMessage(what: string): string {
  return (
    `本机的 Node 没有带 ${what} 解码能力（ICU 不完整），这份文件又不是 UTF-8，所以解不出来。` +
    '下一步：请用户把这份表格另存为 UTF-8（Excel 导出时选「CSV UTF-8」）再读。'
  )
}

/**
 * ICU 不完整时的统一人话（普通文本档）：不写成"这是二进制"（它不是——只是这台机器的
 * TextDecoder 没带这种编码），给出可执行的下一步。
 */
function unsupportedMessageFile(what: string): string {
  return (
    `read 暂时解不开这份文本：它不是 UTF-8，而本机 Node 没带 ${what} 解码能力（ICU 不完整）。` +
    '下一步：请用户把它另存为 UTF-8（记事本「另存为」里可选）再读；这不影响文件本身。'
  )
}

/**
 * 一份文本字节 → 文本 + **实际用的编码**。`unsupported` 决定"ICU 不可用"时那句人话的口吻
 * （表格档 / 普通文本档各一份，见下面两个导出）。见文件头注。
 */
function decodeTextWith(
  bytes: Uint8Array,
  unsupported: (what: string) => string,
  options?: { allowPartialTail?: boolean }
): TextDecodeResult {
  if (bytes.length === 0) return { ok: true, text: '', encoding: 'utf-8', inferred: false }

  // ① BOM 说了算
  if (startsWith(bytes, [0xff, 0xfe])) {
    const decoded = decodeWith('utf-16le', bytes.subarray(2))
    if ('unsupported' in decoded) return { ok: false, message: unsupported('UTF-16LE') }
    return { ok: true, text: decoded.text, encoding: 'utf-16le', inferred: false }
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    const decoded = decodeWith('utf-16be', bytes.subarray(2))
    if ('unsupported' in decoded) return { ok: false, message: unsupported('UTF-16BE') }
    return { ok: true, text: decoded.text, encoding: 'utf-16be', inferred: false }
  }
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const decoded = decodeWith('utf-8', bytes.subarray(3))
    if ('unsupported' in decoded) return { ok: false, message: unsupported('UTF-8') }
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
  // 被截断的读法（>256KB 只读前 256KB）：刀口可能落在多字节字符中间 —— 逐字节回退，
  // 找到「截掉尾部半个字符后仍是合法 UTF-8」的那个点（老实现靠 StringDecoder 丢尾部，同口径）。
  if (options?.allowPartialTail === true) {
    for (let trim = 1; trim <= 3 && trim < bytes.length; trim += 1) {
      const partial = decodeStrictUtf8(bytes.subarray(0, bytes.length - trim))
      if (partial !== null) return { ok: true, text: partial, encoding: 'utf-8', inferred: false }
    }
  }

  // ④ 回退 GB18030（中文本地文件的兜底；这一步同样是**猜**）
  const gb = decodeWith('gb18030', bytes)
  if ('unsupported' in gb) return { ok: false, message: unsupported('GB18030') }
  if (options?.allowPartialTail === true && gb.text.includes('\uFFFD')) {
    // 截断点切坏了末尾一个双字节字符：截掉 1-2 字节再试，挑一个没有替换符的
    for (let trim = 1; trim <= 2 && trim < bytes.length; trim += 1) {
      const partial = decodeWith('gb18030', bytes.subarray(0, bytes.length - trim))
      if (!('unsupported' in partial) && !partial.text.includes('\uFFFD'))
        return { ok: true, text: partial.text, encoding: 'gb18030', inferred: true }
    }
  }
  return { ok: true, text: gb.text, encoding: 'gb18030', inferred: true }
}

/** 表格档（CSV / TSV）字节 → 文本：ICU 不可用时按「表格另存 UTF-8」给下一步 */
export function decodeTextBytes(bytes: Uint8Array): TextDecodeResult {
  return decodeTextWith(bytes, unsupportedMessage)
}

/**
 * 普通文本档（read 的 text 分支）字节 → 文本：UTF-8 / BOM / UTF-16 / GB18030 一路嗅探；
 * ICU 不可用时给**可读中文**（不写成"这是二进制"——文件本身没坏）。
 * `allowPartialTail`：读满上限被截断时允许丢掉尾部半个多字节字符（不产出 U+FFFD）。
 */
export function decodeTextFileBytes(
  bytes: Uint8Array,
  options?: { allowPartialTail?: boolean }
): TextDecodeResult {
  return decodeTextWith(bytes, unsupportedMessageFile, options)
}

