// @vitest-environment node
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProjectRules, saveProjectRules } from '../project-rules'
import type { Project } from '../../shared/projects'
import { RULES_SCOPE_MAX_BYTES } from '../../shared/rules'

const project = (path: string): Project => ({
  id: 'p1',
  name: '项目',
  path,
  createdAt: new Date().toISOString()
})
const roots: string[] = []
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kyclaw-rules-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rejected(path: string): Promise<void> {
  expect(await readProjectRules(project(path))).toMatchObject({
    text: '',
    diagnostics: [{ code: 'unsafe-path' }]
  })
  expect(await saveProjectRules(project(path), '越界')).toMatchObject({
    ok: false,
    diagnostics: [{ code: 'unsafe-path' }]
  })
}

describe('项目记忆指令安全文件读写', () => {
  it.runIf(process.platform === 'win32')(
    '真实 Windows 8.3 短路径与长路径读写同一规则且仍拒绝 junction',
    async () => {
      const root = await temporary()
      const { stdout } = await promisify(execFile)(
        'cmd.exe',
        ['/d', '/s', '/c', `for %I in ("${root}") do @echo %~sI`],
        { windowsVerbatimArguments: true }
      )
      const short = stdout.trim()
      const long = await realpath(root)
      expect(short.toLowerCase()).not.toBe(long.toLowerCase())
      expect(await saveProjectRules(project(short), '短路径保存')).toEqual({ ok: true })
      expect(await readProjectRules(project(long))).toEqual({ text: '短路径保存', diagnostics: [] })
      expect(await saveProjectRules(project(long), '长路径替换')).toEqual({ ok: true })
      expect((await readProjectRules(project(short))).text).toBe('长路径替换')
      const target = await temporary()
      await rm(join(short, '.kyclaw'), { recursive: true })
      await symlink(target, join(short, '.kyclaw'), 'junction')
      await rejected(short)
    }
  )
  it('读取缺失文件不建目录，不读取父目录规则', async () => {
    const parent = await temporary()
    await saveProjectRules(project(parent), '父项目')
    const root = join(parent, 'child')
    await mkdir(root)
    expect(await readProjectRules(project(root))).toEqual({ text: '', diagnostics: [] })
    await expect(lstat(join(root, '.kyclaw'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('显式保存创建目录并替换内容，空文件合法，不留临时文件', async () => {
    const root = await temporary()
    const item = project(root)
    for (const text of ['第一版😀', '第二版', '']) {
      expect(await saveProjectRules(item, text)).toEqual({ ok: true })
      expect(await readProjectRules(item)).toEqual({ text, diagnostics: [] })
      expect(await readFile(join(root, '.kyclaw', 'rules.md'), 'utf8')).toBe(text)
    }
    expect(await readdir(join(root, '.kyclaw'))).toEqual(['rules.md'])
  })

  it('保存非法或超限内容拒绝且不改原文件，也不创建目录', async () => {
    const root = await temporary()
    const item = project(root)
    expect(await saveProjectRules(item, 'x'.repeat(RULES_SCOPE_MAX_BYTES + 1))).toMatchObject({
      ok: false
    })
    await expect(lstat(join(root, '.kyclaw'))).rejects.toMatchObject({ code: 'ENOENT' })
    await saveProjectRules(item, '原版')
    for (const text of ['x'.repeat(RULES_SCOPE_MAX_BYTES + 1), '\0', '\uD800']) {
      expect(await saveProjectRules(item, text)).toMatchObject({ ok: false })
      expect((await readProjectRules(item)).text).toBe('原版')
    }
  })

  it('提交前项目被删除或改路径时拒绝替换，保留原文并清理临时文件', async () => {
    const root = await temporary()
    const item = project(root)
    await saveProjectRules(item, '原版')
    expect(await saveProjectRules(item, '新版', { canCommit: () => false })).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'project-unavailable' }]
    })
    expect((await readProjectRules(item)).text).toBe('原版')
    expect(await readdir(join(root, '.kyclaw'))).toEqual(['rules.md'])
  })

  it('外部文件超限、非法 UTF-8、NUL 均整份拒绝，保留 BOM 字节语义', async () => {
    const root = await temporary()
    await saveProjectRules(project(root), '')
    const file = join(root, '.kyclaw', 'rules.md')
    for (const [bytes, code] of [
      [Buffer.alloc(RULES_SCOPE_MAX_BYTES + 1, 97), 'too-large'],
      [Buffer.from([0xc3, 0x28]), 'invalid-text'],
      [Buffer.from('a\0b'), 'invalid-text']
    ] as const) {
      await writeFile(file, bytes)
      expect(await readProjectRules(project(root))).toMatchObject({
        text: '',
        diagnostics: [{ code }]
      })
    }
    await writeFile(file, '\uFEFF规则')
    expect((await readProjectRules(project(root))).text).toBe('\uFEFF规则')
  })

  it('缺失项目根返回读取诊断；规则节点类型不对拒绝读写', async () => {
    const root = await temporary()
    expect(await readProjectRules(project(join(root, 'missing')))).toMatchObject({
      text: '',
      diagnostics: [{ code: 'read-failed' }]
    })
    await writeFile(join(root, '.kyclaw'), '不是目录')
    await rejected(root)
    await rm(join(root, '.kyclaw'))
    await mkdir(join(root, '.kyclaw', 'rules.md'), { recursive: true })
    await rejected(root)
  })

  /**
   * 用户口径：这几句 message 是设置页「记忆指令」栏 / 会话里真会显示给用户的话，
   * 措辞统一说「记忆指令」（更早的旧说法「约束」「我的规矩」只剩历史）。文案分散在多个模块，
   * 「一处都不许再出现旧说法」那条整体守卫在 shared/__tests__/rules.spec.ts。
   */
  it('面向用户的诊断说「记忆指令」：超限 / 非 UTF-8 / 读不出来 / 路径不安全', async () => {
    const root = await temporary()
    await saveProjectRules(project(root), '')
    const file = join(root, '.kyclaw', 'rules.md')

    for (const [bytes, expected] of [
      [Buffer.alloc(RULES_SCOPE_MAX_BYTES + 1, 97), '项目记忆指令超过 16 KiB，整份未加载。'],
      [Buffer.from([0xc3, 0x28]), '项目记忆指令不是合法 UTF-8 文本，整份未加载。']
    ] as const) {
      await writeFile(file, bytes)
      const result = await readProjectRules(project(root))
      expect(result.diagnostics.map((item) => item.message)).toEqual([expected])
    }

    expect(
      (await readProjectRules(project(join(root, 'missing')))).diagnostics.map(
        (item) => item.message
      )
    ).toEqual(['无法读取项目记忆指令，本轮未加载。'])

    const unsafe = await temporary()
    await writeFile(join(unsafe, '.kyclaw'), '不是目录')
    expect(
      (await readProjectRules(project(unsafe))).diagnostics.map((item) => item.message)
    ).toEqual(['项目记忆指令路径不安全：不允许符号链接、junction 或非预期文件类型。'])
  })

  it('项目根、其父节点及 .kyclaw 的 symlink/junction 均拒绝读写', async () => {
    const root = await temporary()
    const target = await temporary()
    await saveProjectRules(project(target), '外部原文')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    const alias = join(root, 'alias')
    await symlink(target, alias, type)
    await rejected(alias)
    await mkdir(join(target, 'nested'))
    await rejected(join(alias, 'nested'))
    await symlink(target, join(root, '.kyclaw'), type)
    await rejected(root)
    expect((await readProjectRules(project(target))).text).toBe('外部原文')
  })

  it.skipIf(process.platform === 'win32')('rules.md 文件 symlink 拒绝读写', async () => {
    const root = await temporary()
    const target = await temporary()
    const external = join(target, 'external.md')
    await writeFile(external, '外部原文')
    await mkdir(join(root, '.kyclaw'))
    await symlink(external, join(root, '.kyclaw', 'rules.md'))
    await rejected(root)
    expect(await readFile(external, 'utf8')).toBe('外部原文')
  })
})
