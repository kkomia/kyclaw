// @vitest-environment node
/**
 * glob 工具：`**` 语义 / 起始目录语义 / ≤200 条截断 / 链接（junction）不逃逸 / 失败路径。
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GLOB_MAX_RESULTS, createGlobTool } from '../glob'
import { nodeToolFs } from '../guard'
import { callTool, createBed, under, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

/** 结果文本 → 相对工作区的路径数组（注记段以空行 + [ 开头，先切掉） */
function resultPaths(out: unknown): string[] {
  const text = String(out)
  const [body] = text.split('\n\n[')
  if (body.trim() === '') return []
  return body.split('\n').map((line) => under(bed.root, line))
}

describe('glob：模式语义', () => {
  it('`**` 递归匹配，只给文件；`*` 不跨目录', async () => {
    const tool = await createGlobTool(bed.ctx)
    mkdirSync(join(bed.root, 'src', 'nested'), { recursive: true })
    writeFileSync(join(bed.root, 'src', 'a.ts'), '')
    writeFileSync(join(bed.root, 'src', 'nested', 'b.ts'), '')
    writeFileSync(join(bed.root, 'src', 'notes.txt'), '')
    writeFileSync(join(bed.root, 'README.md'), '')

    expect(resultPaths(await callTool(tool, { pattern: '**/*.ts' }))).toEqual([
      'src/a.ts',
      'src/nested/b.ts'
    ])
    expect(resultPaths(await callTool(tool, { pattern: '*.md' }))).toEqual(['README.md'])
    expect(resultPaths(await callTool(tool, { pattern: 'src/*.txt' }))).toEqual(['src/notes.txt'])
  })

  it('path 指定起始目录（相对工作区）', async () => {
    const tool = await createGlobTool(bed.ctx)
    mkdirSync(join(bed.root, 'src'), { recursive: true })
    writeFileSync(join(bed.root, 'src', 'a.ts'), '')
    writeFileSync(join(bed.root, 'top.ts'), '')

    expect(resultPaths(await callTool(tool, { pattern: '*.ts', path: 'src' }))).toEqual([
      'src/a.ts'
    ])
  })

  it('没有匹配：一句人话（不是空响应）', async () => {
    const tool = await createGlobTool(bed.ctx)
    const out = String(await callTool(tool, { pattern: '*.nope' }))
    expect(out).toContain('没有匹配')
  })

  it('glob 实现抛错（模式不合法等）：换成一句人话，不带原生报错', async () => {
    const broken = createBed({
      fs: {
        ...nodeToolFs,
        glob: async () => {
          throw new Error('Invalid glob pattern')
        }
      }
    })
    try {
      const tool = await createGlobTool(broken.ctx)
      await expect(callTool(tool, { pattern: '**/*' })).rejects.toThrow(/glob 模式不合法/)
    } finally {
      broken.dispose()
    }
  })
})

describe('glob：截断契约（≤200 条）', () => {
  it('超过 200 条只给前 200 条 + 提示', async () => {
    const tool = await createGlobTool(bed.ctx)
    mkdirSync(join(bed.root, 'many'))
    for (let index = 0; index < GLOB_MAX_RESULTS + 5; index++) {
      writeFileSync(join(bed.root, 'many', `f${String(index).padStart(3, '0')}.txt`), '')
    }

    const out = String(await callTool(tool, { pattern: 'many/*.txt' }))
    expect(resultPaths(out)).toHaveLength(GLOB_MAX_RESULTS)
    expect(out).toContain(`[匹配太多，只显示前 ${GLOB_MAX_RESULTS} 条]`)
  })
})

describe('glob：边界与失败', () => {
  it('链接（junction）指到工作区外：结果里没有它后面的文件', async () => {
    const tool = await createGlobTool(bed.ctx)
    writeFileSync(join(bed.outside, 'secret.txt'), 'secret')
    let linked = true
    try {
      symlinkSync(bed.outside, join(bed.root, 'link'), 'junction')
    } catch {
      linked = false // 非 Windows 的 'junction' 不被支持；下面的显式模式断言跳过
    }
    writeFileSync(join(bed.root, 'inside.txt'), '')

    const recursive = resultPaths(await callTool(tool, { pattern: '**/*.txt' }))
    expect(recursive).toContain('inside.txt')
    expect(recursive.some((path) => path.includes('secret.txt'))).toBe(false)

    if (linked) {
      // 显式走链接（node glob 会顺着链接找）：引擎 realpath 后应判定越界并过滤
      const throughLink = String(await callTool(tool, { pattern: 'link/*.txt' }))
      expect(throughLink).toContain('没有匹配')
      expect(throughLink).not.toContain('secret.txt')
    }
  })

  it('path 在工作区外：拒绝', async () => {
    const tool = await createGlobTool(bed.ctx)
    await expect(callTool(tool, { pattern: '*', path: bed.outside })).rejects.toThrow(/授权工作区/)
  })

  it('多个工作区又没给 path：要求显式指定', async () => {
    const tool = await createGlobTool(bed.ctx)
    const second = createBed()
    bed.roots.push(second.roots[0])
    try {
      await expect(callTool(tool, { pattern: '*' })).rejects.toThrow(/多个授权工作区/)
    } finally {
      second.dispose()
    }
  })
})
