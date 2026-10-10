// @vitest-environment node
/**
 * grep 工具：正则命中 / CJK / 二进制与 junction 跳过 / ≤100 条截断与码点截断 / glob 过滤 / .git 跳过 / 失败路径。
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GREP_MAX_HITS, GREP_MAX_LINE_CHARS, createGrepTool } from '../grep'
import { callTool, createBed, under, type TestBed } from './helpers'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

/** 结果文本 → 命中行数组（注记段以空行 + [ 开头） */
function hitLines(out: unknown): string[] {
  const [body] = String(out).split('\n\n[')
  return body === '' ? [] : body.split('\n')
}

describe('grep：命中与格式', () => {
  it('正则命中多文件多行，输出 `绝对路径:行号: 行内容`', async () => {
    const tool = await createGrepTool(bed.ctx)
    mkdirSync(join(bed.root, 'src'))
    writeFileSync(join(bed.root, 'src', 'a.ts'), 'const x = 1\n// TODO: 稍后\n')
    writeFileSync(join(bed.root, 'src', 'b.ts'), 'foo\nfoobar\n')

    const hits = hitLines(await callTool(tool, { pattern: 'TODO' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toBe(`${join(bed.root, 'src', 'a.ts')}:2: // TODO: 稍后`)

    const regexHits = hitLines(await callTool(tool, { pattern: 'f(o+)bar' }))
    expect(regexHits.map((line) => line.split(': ')[1])).toEqual(['foobar'])
  })

  it('CJK 模式命中 CJK 内容', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'note.md'), '# 咖啡因\n美式咖啡\n拿铁\n')

    const hits = hitLines(await callTool(tool, { pattern: '咖啡' }))
    expect(hits.map((line) => line.split(': ')[1])).toEqual(['# 咖啡因', '美式咖啡'])
  })

  it('ignoreCase 可选：默认区分大小写', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'TODO\ntodo\n')

    expect(hitLines(await callTool(tool, { pattern: 'todo' }))).toHaveLength(1)
    expect(hitLines(await callTool(tool, { pattern: 'todo', ignoreCase: true }))).toHaveLength(2)
  })

  it('glob 过滤：只搜匹配的文件（无斜杠的按文件名匹配任意深度）', async () => {
    const tool = await createGrepTool(bed.ctx)
    mkdirSync(join(bed.root, 'src'))
    writeFileSync(join(bed.root, 'src', 'a.ts'), 'needle\n')
    writeFileSync(join(bed.root, 'top.txt'), 'needle\n')

    const hits = hitLines(await callTool(tool, { pattern: 'needle', glob: '*.ts' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('a.ts')
  })

  it('被搜内容里的 CRLF 不影响输出（行尾的 \\r 不带出来）', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'crlf.txt'), 'one\r\ntwo\r\n')

    const hits = hitLines(await callTool(tool, { pattern: 'two' }))
    expect(hits).toEqual([`${join(bed.root, 'crlf.txt')}:2: two`])
  })
})

describe('grep：跳过与截断契约', () => {
  it('二进制（含 NUL）文件跳过', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'bin.dat'), Buffer.from('needle\u0000binary', 'utf8'))
    writeFileSync(join(bed.root, 'text.txt'), 'needle text\n')

    const hits = hitLines(await callTool(tool, { pattern: 'needle' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('text.txt')
  })

  it('.git 目录跳过', async () => {
    const tool = await createGrepTool(bed.ctx)
    mkdirSync(join(bed.root, '.git'))
    writeFileSync(join(bed.root, '.git', 'config'), 'needle\n')
    writeFileSync(join(bed.root, 'a.txt'), 'needle\n')

    const hits = hitLines(await callTool(tool, { pattern: 'needle' }))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('a.txt')
  })

  it(`命中达到 ${GREP_MAX_HITS} 条上限：截断并提示`, async () => {
    const tool = await createGrepTool(bed.ctx)
    const lines = Array.from({ length: GREP_MAX_HITS + 20 }, (_, index) => `needle ${index}`)
    writeFileSync(join(bed.root, 'many.txt'), `${lines.join('\n')}\n`)

    const out = String(await callTool(tool, { pattern: 'needle' }))
    expect(hitLines(out)).toHaveLength(GREP_MAX_HITS)
    expect(out).toContain('可能还有更多')
  })

  it(`单行过长：截到 ${GREP_MAX_LINE_CHARS} 字符并加省略号`, async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'long.txt'), `needle ${'x'.repeat(GREP_MAX_LINE_CHARS * 2)}\n`)

    const out = String(await callTool(tool, { pattern: 'needle' }))
    const [hit] = hitLines(out)
    const content = hit.slice(hit.indexOf(': ') + 2)
    expect(content).toHaveLength(GREP_MAX_LINE_CHARS + 1)
    expect(content.endsWith('…')).toBe(true)
  })

  it('单行截断按码点切：400 处正好落在代理对中间时不切开 emoji（T11⑥）', async () => {
    const tool = await createGrepTool(bed.ctx)
    // 头 7 个码元是 'needle '，再补 392 个 'x'：第 400 个码元恰是 😀（代理对）的前半——
    // 旧的 slice(0, 400)（按 UTF-16 码元）会把它切成半个字符，渲染端拿到孤立代理项
    const emoji = '😀'
    const line = `needle ${'x'.repeat(GREP_MAX_LINE_CHARS - 'needle '.length - 1)}${emoji}尾巴`
    writeFileSync(join(bed.root, 'pair.txt'), `${line}\n`)

    const out = String(await callTool(tool, { pattern: 'needle' }))
    const [hit] = hitLines(out)
    const content = hit.slice(hit.indexOf(': ') + 2)

    // 没有孤立代理项（半截 emoji）
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)
    ).toBe(false)
    // 截断点落在整只 emoji 之后：末位是它 + 省略号；仍是 400 个码点 + 省略号
    expect(content.endsWith(`${emoji}…`)).toBe(true)
    expect(Array.from(content)).toHaveLength(GREP_MAX_LINE_CHARS + 1)
  })

  it.skipIf(process.platform !== 'win32')(
    'junction（目录链接）不进搜索范围：链接指到工作区外，外面的内容搜不到（T11③）',
    async () => {
      const tool = await createGrepTool(bed.ctx)
      writeFileSync(join(bed.outside, 'secret.txt'), 'needle\n')
      symlinkSync(bed.outside, join(bed.root, 'link'), 'junction')
      writeFileSync(join(bed.root, 'inside.txt'), 'needle\n')

      const hits = hitLines(await callTool(tool, { pattern: 'needle' }))
      expect(hits).toHaveLength(1)
      expect(hits[0]).toContain('inside.txt')
      expect(hits[0]).not.toContain('secret.txt')
    }
  )

  it('没有命中：一句人话（不是空响应）', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.root, 'a.txt'), 'hello\n')
    expect(String(await callTool(tool, { pattern: 'nope' }))).toContain('没有匹配')
  })
})

describe('grep：边界与失败', () => {
  it('非法正则：明确报错', async () => {
    const tool = await createGrepTool(bed.ctx)
    await expect(callTool(tool, { pattern: '([' })).rejects.toThrow(/正则/)
  })

  it('path 在工作区外：拒绝', async () => {
    const tool = await createGrepTool(bed.ctx)
    writeFileSync(join(bed.outside, 'x.txt'), 'needle\n')
    await expect(callTool(tool, { pattern: 'needle', path: bed.outside })).rejects.toThrow(
      /授权工作区/
    )
  })

  it('多个工作区又没给 path：要求显式指定', async () => {
    const tool = await createGrepTool(bed.ctx)
    const second = createBed()
    bed.roots.push(second.roots[0])
    try {
      await expect(callTool(tool, { pattern: 'x' })).rejects.toThrow(/多个授权工作区/)
    } finally {
      second.dispose()
    }
  })

  it('子目录里的结果路径是绝对路径（可直接喂给 read/edit）', async () => {
    const tool = await createGrepTool(bed.ctx)
    mkdirSync(join(bed.root, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(bed.root, 'nested', 'deep', 'f.txt'), 'needle\n')

    const [hit] = hitLines(await callTool(tool, { pattern: 'needle' }))
    const path = hit.slice(0, hit.lastIndexOf(':1:'))
    expect(under(bed.root, path)).toBe('nested/deep/f.txt')
  })
})
