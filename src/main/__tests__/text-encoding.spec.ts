// @vitest-environment node
/**
 * 表格档的文本解码（`src/main/text-encoding.ts`）：BOM、UTF-16、严格 UTF-8、GB18030 回退、ICU 缺失。
 *
 * 夹具都是**真字节**：UTF-16 手拼（Node 的 TextEncoder 只出 UTF-8），GB18030 用已知的中文码位字节
 * （`中文` = `D6 D0 CE C4`，GBK/GB18030 通用）。ICU 缺失那条路用替换全局 `TextDecoder` 来演
 * （生产代码只走 `globalThis.TextDecoder`，所以替得掉）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeTextBytes,
  decodeTextFileBytes,
  describeEncoding,
  isKnownTextPath
} from '../text-encoding'

/** UTF-16LE 字节（可选 BOM）：`Buffer.from(text, 'utf16le')` 就是不带 BOM 的 LE */
function utf16le(text: string, bom = false): Buffer {
  const body = Buffer.from(text, 'utf16le')
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
}

/** UTF-16BE 字节（可选 BOM）：LE 字节两两交换 */
function utf16be(text: string, bom = false): Buffer {
  const body = Buffer.from(text, 'utf16le')
  body.swap16()
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body
}

/** `中文,abc` 的 GB18030 字节（中 = D6 D0、文 = CE C4） */
const GB18030_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x61, 0x62, 0x63])

/** 一个"ICU 不全"的 TextDecoder：utf-8 之外一律造不出，fatal 模式照抛 */
class IcuLessDecoder {
  private readonly fatal: boolean
  constructor(label: string, options?: { fatal?: boolean }) {
    if (label !== 'utf-8') throw new RangeError(`Unsupported encoding: ${label}`)
    this.fatal = options?.fatal === true
  }
  decode(bytes: Uint8Array): string {
    if (this.fatal) throw new TypeError('invalid utf-8')
    return Buffer.from(bytes).toString('utf8')
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeTextBytes：认得出的编码', () => {
  it('纯 UTF-8（含中文）：不算推测，原样读回', () => {
    const result = decodeTextBytes(Buffer.from('姓名,城市\n张三,北京', 'utf8'))
    expect(result).toEqual({
      ok: true,
      text: '姓名,城市\n张三,北京',
      encoding: 'utf-8',
      inferred: false
    })
  })

  it('UTF-8 BOM：按 BOM 认，BOM 本身不进正文', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('甲,乙', 'utf8')])
    const result = decodeTextBytes(bytes)
    expect(result).toEqual({ ok: true, text: '甲,乙', encoding: 'utf-8-bom', inferred: false })
  })

  it('UTF-16LE / UTF-16BE（带 BOM）：按 BOM 认，不算推测', () => {
    expect(decodeTextBytes(utf16le('姓名,城市', true))).toEqual({
      ok: true,
      text: '姓名,城市',
      encoding: 'utf-16le',
      inferred: false
    })
    expect(decodeTextBytes(utf16be('姓名,城市', true))).toEqual({
      ok: true,
      text: '姓名,城市',
      encoding: 'utf-16be',
      inferred: false
    })
  })

  it('没有 BOM 的 UTF-16LE（ASCII 内容）：按 NUL 分布猜出来，并标"推测"', () => {
    const result = decodeTextBytes(utf16le('name,city\nalice,beijing'))
    expect(result).toEqual({
      ok: true,
      text: 'name,city\nalice,beijing',
      encoding: 'utf-16le',
      inferred: true
    })
  })

  it('没有 BOM 的 UTF-16BE（ASCII 内容）：同样猜得出，标"推测"', () => {
    const result = decodeTextBytes(utf16be('name,city\nalice,beijing'))
    expect(result).toEqual({
      ok: true,
      text: 'name,city\nalice,beijing',
      encoding: 'utf-16be',
      inferred: true
    })
  })

  it('GB18030（不是合法 UTF-8）：回退解出来，并标"推测"', () => {
    const result = decodeTextBytes(GB18030_ZHONGWEN)
    expect(result).toEqual({ ok: true, text: '中文,abc', encoding: 'gb18030', inferred: true })
  })

  it('短内容不会因为 NUL 猜成 UTF-16（判据要够长才生效）', () => {
    // '\0a' 只有 2 字节：不猜 UTF-16，按 UTF-8 读（NUL 是合法 UTF-8）
    const result = decodeTextBytes(Buffer.from([0x00, 0x61]))
    expect(result).toEqual({ ok: true, text: '\u0000a', encoding: 'utf-8', inferred: false })
  })

  it('空字节：按 UTF-8 空文本（不是错误）', () => {
    expect(decodeTextBytes(Buffer.alloc(0))).toEqual({
      ok: true,
      text: '',
      encoding: 'utf-8',
      inferred: false
    })
  })
})

describe('decodeTextBytes：ICU 不全时给人的话', () => {
  it('GB18030 解不了：返回人话（说清是 ICU + 下一步），不抛异常、不糊弄', () => {
    vi.stubGlobal('TextDecoder', IcuLessDecoder)
    const result = decodeTextBytes(GB18030_ZHONGWEN)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('ICU')
    expect(result.message).toContain('GB18030')
    expect(result.message).toMatch(/另存为 UTF-8/)
  })

  it('UTF-16BE 解不了：同样给人话（点明是哪种编码）', () => {
    vi.stubGlobal('TextDecoder', IcuLessDecoder)
    const result = decodeTextBytes(utf16be('name,city\nalice', true))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('UTF-16BE')
  })

  it('UTF-16LE 不带 BOM 的猜测路在 ICU 不全时退回严格 UTF-8 → GB18030 人话（不崩）', () => {
    vi.stubGlobal('TextDecoder', IcuLessDecoder)
    const result = decodeTextBytes(utf16le('name,city\nalice,beijing'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('ICU')
  })
})

describe('describeEncoding：回执里报的编码名', () => {
  it('五种编码都有中文说法', () => {
    expect(describeEncoding('utf-8')).toBe('UTF-8')
    expect(describeEncoding('utf-8-bom')).toContain('BOM')
    expect(describeEncoding('utf-16le')).toBe('UTF-16LE')
    expect(describeEncoding('utf-16be')).toBe('UTF-16BE')
    expect(describeEncoding('gb18030')).toContain('GB18030')
  })
})

/**
 * PB-038：普通文本档的「扩展名白名单」+「截断点尾部半个多字节字符」。
 * 白名单只回答"这份文件名按不按文本读"（**不在名单里的仍按文本读**，保持 read 原行为），
 * 真二进制由 read 侧的文件头判定，不在这里。
 */
describe('isKnownTextPath：文本扩展名白名单（PB-038）', () => {
  it('代码 / 标记 / 配置这些文本扩展名命中（大小写不敏感）', () => {
    for (const name of [
      'index.html',
      'INDEX.HTML',
      'a.htm',
      'app.css',
      'main.ts',
      'x.tsx',
      'comp.jsx',
      'data.json',
      'pnpm-lock.yaml',
      'notes.md',
      'logo.svg',
      'feed.xml',
      'table.csv',
      'run.sh',
      'script.ps1',
      'main.py',
      'lib.rs',
      'a.cpp'
    ])
      expect(isKnownTextPath(name), name).toBe(true)
  })

  it('无扩展名的公认文本文件名命中（含 Dockerfile.dev 这类前缀）', () => {
    expect(isKnownTextPath('Makefile')).toBe(true)
    expect(isKnownTextPath('Dockerfile')).toBe(true)
    expect(isKnownTextPath('Dockerfile.dev')).toBe(true)
    expect(isKnownTextPath('LICENSE')).toBe(true)
  })

  it('二进制扩展名不命中（真二进制由 read 的文件头判定兜底）', () => {
    for (const name of ['a.png', 'a.zip', 'a.exe', 'a.wasm', 'a.pdf', 'a.mp4']) {
      expect(isKnownTextPath(name), name).toBe(false)
    }
  })
})

describe('decodeTextFileBytes：普通文本档的解码口吻与截断尾部（PB-038）', () => {
  it('ICU 不可用时给"另存为 UTF-8"的人话（不说成二进制）', () => {
    vi.stubGlobal('TextDecoder', IcuLessDecoder)
    const result = decodeTextFileBytes(GB18030_ZHONGWEN)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('另存为 UTF-8')
    expect(result.message).not.toContain('二进制')
  })

  it('allowPartialTail：UTF-8 刀口落在汉字中间时丢掉半个字符（不产 U+FFFD）', () => {
    const full = Buffer.from('好'.repeat(10), 'utf8') // 每字 3 字节
    const cut = full.subarray(0, full.length - 1) // 切掉最后 1 字节 → 尾部半个"好"
    const result = decodeTextFileBytes(cut, { allowPartialTail: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe('好'.repeat(9))
    expect(result.text).not.toContain('\uFFFD')
  })
})
