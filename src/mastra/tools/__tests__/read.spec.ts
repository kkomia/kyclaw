// @vitest-environment node
/**
 * read 工具：整文件 / 行窗口 / 截断契约（>256KB 提示且不切碎多字节字符）/ 工作区边界 / 已读记录。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadTool, READ_MAX_BYTES } from '../read'
import { callTool, createBed, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('read：内容与行窗口', () => {
  it('整文件原样读回（CJK + CRLF 不做任何改写）', async () => {
    const tool = await createReadTool(bed.ctx)
    const content = '第一行\r\n第二行 你好\n第三行 👨‍👩‍👧‍👦'
    writeText(join(bed.root, 'a.txt'), content)
    await expect(callTool(tool, { path: 'a.txt' })).resolves.toBe(content)
  })

  it('offset/limit 按行取窗口，并注明窗口范围与总行数', async () => {
    const tool = await createReadTool(bed.ctx)
    const lines = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`)
    writeText(join(bed.root, 'lines.txt'), lines.join('\n'))

    const out = String(await callTool(tool, { path: 'lines.txt', offset: 3, limit: 4 }))
    expect(out.startsWith('line-3\nline-4\nline-5\nline-6')).toBe(true)
    expect(out).toContain('[只显示第 3-6 行，文件共 10 行]')
  })

  it('offset 超出文件行数：明确报错（不是静默给空）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'two.txt'), 'a\nb')
    await expect(callTool(tool, { path: 'two.txt', offset: 5 })).rejects.toThrow(/超出/)
  })

  it('读过就记进当前会话（edit 的未读先改靠它）；别的会话不算', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'x')

    await callTool(tool, { path: 'a.txt' }, 'thread-1')
    expect(bed.ctx.state.wasRead('thread-1', join(bed.root, 'a.txt'))).toBe(true)
    expect(bed.ctx.state.wasRead('thread-2', join(bed.root, 'a.txt'))).toBe(false)
  })
})

describe('read：截断契约（>256KB）', () => {
  it('超过 256KB 截断：给提示，且不切碎多字节字符（无 U+FFFD）', async () => {
    const tool = await createReadTool(bed.ctx)
    // 刀口落在"好"（3 字节）中间：先铺 (256KB - 2) 个 ASCII，再一串"好"
    const body = 'x'.repeat(READ_MAX_BYTES - 2) + '好'.repeat(64)
    writeText(join(bed.root, 'big.txt'), body)

    const out = String(await callTool(tool, { path: 'big.txt' }))
    expect(out).toContain(`[已截断：文件共 ${Buffer.byteLength(body, 'utf8')} 字节`)
    expect(out).not.toContain('\uFFFD')
    const [content] = out.split('\n\n[')
    expect(content).toBe('x'.repeat(READ_MAX_BYTES - 2))
  })

  it('恰好 256KB 不算截断（边界不多不少）', async () => {
    const tool = await createReadTool(bed.ctx)
    const body = 'a'.repeat(READ_MAX_BYTES)
    writeText(join(bed.root, 'exact.txt'), body)

    const out = String(await callTool(tool, { path: 'exact.txt' }))
    expect(out).toBe(body)
    expect(out).not.toContain('已截断')
  })
})

describe('read：边界与失败', () => {
  it('目标不是文件（目录）：报错并提示用 glob', async () => {
    const tool = await createReadTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))
    await expect(callTool(tool, { path: 'sub' })).rejects.toThrow(/glob/)
  })

  it('工作区外：拒绝（fail closed）', async () => {
    const tool = await createReadTool(bed.ctx)
    writeText(join(bed.outside, 'secret.txt'), 'secret')
    await expect(callTool(tool, { path: join(bed.outside, 'secret.txt') })).rejects.toThrow(
      /授权工作区/
    )
    await expect(callTool(tool, { path: '../outside/secret.txt' })).rejects.toThrow(/授权工作区/)
  })

  it('一个工作区都没有：拒绝原因指向设置里的工作区', async () => {
    const tool = await createReadTool(bed.ctx)
    bed.roots.length = 0
    await expect(callTool(tool, { path: 'a.txt' })).rejects.toThrow(/授权工作区/)
  })

  it('文件不存在：报错（不是空内容）', async () => {
    const tool = await createReadTool(bed.ctx)
    await expect(callTool(tool, { path: 'nope.txt' })).rejects.toThrow(/不存在|不是文件/)
  })
})
