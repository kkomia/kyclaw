// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TEXT_FILE_MAX_BYTES,
  TEXT_PAGE_MAX_BYTES,
  TEXT_PAGE_MAX_LINE_BYTES,
  type TextPage,
  type TextPageCursor,
  type TextPageResult
} from '../../shared/workbench-text'
import { readTextPage, textVersionOf } from '../workbench-text'

/**
 * 文本分页：一页一页读完一份文本，页边界与 UTF-8 边界上都不出岔子。
 * 全在 mkdtemp 的真目录上跑，不碰用户目录（`outside` 用来验 containment）。
 */
let root: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-text-page-'))
  outside = mkdtempSync(join(tmpdir(), 'kyclaw-text-outside-'))
  writeFileSync(join(root, '小.txt'), '第一行\n第二行\n第三行\n', 'utf8')
  mkdirSync(join(root, '目录'))
  writeFileSync(join(outside, '外面.txt'), '外面的内容\n', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** 断言回包是 `page` 并收窄（失败时给出实际 kind，便于排障） */
function asPage(result: TextPageResult): TextPage {
  if (result.kind !== 'page') throw new Error(`期望 page，实际是 ${result.kind}`)
  return result
}

/** 一路读到 eof，把各页拼起来（就是"渲染端累加"那条路） */
async function readAll(relative: string): Promise<string> {
  let cursor: TextPageCursor | null = null
  let text = ''
  for (let guard = 0; guard < 2000; guard += 1) {
    const page = asPage(await readTextPage(root, relative, cursor))
    text += page.text
    if (page.eof) return text
    cursor = { offset: page.nextOffset, version: page.version }
  }
  throw new Error('读到上限还没读完（用例自身有问题）')
}

describe('readTextPage：一页读完与游标', () => {
  it('小文件一页到底：offset 0、eof、nextOffset = 文件大小、version 与 stat 同派生', async () => {
    const page = asPage(await readTextPage(root, '小.txt', null))
    const info = statSync(join(root, '小.txt'))
    expect(page.text).toBe('第一行\n第二行\n第三行\n')
    expect(page.offset).toBe(0)
    expect(page.size).toBe(info.size)
    expect(page.nextOffset).toBe(info.size)
    expect(page.eof).toBe(true)
    expect(page.overlongLine).toBe(false)
    // version 与办公档同一条派生口径：size:mtimeMs
    expect(page.version).toBe(`${info.size}:${info.mtimeMs}`)
  })

  it('空文件：一页、空文本、eof', async () => {
    writeFileSync(join(root, '空.txt'), '', 'utf8')
    const page = asPage(await readTextPage(root, '空.txt', null))
    expect(page.text).toBe('')
    expect(page.eof).toBe(true)
    expect(page.nextOffset).toBe(0)
  })

  it('跨页拼接 = 原文（含中文多字节，逐字符核对）', async () => {
    const lines: string[] = []
    for (let index = 0; index < 40_000; index += 1) {
      lines.push(`第 ${index} 行：中文内容 ${index % 97} 与尾巴`)
    }
    const content = `${lines.join('\n')}\n`
    writeFileSync(join(root, '大.txt'), content, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(TEXT_PAGE_MAX_BYTES * 2)

    expect(await readAll('大.txt')).toBe(content)
  })

  it('每一页都收在换行之后（除 EOF 那页），游标严格前进', async () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
    const content = `${lines.join('\n')}\n`
    writeFileSync(join(root, '多行.txt'), content, 'utf8')

    let cursor: TextPageCursor | null = null
    let text = ''
    let lastOffset = -1
    for (let guard = 0; guard < 500; guard += 1) {
      const page = asPage(await readTextPage(root, '多行.txt', cursor))
      expect(page.offset).toBeGreaterThan(lastOffset)
      lastOffset = page.offset
      if (!page.eof) expect(page.text.endsWith('\n')).toBe(true)
      text += page.text
      if (page.eof) break
      cursor = { offset: page.nextOffset, version: page.version }
    }
    expect(text).toBe(content)
  })
})

describe('readTextPage：超长单行', () => {
  it('一行 500KB 没有换行：按上限切开（overlongLine 为真），拼接仍是原文', async () => {
    const content = 'x'.repeat(500_000)
    writeFileSync(join(root, '超长.txt'), content, 'utf8')

    const first = asPage(await readTextPage(root, '超长.txt', null))
    expect(first.overlongLine).toBe(true)
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(TEXT_PAGE_MAX_LINE_BYTES)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(first.eof).toBe(false)

    expect(await readAll('超长.txt')).toBe(content)
  })

  it('一行 200KB（没顶到一页上限）：一页到底，不切（页上限才是硬边界）', async () => {
    const content = 'y'.repeat(200_000)
    writeFileSync(join(root, '中等长行.txt'), content, 'utf8')

    const page = asPage(await readTextPage(root, '中等长行.txt', null))
    expect(page.overlongLine).toBe(false)
    expect(page.eof).toBe(true)
    expect(page.text).toBe(content)
  })

  it('超长行后面还有正常行：切开之后照常按行收页', async () => {
    const content = `${'z'.repeat(400_000)}\n普通一行\n`
    writeFileSync(join(root, '超长后.txt'), content, 'utf8')
    expect(await readAll('超长后.txt')).toBe(content)
  })
})

describe('readTextPage：版本校验与失败判别', () => {
  it('带上过期 version 续读 → changed（不交半截）', async () => {
    const first = asPage(await readTextPage(root, '小.txt', null))
    // 文件被改（size 变了 → version 必变）
    writeFileSync(join(root, '小.txt'), '换了内容\n', 'utf8')
    const result = await readTextPage(root, '小.txt', { offset: 0, version: first.version })
    expect(result).toEqual({ kind: 'changed' })
  })

  it('NUL 当页：第一页回 binary、续读回 changed（内容已经不是那份文本了）', async () => {
    writeFileSync(join(root, '二进制.txt'), Buffer.from('前一半\n\u0000后一半\n', 'utf8'))
    expect((await readTextPage(root, '二进制.txt', null)).kind).toBe('binary')

    // "先像文本、后段才遇到 NUL"：NUL 放在第一窗（256KB）**之后**，一路续读才会撞上
    const head = 'a'.repeat(300_000)
    const buffer = Buffer.concat([
      Buffer.from('x\n', 'utf8'),
      Buffer.from(head, 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('尾部\n', 'utf8')
    ])
    writeFileSync(join(root, '后段二进制.txt'), buffer)

    let cursor: TextPageCursor | null = null
    let outcome: string = 'page'
    for (let guard = 0; guard < 200; guard += 1) {
      const result = await readTextPage(root, '后段二进制.txt', cursor)
      outcome = result.kind
      if (result.kind !== 'page') break
      cursor = { offset: result.nextOffset, version: result.version }
    }
    expect(outcome).toBe('changed')
  })

  it('文件没了 → missing；目录 → 抛人话；越界路径 → 抛', async () => {
    expect(await readTextPage(root, '不存在.txt', null)).toEqual({ kind: 'missing' })
    await expect(readTextPage(root, '目录', null)).rejects.toThrow('文件夹')
    // 会话根本身（relative = ''）与目录同一句人话
    await expect(readTextPage(root, '', null)).rejects.toThrow('文件夹')
    await expect(readTextPage(root, '../外面.txt', null)).rejects.toThrow()
  })

  it('超过 64MB → too-large（稀疏文件，不真占盘）', async () => {
    writeFileSync(join(root, '巨大.log'), 'x', 'utf8')
    truncateSync(join(root, '巨大.log'), TEXT_FILE_MAX_BYTES + 1)
    expect(await readTextPage(root, '巨大.log', null)).toEqual({
      kind: 'too-large',
      size: TEXT_FILE_MAX_BYTES + 1,
      limit: TEXT_FILE_MAX_BYTES
    })
  })
})

describe('textVersionOf：只 stat 的版本探询', () => {
  it('回版本与大小；改过之后版本变', () => {
    const info = statSync(join(root, '小.txt'))
    const before = textVersionOf(root, '小.txt')
    expect(before).toEqual({
      kind: 'version',
      version: `${info.size}:${info.mtimeMs}`,
      size: info.size
    })

    writeFileSync(join(root, '小.txt'), '改大一点的内容\n', 'utf8')
    expect(textVersionOf(root, '小.txt')).not.toEqual(before)
  })

  it('文件没了 → missing；目录 → 抛人话；越界 → 抛', () => {
    expect(textVersionOf(root, '没有这个.txt')).toEqual({ kind: 'missing' })
    expect(() => textVersionOf(root, '目录')).toThrow('文件夹')
    expect(() => textVersionOf(root, '../外面.txt')).toThrow()
  })
})
