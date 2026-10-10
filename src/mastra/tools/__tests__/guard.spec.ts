// @vitest-environment node
/**
 * guard：文件工具的公共防线单测（T10 引擎的消费方）。
 * 审查点：路径解析只认引擎给的 abs、审批判定按 spec §5.2（读放行 / 写询问 / full 放行 / 危险永远问）、
 * 会话 read 记录与同文件队列。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION,
  needsApproval,
  nodeToolFs,
  resolveTarget,
  scanRoot,
  sessionKey,
  ToolState
} from '../guard'
import { createBed, writeText, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('resolveTarget：目标必须落在授权工作区内', () => {
  it('工作区内的相对路径与绝对路径都解析成引擎给的 abs', () => {
    const file = join(bed.root, 'a.txt')
    writeText(file, 'x')

    expect(resolveTarget(bed.ctx, 'a.txt')).toEqual({
      ok: true,
      abs: file,
      workspace: bed.roots[0]
    })
    expect(resolveTarget(bed.ctx, file)).toMatchObject({ ok: true, abs: file })
  })

  it('`..` 逃逸与工作区外绝对路径一律拒绝', () => {
    const escaped = resolveTarget(bed.ctx, '../outside/secret.txt')
    expect(escaped.ok).toBe(false)
    const absolute = resolveTarget(bed.ctx, join(bed.outside, 'secret.txt'))
    expect(absolute.ok).toBe(false)
    if (!absolute.ok) expect(absolute.reason).toContain('工作区')
  })

  it('一个工作区都没有：拒绝原因是"先添加工作区"（可给模型直接看）', () => {
    bed.roots.length = 0
    const resolved = resolveTarget(bed.ctx, 'a.txt')
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('授权工作区')
  })
})

describe('scanRoot：glob/grep 的起始目录', () => {
  it('没给 path：恰好一个工作区就用它', () => {
    const base = scanRoot(bed.ctx)
    expect(base.abs).toBe(bed.root)
  })

  it('给了 path：解析到工作区内的那个目录', () => {
    const base = scanRoot(bed.ctx, '.')
    expect(base.abs).toBe(bed.root)
  })

  it('多个工作区又没给 path：要求显式指定（列出有哪些）', () => {
    const second = createBed()
    bed.roots.push(second.roots[0])
    try {
      expect(() => scanRoot(bed.ctx)).toThrow(/多个授权工作区/)
    } finally {
      second.dispose()
    }
  })
})

describe('needsApproval：spec §5.2 的审批判定', () => {
  it('只读（read/glob/grep）放行', () => {
    expect(needsApproval(bed.ctx, 'read', { path: 'a.txt' })).toBe(false)
    expect(needsApproval(bed.ctx, 'glob', { pattern: '**/*' })).toBe(false)
    expect(needsApproval(bed.ctx, 'grep', { pattern: 'x' })).toBe(false)
  })

  it('写类在工作区 mode=ask 时要求审批；切到 full 放行', () => {
    expect(needsApproval(bed.ctx, 'write', { path: 'a.txt', content: 'x' })).toBe(true)
    expect(needsApproval(bed.ctx, 'edit', { path: 'a.txt', oldText: 'x', newText: 'y' })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(needsApproval(bed.ctx, 'write', { path: 'a.txt', content: 'x' })).toBe(false)
    expect(needsApproval(bed.ctx, 'edit', { path: 'a.txt', oldText: 'x', newText: 'y' })).toBe(
      false
    )
  })

  it('危险类（delete/move）永远问：full 也不放行', () => {
    bed.roots[0].mode = 'full'
    expect(needsApproval(bed.ctx, 'delete', { path: 'a.txt' })).toBe(true)
    expect(needsApproval(bed.ctx, 'move', { path: 'a.txt' })).toBe(true)
  })

  it('未知写类工具（MCP 等）没有可解析的目标：按"问"处理（保守）', () => {
    expect(needsApproval(bed.ctx, 'mcp__foo__do', { anything: 1 })).toBe(true)
  })

  it('写类但目标根本不在工作区：不问——工具马上会被 guard 拒掉，弹卡只是噪音', () => {
    expect(
      needsApproval(bed.ctx, 'write', { path: join(bed.outside, 'x.txt'), content: 'x' })
    ).toBe(false)
  })
})

describe('sessionKey / ToolState：会话级 read 记录与同文件队列', () => {
  it('会话键取 agent.threadId；拿不到就落公共桶', () => {
    expect(sessionKey({ agent: { threadId: 't1' } })).toBe('t1')
    expect(sessionKey({})).toBe(DEFAULT_SESSION)
    expect(sessionKey(undefined)).toBe(DEFAULT_SESSION)
  })

  it('read 记录按会话隔离', () => {
    const state = new ToolState()
    state.markRead('t1', 'C:/ws/a.txt')
    expect(state.wasRead('t1', 'C:/ws/a.txt')).toBe(true)
    expect(state.wasRead('t2', 'C:/ws/a.txt')).toBe(false)
  })

  it('runExclusive：同一个键串行，不同键互不阻塞', async () => {
    const state = new ToolState()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = state.runExclusive('a', async () => {
      order.push('a1-start')
      await gate
      order.push('a1-end')
      return 'a1'
    })
    const second = state.runExclusive('a', async () => {
      order.push('a2')
      return 'a2'
    })
    const other = state.runExclusive('b', async () => {
      order.push('b1')
      return 'b1'
    })

    await expect(other).resolves.toBe('b1')
    expect(order).toEqual(['a1-start', 'b1'])
    release()
    await expect(first).resolves.toBe('a1')
    await expect(second).resolves.toBe('a2')
    expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2'])
  })

  it('前一个任务失败不堵住后一个', async () => {
    const state = new ToolState()
    const failed = state.runExclusive('a', async () => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    await expect(state.runExclusive('a', async () => 'ok')).resolves.toBe('ok')
  })
})

describe('nodeToolFs：默认 fs 实现', () => {
  it('readFile 给了 maxBytes 就最多读这么多（大文件不进内存）', async () => {
    const file = join(bed.root, 'f.txt')
    writeFileSync(file, Buffer.from('abcdefgh'))
    const partial = await nodeToolFs.readFile(file, 3)
    expect(partial.toString('utf8')).toBe('abc')
    const whole = await nodeToolFs.readFile(file)
    expect(whole.toString('utf8')).toBe('abcdefgh')
  })
})
