// @vitest-environment node
/**
 * move 工具（round28 模块 1）：重命名 / 移动（父目录自动建）/ 覆盖显式 /
 * 拒绝目录进自身 / 工作区边界与根目录保护 / 危险档审批。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMoveTool } from '../move'
import { callTool, createBed, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('move：移动与重命名', () => {
  it('同目录重命名：旧名消失、新名有内容', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'old.txt'), '内容')

    const out = String(await callTool(tool, { path: 'old.txt', to: 'new.txt' }))
    expect(existsSync(join(bed.root, 'old.txt'))).toBe(false)
    expect(readFileSync(join(bed.root, 'new.txt'), 'utf8')).toBe('内容')
    expect(out).toContain('已移动')
    expect(out).toContain(join(bed.root, 'new.txt'))
  })

  it('移动到子目录：目标父目录自动创建', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'x')

    await callTool(tool, { path: 'a.txt', to: 'docs/deep/a.txt' })
    expect(readFileSync(join(bed.root, 'docs', 'deep', 'a.txt'), 'utf8')).toBe('x')
  })

  it('移动目录（连同内容）', async () => {
    const tool = await createMoveTool(bed.ctx)
    mkdirSync(join(bed.root, 'pkg'))
    writeFileSync(join(bed.root, 'pkg', 'index.ts'), 'x')

    await callTool(tool, { path: 'pkg', to: 'packages/pkg' })
    expect(readFileSync(join(bed.root, 'packages', 'pkg', 'index.ts'), 'utf8')).toBe('x')
    expect(existsSync(join(bed.root, 'pkg'))).toBe(false)
  })

  it('目标已存在：缺省不覆盖（源与目标都不动）', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'src.txt'), 'SRC')
    writeFileSync(join(bed.root, 'dst.txt'), 'DST')

    await expect(callTool(tool, { path: 'src.txt', to: 'dst.txt' })).rejects.toThrow(/目标已存在/)
    expect(readFileSync(join(bed.root, 'src.txt'), 'utf8')).toBe('SRC')
    expect(readFileSync(join(bed.root, 'dst.txt'), 'utf8')).toBe('DST')
  })

  it('overwrite=true：覆盖目标文件（回执注明）', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'src.txt'), 'SRC')
    writeFileSync(join(bed.root, 'dst.txt'), 'DST')

    const out = String(await callTool(tool, { path: 'src.txt', to: 'dst.txt', overwrite: true }))
    expect(readFileSync(join(bed.root, 'dst.txt'), 'utf8')).toBe('SRC')
    expect(existsSync(join(bed.root, 'src.txt'))).toBe(false)
    expect(out).toContain('覆盖了原文件')
  })

  it('目标已存在且是目录：即使 overwrite 也拒绝', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'src.txt'), 'SRC')
    mkdirSync(join(bed.root, 'dst-dir'))

    await expect(
      callTool(tool, { path: 'src.txt', to: 'dst-dir', overwrite: true })
    ).rejects.toThrow(/不覆盖目录/)
    expect(existsSync(join(bed.root, 'src.txt'))).toBe(true)
  })
})

describe('move：边界与拒绝', () => {
  it('源不存在：明确报错', async () => {
    const tool = await createMoveTool(bed.ctx)
    await expect(callTool(tool, { path: 'nope.txt', to: 'x.txt' })).rejects.toThrow(/源路径不存在/)
  })

  it('源与目标相同：拒绝', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'x')
    await expect(callTool(tool, { path: 'a.txt', to: 'a.txt' })).rejects.toThrow(/同一个路径/)
  })

  it('目录移动到它自己内部：拒绝，结构不动', async () => {
    const tool = await createMoveTool(bed.ctx)
    mkdirSync(join(bed.root, 'pkg'))
    writeFileSync(join(bed.root, 'pkg', 'a.ts'), 'x')

    await expect(callTool(tool, { path: 'pkg', to: 'pkg/inner' })).rejects.toThrow(/自己内部/)
    expect(existsSync(join(bed.root, 'pkg', 'a.ts'))).toBe(true)
  })

  it('工作区外的目标：拒绝（fail closed），工作区内没动静', async () => {
    const tool = await createMoveTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'x')

    await expect(callTool(tool, { path: 'a.txt', to: join(bed.outside, 'a.txt') })).rejects.toThrow(
      /授权工作区/
    )
    expect(existsSync(join(bed.root, 'a.txt'))).toBe(true)
    expect(existsSync(join(bed.outside, 'a.txt'))).toBe(false)
  })

  it('工作区根目录本身：拒绝', async () => {
    const tool = await createMoveTool(bed.ctx)
    await expect(callTool(tool, { path: '.', to: 'renamed' })).rejects.toThrow(/工作区根目录/)
  })
})

describe('move：审批 gate（round 75 起跟着档位走）', () => {
  it('区内 full → 免审；区内 ask → 问，有"永久允许"规则则免审', async () => {
    const tool = await createMoveTool(bed.ctx)
    const gate = tool.requireApproval as unknown as (input: { path: string; to: string }) => boolean

    bed.roots[0].mode = 'full'
    expect(gate({ path: 'a.txt', to: 'b.txt' })).toBe(false)

    bed.roots[0].mode = 'ask'
    expect(gate({ path: 'a.txt', to: 'b.txt' })).toBe(true)
    bed.rules.push({ tool: 'move', workspace: bed.root, mode: 'allow' })
    expect(gate({ path: 'a.txt', to: 'b.txt' })).toBe(false)
  })
})
