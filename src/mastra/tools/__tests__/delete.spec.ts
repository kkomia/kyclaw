// @vitest-environment node
/**
 * delete 工具（round28 模块 1）：删文件 / 空目录 / 递归目录、工作区边界 fail closed、
 * 工作区根不删、目录非空的人话提示、危险档审批（full 与规则都不放行）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeleteTool } from '../delete'
import { callTool, createBed, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('delete：删除行为', () => {
  it('删除文件：文件消失，回执带"文件"与绝对路径', async () => {
    const tool = await createDeleteTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'x')

    const out = String(await callTool(tool, { path: 'a.txt' }))
    expect(existsSync(join(bed.root, 'a.txt'))).toBe(false)
    expect(out).toContain('已删除文件')
    expect(out).toContain(join(bed.root, 'a.txt'))
  })

  it('空目录：缺省（recursive=false）就能删', async () => {
    const tool = await createDeleteTool(bed.ctx)
    mkdirSync(join(bed.root, 'empty'))

    const out = String(await callTool(tool, { path: 'empty' }))
    expect(existsSync(join(bed.root, 'empty'))).toBe(false)
    expect(out).toContain('空目录')
  })

  it('非空目录：缺省拒绝，提示 recursive，目录还在', async () => {
    const tool = await createDeleteTool(bed.ctx)
    mkdirSync(join(bed.root, 'full'))
    writeFileSync(join(bed.root, 'full', 'x.txt'), 'x')

    await expect(callTool(tool, { path: 'full' })).rejects.toThrow(/目录非空.*recursive/)
    expect(existsSync(join(bed.root, 'full', 'x.txt'))).toBe(true)
  })

  it('非空目录 recursive=true：整树删除', async () => {
    const tool = await createDeleteTool(bed.ctx)
    mkdirSync(join(bed.root, 'full', 'deep'), { recursive: true })
    writeFileSync(join(bed.root, 'full', 'deep', 'x.txt'), 'x')

    const out = String(await callTool(tool, { path: 'full', recursive: true }))
    expect(existsSync(join(bed.root, 'full'))).toBe(false)
    expect(out).toContain('目录（含内容）')
  })

  it('不存在：明确报错（不是静默成功）', async () => {
    const tool = await createDeleteTool(bed.ctx)
    await expect(callTool(tool, { path: 'nope.txt' })).rejects.toThrow(/不存在/)
  })
})

describe('delete：边界', () => {
  it('工作区外：拒绝（fail closed），文件原样', async () => {
    const tool = await createDeleteTool(bed.ctx)
    const target = join(bed.outside, 'secret.txt')
    writeFileSync(target, 'secret')

    await expect(callTool(tool, { path: target })).rejects.toThrow(/授权工作区/)
    await expect(callTool(tool, { path: '../outside/secret.txt' })).rejects.toThrow(/授权工作区/)
    expect(existsSync(target)).toBe(true)
  })

  it('工作区根目录本身：拒绝（手滑 `path: "."` 不会清空工作区）', async () => {
    const tool = await createDeleteTool(bed.ctx)
    writeFileSync(join(bed.root, 'keep.txt'), 'keep')

    await expect(callTool(tool, { path: '.' })).rejects.toThrow(/工作区根目录/)
    await expect(callTool(tool, { path: bed.root, recursive: true })).rejects.toThrow(
      /工作区根目录/
    )
    expect(existsSync(join(bed.root, 'keep.txt'))).toBe(true)
  })
})

describe('delete：审批 gate（round 75 起跟着档位走）', () => {
  it('区内 full → 免审；区内 ask → 问，有"永久允许"规则则免审', async () => {
    const tool = await createDeleteTool(bed.ctx)
    const gate = tool.requireApproval as unknown as (input: { path: string }) => boolean

    // 用户口径：设了全免就是全免（delete 不再"永远问"）
    bed.roots[0].mode = 'full'
    expect(gate({ path: 'a.txt' })).toBe(false)

    bed.roots[0].mode = 'ask'
    expect(gate({ path: 'a.txt' })).toBe(true)
    bed.rules.push({ tool: 'delete', workspace: bed.root, mode: 'allow' })
    expect(gate({ path: 'a.txt' })).toBe(false)
  })
})
