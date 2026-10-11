import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_PDF_MAX_BYTES } from '../../shared/workbench'
import { readFileBytes, sniffFormat } from '../workbench-files'

/**
 * 带类型字节通道：扩展名 + 文件头双重判定、按格式分桶的上限、缺失/目录/越界、
 * "头与扩展名对不上"一律按不支持（fail closed）。
 * 全在 mkdtemp 的真目录上跑，不碰用户目录。
 */
let root: string
let outside: string

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Buffer.from('GIF89a....', 'latin1')
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1')
])
const BMP = Buffer.from('BMxxxxxx', 'latin1')
const PDF = Buffer.from('%PDF-1.7\n...', 'latin1')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-workbench-bytes-outside-'))
  mkdirSync(join(root, '目录.png'))
  writeFileSync(join(root, '图片.png'), PNG)
  writeFileSync(join(root, '照片.JPG'), JPG)
  writeFileSync(join(root, '动图.gif'), GIF)
  writeFileSync(join(root, '新格式.webp'), WEBP)
  writeFileSync(join(root, '位图.bmp'), BMP)
  writeFileSync(join(root, '报告.pdf'), PDF)
  // 改名的可执行文件：后缀说是 png，内容不是
  writeFileSync(join(root, '伪装.png'), Buffer.from('MZ\x90\x00', 'latin1'))
  writeFileSync(join(root, '笔记.txt'), '纯文本\n')
  writeFileSync(join(root, '空.png'), Buffer.alloc(0))
  writeFileSync(join(outside, '外部.png'), PNG)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('sniffFormat：文件头判定', () => {
  it('六种认得出来的格式各自对号', () => {
    expect(sniffFormat(PDF)).toBe('pdf')
    expect(sniffFormat(PNG)).toBe('image-png')
    expect(sniffFormat(JPG)).toBe('image-jpeg')
    expect(sniffFormat(GIF)).toBe('image-gif')
    expect(sniffFormat(WEBP)).toBe('image-webp')
    expect(sniffFormat(BMP)).toBe('image-bmp')
  })

  it('认不出的头（含空文件、文本）给 null', () => {
    expect(sniffFormat(Buffer.alloc(0))).toBeNull()
    expect(sniffFormat(Buffer.from('hello', 'latin1'))).toBeNull()
    // RIFF 但不是 WEBP（wav 之类）不算图片
    expect(
      sniffFormat(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.alloc(4),
          Buffer.from('WAVE', 'latin1')
        ])
      )
    ).toBeNull()
  })
})

describe('readFileBytes：扩展名 + 文件头双重判定', () => {
  it('六种格式：回字节 + 格式 + 大小（字节是真的）', () => {
    const cases: Array<[string, string, Buffer]> = [
      ['图片.png', 'image-png', PNG],
      ['照片.JPG', 'image-jpeg', JPG],
      ['动图.gif', 'image-gif', GIF],
      ['新格式.webp', 'image-webp', WEBP],
      ['位图.bmp', 'image-bmp', BMP],
      ['报告.pdf', 'pdf', PDF]
    ]
    for (const [name, format, source] of cases) {
      const result = readFileBytes(root, name)
      expect(result.kind).toBe('bytes')
      if (result.kind !== 'bytes') continue
      expect(result.format).toBe(format)
      expect(result.size).toBe(source.length)
      expect(Buffer.from(result.bytes)).toEqual(source)
    }
  })

  it('认不出的后缀 / 空文件 / 头与后缀对不上：都按不支持（不猜内容）', () => {
    expect(readFileBytes(root, '笔记.txt')).toEqual({
      kind: 'unsupported',
      size: Buffer.byteLength('纯文本\n')
    })
    expect(readFileBytes(root, '空.png')).toEqual({ kind: 'unsupported', size: 0 })
    // 伪装成 png 的可执行文件：后缀认得、头不认 → 不画
    expect(readFileBytes(root, '伪装.png').kind).toBe('unsupported')
  })

  it('文件没了回 missing（不抛）', () => {
    expect(readFileBytes(root, '没有这个.png')).toEqual({ kind: 'missing' })
  })

  it('目录抛人话（调用方按后缀路由，正常到不了）', () => {
    expect(() => readFileBytes(root, '目录.png')).toThrow(/文件夹/)
  })

  it('越界路径一律拒（fail closed）', () => {
    expect(() => readFileBytes(root, '../外部.png')).toThrow(/在工作区之外|路径不可用/)
    expect(() => readFileBytes(root, outside)).toThrow(/在工作区之外|路径不可用/)
    expect(() => readFileBytes(root, '\\\\server\\share\\a.png')).toThrow(/UNC|路径不可用/)
  })

  it('穿过符号链接的路径也拒', () => {
    try {
      symlinkSync(outside, join(root, '链接'), 'junction')
    } catch {
      return
    }
    expect(() => readFileBytes(root, '链接/外部.png')).toThrow(/在工作区之外/)
  })
})

describe('readFileBytes：按格式分桶的上限', () => {
  it('图片超过 8MB → too-large（连字节都不传）', () => {
    const name = '大图.png'
    const file = join(root, name)
    writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES)]))
    const result = readFileBytes(root, name)
    expect(result.kind).toBe('too-large')
    if (result.kind !== 'too-large') return
    expect(result.limit).toBe(PREVIEW_IMAGE_MAX_BYTES)
    expect(result.size).toBe(PREVIEW_IMAGE_MAX_BYTES + PNG.length)
  })

  it('PDF 的上限更宽（32MB）：8MB 的 PDF 仍然读得回来', () => {
    const name = '大报告.pdf'
    writeFileSync(join(root, name), Buffer.concat([PDF, Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES + 1)]))
    const result = readFileBytes(root, name)
    expect(result.kind).toBe('bytes')
    expect(PREVIEW_PDF_MAX_BYTES).toBeGreaterThan(PREVIEW_IMAGE_MAX_BYTES)
  })
})
