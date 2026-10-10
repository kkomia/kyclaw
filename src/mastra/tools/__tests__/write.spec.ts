// @vitest-environment node
/**
 * write 工具：创建（父目录自动建）/ 覆盖 / 工作区外拒绝 / 写后可改（已读记录）/ 审批 gate 形状。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEditTool } from '../edit'
import { createWriteTool } from '../write'
import { callTool, createBed, readText, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('write：创建与覆盖', () => {
  it('创建：中间目录自动建，回执带"已创建"与 UTF-8 字节数', async () => {
    const tool = await createWriteTool(bed.ctx)
    const out = String(await callTool(tool, { path: 'sub/dir/new.txt', content: '你好' }))

    expect(readText(join(bed.root, 'sub', 'dir', 'new.txt'))).toBe('你好')
    expect(out).toContain('已创建')
    expect(out).toContain('6 字节') // "你好" = 2 × 3 字节
  })

  it('覆盖：整文件替换，回执带"已覆盖"', async () => {
    const tool = await createWriteTool(bed.ctx)
    writeText(join(bed.root, 'a.txt'), 'old')

    const out = String(await callTool(tool, { path: 'a.txt', content: 'new' }))
    expect(readText(join(bed.root, 'a.txt'))).toBe('new')
    expect(out).toContain('已覆盖')
  })

  it('写入后同一文件可直接 edit（write 也记"已读"）', async () => {
    const write = await createWriteTool(bed.ctx)
    const edit = await createEditTool(bed.ctx)

    await callTool(write, { path: 'w.txt', content: 'old text' })
    await expect(
      callTool(edit, { path: 'w.txt', oldText: 'old', newText: 'new' })
    ).resolves.toContain('已替换')
    expect(readText(join(bed.root, 'w.txt'))).toBe('new text')
  })
})

describe('write：边界与失败', () => {
  it('工作区外：拒绝，且不动原文件', async () => {
    const tool = await createWriteTool(bed.ctx)
    const target = join(bed.outside, 'x.txt')
    writeText(target, 'original')

    await expect(callTool(tool, { path: target, content: 'hacked' })).rejects.toThrow(/授权工作区/)
    await expect(callTool(tool, { path: '../outside/y.txt', content: 'hacked' })).rejects.toThrow(
      /授权工作区/
    )
    expect(readText(target)).toBe('original')
  })

  it('目标是目录：拒绝（不把它当文件写）', async () => {
    const tool = await createWriteTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))
    await expect(callTool(tool, { path: 'sub', content: 'x' })).rejects.toThrow(/目录/)
  })
})

describe('write：审批 gate（spec §5.2）', () => {
  it('ask 工作区要求审批；full 工作区放行（gate 就在工具定义上）', async () => {
    const write = await createWriteTool(bed.ctx)
    const gate = write.requireApproval as unknown as (input: {
      path: string
      content: string
    }) => boolean

    expect(gate({ path: 'a.txt', content: 'x' })).toBe(true)
    bed.roots[0].mode = 'full'
    expect(gate({ path: 'a.txt', content: 'x' })).toBe(false)
  })
})
