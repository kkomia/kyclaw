// @vitest-environment node
/**
 * edit 工具：Review Focus #3 —— CJK/emoji 精确替换（不做任何 normalize、不切代理对）、
 * 未读先改拒绝（会话级 read 记录）、同文件并发串行化（per-file 队列）、CRLF 兜底。
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeToolFs } from '../guard'
import { createEditTool } from '../edit'
import { createReadTool } from '../read'
import { callTool, createBed, readText, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

/** 先 read 再 edit 的正常姿势（大多数用例的起手式） */
async function readFirst(path: string, session = 'session-1'): Promise<void> {
  const read = await createReadTool(bed.ctx)
  await callTool(read, { path }, session)
}

describe('edit：未读先改拒绝', () => {
  it('没 read 过就 edit：拒绝，文件不动', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'hello')

    await expect(
      callTool(edit, { path: 'a.txt', oldText: 'hello', newText: 'hi' })
    ).rejects.toThrow(/未读先改/)
    expect(readText(join(bed.root, 'a.txt'))).toBe('hello')
  })

  it('read 记录按会话隔离：另一个会话里读过不算数', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'hello')
    await readFirst('a.txt', 'thread-1')

    await expect(
      callTool(edit, { path: 'a.txt', oldText: 'hello', newText: 'hi' }, 'thread-2')
    ).rejects.toThrow(/未读先改/)
  })

  it('read 过再 edit：放行', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'hello')
    await readFirst('a.txt')

    await expect(
      callTool(edit, { path: 'a.txt', oldText: 'hello', newText: 'hi' })
    ).resolves.toContain('已替换 1 处')
    expect(readText(join(bed.root, 'a.txt'))).toBe('hi')
  })
})

describe('edit：CJK / emoji 精确替换（Review Focus #3）', () => {
  it('CJK 替换：文件其余部分逐字不变', async () => {
    const edit = await createEditTool(bed.ctx)
    const original = '标题：你好，世界\n副标题：emoji 👨‍👩‍👧‍👦 家族\n尾部：中文'
    writeText(join(bed.root, 'cjk.txt'), original)
    await readFirst('cjk.txt')

    await callTool(edit, { path: 'cjk.txt', oldText: '你好，世界', newText: 'こんにちは、世界' })
    expect(readText(join(bed.root, 'cjk.txt'))).toBe(
      '标题：こんにちは、世界\n副标题：emoji 👨‍👩‍👧‍👦 家族\n尾部：中文'
    )
  })

  it('emoji（代理对 + ZWJ 序列）作为被替换文本：精确且不切碎', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'emoji.txt'), 'front🙂back 👨‍👩‍👧‍👦 end')
    await readFirst('emoji.txt')

    await callTool(edit, { path: 'emoji.txt', oldText: '🙂', newText: '🎉🎊' })
    expect(readText(join(bed.root, 'emoji.txt'))).toBe('front🎉🎊back 👨‍👩‍👧‍👦 end')

    await callTool(edit, { path: 'emoji.txt', oldText: '👨‍👩‍👧‍👦', newText: '家庭' })
    expect(readText(join(bed.root, 'emoji.txt'))).toBe('front🎉🎊back 家庭 end')
  })

  it('不做 NFD/NFC 归一：NFC 的 oldText 匹配不到 NFD 文件（失败也不改文件），NFD 原文才匹配', async () => {
    const edit = await createEditTool(bed.ctx)
    const nfd = 'caf\u0065\u0301 咖啡' // e + 组合尖音符（NFD）
    writeText(join(bed.root, 'nfd.txt'), nfd)
    await readFirst('nfd.txt')

    await expect(
      callTool(edit, { path: 'nfd.txt', oldText: 'caf\u00e9 咖啡', newText: 'x' })
    ).rejects.toThrow(/没有找到/)
    expect(readText(join(bed.root, 'nfd.txt'))).toBe(nfd)

    await callTool(edit, { path: 'nfd.txt', oldText: nfd, newText: `${nfd}！` })
    expect(readText(join(bed.root, 'nfd.txt'))).toBe(`${nfd}！`)
  })

  it('匹配不落在代理对中间：孤立低代理项不算命中（不做半个 emoji 的替换）', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'pair.txt'), 'a👍b')
    await readFirst('pair.txt')

    await expect(
      callTool(edit, { path: 'pair.txt', oldText: '\uDC4D', newText: 'X' })
    ).rejects.toThrow(/没有找到/)
    expect(readText(join(bed.root, 'pair.txt'))).toBe('a👍b')
  })
})

describe('edit：匹配唯一性与失败', () => {
  it('oldText 出现多处：拒绝并报数量，文件不动', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'multi.txt'), 'aaa')
    await readFirst('multi.txt')

    await expect(callTool(edit, { path: 'multi.txt', oldText: 'a', newText: 'b' })).rejects.toThrow(
      /3 处/
    )
    expect(readText(join(bed.root, 'multi.txt'))).toBe('aaa')
  })

  it('oldText 没命中：拒绝，文件不动', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'none.txt'), 'hello world')
    await readFirst('none.txt')

    await expect(
      callTool(edit, { path: 'none.txt', oldText: 'nope', newText: 'x' })
    ).rejects.toThrow(/没有找到/)
    expect(readText(join(bed.root, 'none.txt'))).toBe('hello world')
  })

  it('oldText 为空：拒绝（空串能匹配任何位置），文件不动', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'empty.txt'), 'x')
    await readFirst('empty.txt')

    // 入参 schema（zod min(1)）先拦下：Mastra 把校验失败当结构化错误返回，而不是抛
    const result = (await callTool(edit, { path: 'empty.txt', oldText: '', newText: 'x' })) as {
      error?: unknown
      message?: string
    }
    expect(result.error).toBe(true)
    expect(String(result.message)).toContain('oldText')
    expect(readText(join(bed.root, 'empty.txt'))).toBe('x')
  })

  it('工作区外：拒绝', async () => {
    const edit = await createEditTool(bed.ctx)
    const target = join(bed.outside, 'x.txt')
    writeText(target, 'abc')
    // 绕过"未读"检查：直接给引擎认不出的路径，失败点应是路径而不是未读
    await expect(callTool(edit, { path: target, oldText: 'abc', newText: 'x' })).rejects.toThrow(
      /未读先改|授权工作区/
    )
    expect(readText(target)).toBe('abc')
  })
})

describe('edit：CRLF 兜底（Windows 文件的常见姿势）', () => {
  it('文件是 CRLF、oldText 用 LF：按 CRLF 匹配并保持 CRLF 行尾', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'crlf.txt'), 'line1\r\nline2\r\nline3\r\n')
    await readFirst('crlf.txt')

    const out = String(
      await callTool(edit, {
        path: 'crlf.txt',
        oldText: 'line1\nline2',
        newText: 'first\nsecond'
      })
    )
    expect(readText(join(bed.root, 'crlf.txt'))).toBe('first\r\nsecond\r\nline3\r\n')
    expect(out).toContain('CRLF')
  })

  it('文件是 LF：oldText 的 LF 精确匹配，不做多余的 CRLF 转换', async () => {
    const edit = await createEditTool(bed.ctx)
    writeText(join(bed.root, 'lf.txt'), 'line1\nline2\n')
    await readFirst('lf.txt')

    const out = String(
      await callTool(edit, { path: 'lf.txt', oldText: 'line1\nline2', newText: 'one\ntwo' })
    )
    expect(readText(join(bed.root, 'lf.txt'))).toBe('one\ntwo\n')
    expect(out).not.toContain('CRLF')
  })
})

describe('edit：同文件并发串行化（per-file 队列）', () => {
  it('两个 edit 并发：第二个在第一个写完之后才读，不丢更新', async () => {
    let releaseFirstRead!: () => void
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve
    })
    let reads = 0
    const observed: string[] = []

    const slowBed = createBed({
      fs: {
        ...nodeToolFs,
        readFile: async (path, maxBytes) => {
          reads++
          // 卡住第一个 edit 的"读"，给第二个 edit 排队的机会
          if (reads === 1) await firstReadGate
          const buffer = await nodeToolFs.readFile(path, maxBytes)
          observed.push(buffer.toString('utf8'))
          return buffer
        }
      }
    })

    try {
      const target = join(slowBed.root, 'race.txt')
      writeText(target, 'X1')
      // 本用例只测队列：直接预置"已读"，把 read 工具排除在注入 fs 之外
      slowBed.ctx.state.markRead('session-1', target)
      const edit = await createEditTool(slowBed.ctx)

      const first = callTool(edit, { path: 'race.txt', oldText: 'X1', newText: 'A1' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const second = callTool(edit, { path: 'race.txt', oldText: 'A1', newText: 'B1' })
      releaseFirstRead()

      await expect(first).resolves.toContain('已替换 1 处')
      await expect(second).resolves.toContain('已替换 1 处')
      expect(readText(target)).toBe('B1')
      // 第二次读到的必须是第一个写完的 A1（不串行的话读到的是 X1，oldText 会失配）
      expect(observed).toEqual(['X1', 'A1'])
    } finally {
      slowBed.dispose()
    }
  })
})
