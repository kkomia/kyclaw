// @vitest-environment node
/**
 * 技能导入（round 94）：URL 直链 md / 单技能 zip、本地 md / zip / 根含 SKILL.md 的目录，
 * 原子发布到 `<userData>/skills/<名字>/`。
 *
 * 这里跑的是**真后端**：URL 用例起一个本机 HTTP 服务（真 undici fetch + 真逐跳出站校验），
 * 落盘用例读的是真文件系统。钉住的四件事：
 *   ① 合法导入（md / zip / 目录）与资源保留（脚本只存字节、绝不执行）；
 *   ② 出站边界：默认拒环回/私网（人话 + 配置提示）、**每一跳都校验**（重定向到未放行的端口就停）；
 *   ③ 拒绝面：没有 frontmatter、重名（用户 / 内置 / 插件目录，大小写不敏感）、Windows 设备名、超限；
 *   ④ 原子性：任何失败都不留半截技能、不留暂存目录，已有技能一字不动。
 */
import { createServer, type Server } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstalledPlugin } from '../../../shared/settings'
import {
  importSkillFromLocal,
  importSkillFromUrl,
  allowEntryFor,
  SKILL_MD_MAX_BYTES,
  skillStagingRoot,
  SkillEgressBlockedError,
  type SkillImportDeps
} from '../skill-add'
import { hostAllowed } from '../../tools/fetch-policy'
import { installedSkillViews, skillSourcesFor } from '../skills'
import { readSkillHeader } from '../../../shared/skills'
import { makeZip } from './zip-fixture'

const SKILL = '---\nname: demo\ndescription: 演示技能\n---\n# 做法\n'
const SKILL_WITH_FILES = '---\nname: with-files\ndescription: 带资源的技能\n---\n正文\n'

let tmp: string
let skillsDir: string
let builtinDir: string
let deps: SkillImportDeps
let server: Server | null = null

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-skill-add-'))
  skillsDir = join(tmp, 'skills')
  builtinDir = join(tmp, 'builtin-skills')
  mkdirSync(skillsDir, { recursive: true })
  deps = { skillsDir, builtinDir, allowHosts: () => [] }
})

afterEach(() => {
  server?.close()
  server = null
  rmSync(tmp, { recursive: true, force: true })
})

/** 起一个本机 HTTP 服务（127.0.0.1 + 随机端口），回它的 allowHosts 条目 */
async function serve(
  handler: (
    path: string,
    respond: (status: number, body: Buffer | string, headers?: Record<string, string>) => void
  ) => void
): Promise<{ host: string; allow: string[] }> {
  const started = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    handler(url.pathname, (status, body, headers = {}) => {
      response.writeHead(status, headers)
      response.end(body)
    })
  })
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
  server = started
  const address = started.address()
  if (address === null || typeof address === 'string') throw new Error('服务没起来')
  return { host: `127.0.0.1:${address.port}`, allow: [`127.0.0.1:${address.port}`] }
}

/** 起一个 IPv6 环回（::1）上的 HTTP 服务；本机不支持就回 null（用例明确 skip） */
async function serveIPv6(
  handler: (
    path: string,
    respond: (status: number, body: Buffer | string, headers?: Record<string, string>) => void
  ) => void
): Promise<Server | null> {
  const started = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://[::1]')
    handler(url.pathname, (status, body, headers = {}) => {
      response.writeHead(status, headers)
      response.end(body)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      started.once('error', reject)
      started.listen(0, '::1', resolve)
    })
  } catch {
    return null
  }
  server = started
  return started
}

function writeSkill(root: string, dir: string, content = SKILL): string {
  const path = join(root, dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'SKILL.md'), content, 'utf8')
  return path
}

/** 落盘结果的断言助手：读回技能目录里的文件（相对路径 → 文本） */
function readSkillDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (root: string, prefix: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path, relative)
      else files[relative] = readFileSync(path, 'utf8')
    }
  }
  walk(join(skillsDir, dir), '')
  return files
}

/** 拒绝面都要满足"没有半截技能、没有暂存残留" */
function expectCleanSkillsDir(): void {
  expect(readdirSync(skillsDir)).toEqual([])
}

const PLUGIN: InstalledPlugin = {
  id: 'market-p1',
  marketplaceId: 'market',
  name: '演示插件',
  installedAt: '2026-10-16T00:00:00.000Z',
  mcpServerIds: [],
  skillDirs: ['market-p1-plugin-skill'],
  installDir: null
}

describe('importSkillFromUrl：直链与逐跳校验', () => {
  it('直链 SKILL.md：名字走 frontmatter，正文原样落盘', async () => {
    const { host, allow } = await serve((path, respond) => {
      expect(path).toBe('/demo/SKILL.md')
      respond(200, SKILL, { 'content-type': 'text/markdown' })
    })
    const added = await importSkillFromUrl(
      { ...deps, allowHosts: () => allow },
      `http://${host}/demo/SKILL.md`
    )
    expect(added).toEqual({ name: 'demo', dir: 'demo' })
    expect(readFileSync(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('直链单技能 zip：解包落盘，资源文件原样保留（脚本只存字节，不执行）', async () => {
    const zip = makeZip([
      { name: 'SKILL.md', data: SKILL_WITH_FILES, method: 8 },
      { name: 'reference/checklist.md', data: '# 清单\n' },
      { name: 'scripts/run.sh', data: 'echo pwned > /tmp/pwned\n' }
    ])
    const { host, allow } = await serve((_path, respond) =>
      respond(200, zip, { 'content-type': 'application/zip' })
    )
    const added = await importSkillFromUrl(
      { ...deps, allowHosts: () => allow },
      `http://${host}/with-files.zip`
    )
    expect(added).toEqual({ name: 'with-files', dir: 'with-files' })
    expect(readSkillDir('with-files')).toEqual({
      'SKILL.md': SKILL_WITH_FILES,
      'reference/checklist.md': '# 清单\n',
      'scripts/run.sh': 'echo pwned > /tmp/pwned\n'
    })
    // 只存字节：那份 .sh 没有被执行（它的产物不该出现）
    expect(existsSync(join(skillsDir, 'with-files', 'scripts', 'run.sh'))).toBe(true)
  })

  it('重定向逐跳校验：第二跳落到没放行的端口 → 拒绝且不落盘', async () => {
    const target = await serve((_path, respond) => respond(200, SKILL))
    const { host, allow } = await serve((_path, respond) =>
      respond(302, '', { location: `http://${target.host}/demo/SKILL.md` })
    )
    await expect(
      importSkillFromUrl({ ...deps, allowHosts: () => allow }, `http://${host}/start`)
    ).rejects.toThrow(/重定向/)
    expectCleanSkillsDir()
  })

  it('重定向到放行过的地址就正常跟（第一跳与第二跳都过闸）', async () => {
    const target = await serve((_path, respond) => respond(200, SKILL))
    const { host, allow } = await serve((_path, respond) =>
      respond(301, '', { location: `http://${target.host}/demo/SKILL.md` })
    )
    const added = await importSkillFromUrl(
      { ...deps, allowHosts: () => [...allow, ...target.allow] },
      `http://${host}/start`
    )
    expect(added.name).toBe('demo')
  })

  it('环回地址默认拒：人话 + 框内允许 / 环境变量两条出口都写上', async () => {
    const { host } = await serve((_path, respond) => respond(200, SKILL))
    await expect(importSkillFromUrl(deps, `http://${host}/SKILL.md`)).rejects.toThrow(
      /本机（环回）地址[\s\S]*允许这台主机[\s\S]*KYCLAW_FETCH_ALLOW_HOSTS/
    )
    expectCleanSkillsDir()
  })

  it('非 2xx / 超 8MiB / 超时 / 非 http(s)：拒且不落盘', async () => {
    const { host, allow } = await serve((path, respond) => {
      if (path === '/404') respond(404, 'nope')
      else if (path === '/big') respond(200, Buffer.alloc(9 * 1024 * 1024, 1))
      else respond(200, SKILL)
    })
    const allowed = { ...deps, allowHosts: () => allow }
    await expect(importSkillFromUrl(allowed, `http://${host}/404`)).rejects.toThrow(/HTTP 404/)
    await expect(importSkillFromUrl(allowed, `http://${host}/big`)).rejects.toThrow(/上限/)
    await expect(importSkillFromUrl(deps, 'ftp://example.com/SKILL.md')).rejects.toThrow(/http/)
    await expect(importSkillFromUrl(deps, '不是网址')).rejects.toThrow(/网址/)
    expectCleanSkillsDir()
  })

  it('超时：半天不回的地址按"超时"拒绝（测试把上限压到 300ms）', async () => {
    const { host, allow } = await serve(() => {
      /* 不回应：让请求挂着 */
    })
    await expect(
      importSkillFromUrl(
        { ...deps, allowHosts: () => allow, timeoutMs: 300 },
        `http://${host}/slow`
      )
    ).rejects.toThrow(/超时/)
    expectCleanSkillsDir()
  })

  it('没有 frontmatter 的 md / 名字不合规：拒，后者给出 slug 建议', async () => {
    const { host, allow } = await serve((path, respond) => {
      respond(
        200,
        path === '/plain' ? '# 就是一段文本\n' : '---\nname: Invoice Helper\ndescription: x\n---\n'
      )
    })
    const allowed = { ...deps, allowHosts: () => allow }
    await expect(importSkillFromUrl(allowed, `http://${host}/plain`)).rejects.toThrow(/frontmatter/)
    await expect(importSkillFromUrl(allowed, `http://${host}/bad-name`)).rejects.toThrow(
      /invoice-helper/
    )
    expectCleanSkillsDir()
  })
})

describe('importSkillFromLocal：md / zip / 目录', () => {
  it('本地 .md 文件：名字走 frontmatter', async () => {
    const file = join(tmp, 'note.md')
    writeFileSync(file, SKILL, 'utf8')
    expect(await importSkillFromLocal(deps, file)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readFileSync(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('本地 zip：单一顶层包装可剥离，包装外的条目不要', async () => {
    const file = join(tmp, 'package.zip')
    writeFileSync(
      file,
      makeZip([
        { name: 'demo/SKILL.md', data: SKILL },
        { name: 'demo/reference/a.md', data: '# a\n' }
      ])
    )
    expect(await importSkillFromLocal(deps, file)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readSkillDir('demo')).toEqual({ 'SKILL.md': SKILL, 'reference/a.md': '# a\n' })
  })

  it('本地 zip：两个顶层目录（不止一份技能）→ 拒', async () => {
    const file = join(tmp, 'two.zip')
    writeFileSync(
      file,
      makeZip([
        { name: 'a/SKILL.md', data: SKILL },
        { name: 'b/SKILL.md', data: '---\nname: other\n---\n' }
      ])
    )
    await expect(importSkillFromLocal(deps, file)).rejects.toThrow(/一个技能|SKILL\.md/)
    expectCleanSkillsDir()
  })

  it('本地目录（根有 SKILL.md）：整份保留，含隐藏目录与脚本', async () => {
    const dir = writeSkill(tmp, 'demo')
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(join(dir, 'reference', 'a.md'), '# a\n', 'utf8')
    mkdirSync(join(dir, '.vscode'), { recursive: true })
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{}\n', 'utf8')
    writeFileSync(join(dir, 'run.py'), 'print(1)\n', 'utf8')

    expect(await importSkillFromLocal(deps, dir)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readSkillDir('demo')).toEqual({
      'SKILL.md': SKILL,
      'reference/a.md': '# a\n',
      '.vscode/settings.json': '{}\n',
      'run.py': 'print(1)\n'
    })
  })

  it('目录根没有 SKILL.md（只有子目录里有）→ 拒，并说清要选哪一层', async () => {
    const parent = join(tmp, 'parent')
    writeSkill(parent, 'demo')
    await expect(importSkillFromLocal(deps, parent)).rejects.toThrow(
      /根目录[\s\S]*SKILL\.md|SKILL\.md[\s\S]*根/
    )
    expectCleanSkillsDir()
  })

  it('目录里的文件符号链接 → 拒（本机建不出链接就明确 skip，不当通过）', async (ctx) => {
    const dir = writeSkill(tmp, 'demo')
    const outside = join(tmp, 'outside.md')
    writeFileSync(outside, 'secret\n', 'utf8')
    try {
      symlinkSync(outside, join(dir, 'link.md'))
    } catch {
      ctx.skip('本机不允许建文件符号链接（Windows 非开发者模式）')
      return
    }
    await expect(importSkillFromLocal(deps, dir)).rejects.toThrow(/符号链接/)
    expectCleanSkillsDir()
  })

  it('目录里的目录 junction（免管理员可建）→ 拒', async (ctx) => {
    const dir = writeSkill(tmp, 'demo')
    const outside = join(tmp, 'outside-dir')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.md'), 'secret\n', 'utf8')
    try {
      symlinkSync(outside, join(dir, 'link-dir'), 'junction')
    } catch {
      ctx.skip('本机建不出目录 junction（需要开发者模式或管理员）')
      return
    }
    await expect(importSkillFromLocal(deps, dir)).rejects.toThrow(/符号链接/)
    expectCleanSkillsDir()
  })

  it('超限：文件数 / 单文件 / 合计 → 拒', async () => {
    const many = writeSkill(tmp, 'many')
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(many, `f${index}.md`), 'x', 'utf8')
    }
    await expect(importSkillFromLocal(deps, many)).rejects.toThrow(/文件数/)

    const big = writeSkill(tmp, 'big')
    writeFileSync(join(big, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
    await expect(importSkillFromLocal(deps, big)).rejects.toThrow(/单条上限|单文件/)

    const wide = writeSkill(tmp, 'wide')
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(wide, `chunk${index}.bin`), Buffer.alloc(2 * 1024 * 1024 - 1024, 1))
    }
    await expect(importSkillFromLocal(deps, wide)).rejects.toThrow(/合计|总量/)
    expectCleanSkillsDir()
  })

  it('不是技能的文件（二进制乱码）→ 拒', async () => {
    const file = join(tmp, 'junk.png')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]))
    await expect(importSkillFromLocal(deps, file)).rejects.toThrow(/frontmatter|不是一个 zip/)
    expectCleanSkillsDir()
  })
})

describe('同名冲突与原子发布', () => {
  it('同名用户技能（含大小写变体）→ 拒，既有技能一字不动', async () => {
    writeSkill(skillsDir, 'Demo', '---\nname: Demo\ndescription: 老的\n---\n老的正文\n')
    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    await expect(importSkillFromLocal(deps, file)).rejects.toThrow(/同名|已经有一个/)
    expect(readdirSync(skillsDir)).toEqual(['Demo'])
    expect(readFileSync(join(skillsDir, 'Demo', 'SKILL.md'), 'utf8')).toContain('老的正文')
  })

  it('内置技能同名 → 拒', async () => {
    writeSkill(builtinDir, 'demo', '---\nname: demo\ndescription: 内置的\n---\n')
    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    await expect(importSkillFromLocal(deps, file)).rejects.toThrow(/内置/)
    expectCleanSkillsDir()
  })

  it('插件复制的技能目录同名（目录名去掉插件前缀）→ 拒', async () => {
    writeSkill(skillsDir, 'market-p1-plugin-skill', '---\nname: plugin-skill\n---\n')
    const installed = [PLUGIN]
    const file = join(tmp, 'zip.zip')
    writeFileSync(
      file,
      makeZip([{ name: 'SKILL.md', data: '---\nname: plugin-skill\ndescription: x\n---\n' }])
    )
    await expect(importSkillFromLocal({ ...deps, installed }, file)).rejects.toThrow(/插件/)
    expect(readdirSync(skillsDir)).toEqual(['market-p1-plugin-skill'])
  })

  it('Windows 设备名 / 段尾点空格 → 拒', async () => {
    for (const name of ['con', 'nul', 'com1', 'lpt9']) {
      const file = join(tmp, `${name}.md`)
      writeFileSync(file, `---\nname: ${name}\ndescription: x\n---\n`, 'utf8')
      await expect(importSkillFromLocal(deps, file), name).rejects.toThrow(/Windows|名字不合法/)
    }
    expectCleanSkillsDir()
  })

  it('发布是原子的：成功之后没有 `.skill-import-` 暂存残留', async () => {
    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    await importSkillFromLocal(deps, file)
    expect(readdirSync(skillsDir)).toEqual(['demo'])
  })

  it('导入的技能**进宿主技能清单**（skillSourcesFor → installedSkillViews），描述仍在 SKILL.md 头部', async () => {
    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    await importSkillFromLocal(deps, file)

    const sources = skillSourcesFor({ skillsDir, installed: [], builtinDir: null })
    // view 契约（round 64 起 = `installedSkillViewSchema`，strictObject）只投影
    // dir/name/pluginId/pluginName/source —— **不含 description**。
    // 旧断言（旧内核 loaders 时代）是：
    //   expect(discoverSkills(...)).toEqual([['demo', '演示技能', 'demo']])
    // 它测的是随旧内核删除的 `mastra/skills/loader`；`discoverSkills` 宿主侧**无消费方**。
    // "技能描述字段在宿主视图里缺失"已单独立项 **PB-036**，由 Lead 决定修还是挂账；
    // 这里不再断言 view 没有的字段，但保留数据源覆盖（见下一条）。
    expect(installedSkillViews(sources).map((view) => [view.name, view.dir])).toEqual([
      ['demo', 'demo']
    ])
    // 描述这条**数据源**必须还在（读 SKILL.md 头部）——能力没丢，只是 view 契约不投影
    expect(readSkillHeader(sources[0]!)).toMatchObject({ name: 'demo', description: '演示技能' })
  })

  it('插件技能复制进来的目录不会被当成"我的技能"（认领归属仍在 installer 记录里）', async () => {
    writeSkill(skillsDir, 'market-p1-plugin-skill', '---\nname: plugin-skill\n---\n正文\n')
    const entries = installedSkillViews(
      skillSourcesFor({ skillsDir, installed: [PLUGIN], builtinDir: null })
    )
    expect(entries.map((entry) => entry.name)).toEqual(['plugin-skill'])
    expect(skillSourcesFor({ skillsDir, installed: [PLUGIN], builtinDir: null })[0]?.pluginId).toBe(
      'market-p1'
    )
  })

  it('SKILL.md 上限是读取侧的 256KiB（Step 2 后只剩宿主这一处定义）', () => {
    expect(SKILL_MD_MAX_BYTES).toBe(256 * 1024)
  })

  it('大于 64KiB 的中文手册（旧口径会误拒）照样导得进来', async () => {
    const body = '这一条是中文字符，按 UTF-8 一个字三个字节。'.repeat(2000)
    const text = `---\nname: big-manual\ndescription: 大手册\n---\n${body}\n`
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(64 * 1024)

    const file = join(tmp, 'big-manual.md')
    writeFileSync(file, text, 'utf8')
    expect(await importSkillFromLocal(deps, file)).toEqual({
      name: 'big-manual',
      dir: 'big-manual'
    })
    expect(readFileSync(join(skillsDir, 'big-manual', 'SKILL.md'), 'utf8')).toBe(text)
  })

  it('超过 256KiB 的手册：拒（读取侧也读不全），且不落盘', async () => {
    const file = join(tmp, 'too-big.md')
    writeFileSync(
      file,
      `---\nname: too-big\ndescription: x\n---\n${'a'.repeat(300 * 1024)}\n`,
      'utf8'
    )
    await expect(importSkillFromLocal(deps, file)).rejects.toThrow(/超过上限/)
    expectCleanSkillsDir()
  })
})

/**
 * 暂存与崩溃残留（round 94 复核收口）：暂存根在**技能扫描根之外**（`<skillsDir>.staging`），
 * 所以"改名失败/清理失败留下的半截"结构上就不可发现、也不占正式技能名；清理失败不许盖掉原始错误。
 */
describe('暂存根与崩溃残留', () => {
  /** 暂存根里还剩什么（根被收干净 = 空表） */
  function stagingEntries(): string[] {
    const root = skillStagingRoot(skillsDir)
    return existsSync(root) ? readdirSync(root) : []
  }

  /** 造一个"上次崩溃留下的"暂存目录（严格格式命名，里面真有 SKILL.md） */
  function makeStagingLeftover(name = 'demo'): string {
    const dir = join(skillStagingRoot(skillsDir), 'skill-import-999-1000')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 残留\n---\n`, 'utf8')
    return dir
  }

  it('崩溃残留的暂存（带 SKILL.md）不可发现、不占名字：同名导入照常成功', async () => {
    makeStagingLeftover('demo')

    // 不在扫描根里：宿主技能清单看不到它（agent 侧清单随旧内核删除，Step 2）
    expect(
      installedSkillViews(skillSourcesFor({ skillsDir, installed: [], builtinDir: null }))
    ).toEqual([])

    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    expect(await importSkillFromLocal(deps, file)).toEqual({ name: 'demo', dir: 'demo' })
    // 顺带清掉了那条严格格式的残留（归属证明：自建根 + 严格命名），空的暂存根也收了
    expect(stagingEntries()).toEqual([])
    expect(readdirSync(skillsDir)).toEqual(['demo'])
  })

  it('清理失败不覆盖原始错误；残留既不占名也不可见，下一次重试能成', async () => {
    // 改名与删除都注入成失败：改名失败是"原始错误"，删除失败是"清理失败"
    const failing: SkillImportDeps = {
      ...deps,
      fs: {
        rename: () => {
          throw new Error('改名失败（测试注入）')
        },
        remove: () => {
          throw new Error('删不掉（测试注入）')
        }
      }
    }
    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')

    // 抛出来的是**原始**错误（改名失败），不是"删不掉"
    await expect(importSkillFromLocal(failing, file)).rejects.toThrow(/改名失败（测试注入）/)

    // 残留（带 SKILL.md）留在扫描根之外：不可发现、不占名
    expect(
      installedSkillViews(skillSourcesFor({ skillsDir, installed: [], builtinDir: null }))
    ).toEqual([])
    expect(stagingEntries().length).toBe(1)

    // 重试（这次不注入故障）：成功，并且把那半截收掉
    expect(await importSkillFromLocal(deps, file)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readdirSync(skillsDir)).toEqual(['demo'])
    expect(stagingEntries()).toEqual([])
  })

  it('老口径遗留（扫描根内的点目录残留）也不占名字：同名导入照常成功、清单里看不到它', async () => {
    // 上一版把暂存放进 skillsDir（点开头，名字里带技能名）；升级后可能还留在用户机器上。
    // 新口径**不删**这种来路不明的目录（不做按前缀乱删），靠"扫描排除点目录 + 不认它声明的名字"
    // 让它既不可发现、也不占正式名。
    const legacy = join(skillsDir, '.skill-import-demo-1-2')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'SKILL.md'), '---\nname: demo\ndescription: 老残留\n---\n', 'utf8')

    expect(
      installedSkillViews(skillSourcesFor({ skillsDir, installed: [], builtinDir: null }))
    ).toEqual([])

    const file = join(tmp, 'demo.md')
    writeFileSync(file, SKILL, 'utf8')
    expect(await importSkillFromLocal(deps, file)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readdirSync(skillsDir).sort()).toEqual(['.skill-import-demo-1-2', 'demo'])
  })
})

/** 出站拦截的两档：本机/内网（给"允许"按钮）vs 判不出（只给文字说明） */
describe('出站拦截的分类', () => {
  it('本机/内网：带精确 host:port 与 local 标记，消息里说明可以直接在框里允许', async () => {
    const { host } = await serve((_path, respond) => respond(200, SKILL))
    const error = await importSkillFromUrl(deps, `http://${host}/SKILL.md`).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SkillEgressBlockedError)
    const blocked = error as SkillEgressBlockedError
    expect(blocked.local).toBe(true)
    expect(blocked.host).toBe(host)
    expect(blocked.message).toContain('本机（环回）地址')
    expect(blocked.message).toContain('允许这台主机')
    expectCleanSkillsDir()
  })

  it('IPv6 目标：allowEntryFor 生成的是 fetch 认得的条目（`[::1]:port`），写完真能放行', async () => {
    const target = new URL('http://[::1]:8080/SKILL.md')
    const entry = allowEntryFor(target)
    expect(entry).toBe('[::1]:8080')
    // 用 fetch 的同一把尺验"这个条目真认"（裸 `::1:8080` 是认不出来的——那等于点了允许还拦）
    expect(hostAllowed(target, [entry])).toBe(true)
    expect(hostAllowed(target, ['::1:8080'])).toBe(false)

    const error = await importSkillFromUrl(deps, target.href).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SkillEgressBlockedError)
    expect((error as SkillEgressBlockedError).local).toBe(true)
    expect((error as SkillEgressBlockedError).host).toBe('[::1]:8080')
  })

  it('本机有 IPv6 环回时真下载一次（没有就明确 skip）', async (ctx) => {
    const started = await serveIPv6((_path, respond) => respond(200, SKILL))
    if (started === null) {
      ctx.skip('本机监听不了 IPv6 环回（::1）')
      return
    }
    const address = started.address()
    if (address === null || typeof address === 'string') {
      ctx.skip('拿不到 IPv6 端口')
      return
    }
    const href = `http://[::1]:${address.port}/SKILL.md`
    const target = new URL(href)

    // 没放行时被拦（且是"本机"这一档）
    const error = await importSkillFromUrl(deps, href).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SkillEgressBlockedError)
    expect((error as SkillEgressBlockedError).host).toBe(`[::1]:${address.port}`)

    // 用 allowEntryFor 写进白名单 → 真下载真落盘
    const allowed = { ...deps, allowHosts: () => [allowEntryFor(target)] }
    expect(await importSkillFromUrl(allowed, href)).toEqual({ name: 'demo', dir: 'demo' })
    expect(readFileSync(join(skillsDir, 'demo', 'SKILL.md'), 'utf8')).toBe(SKILL)
  })

  it('解析不出 IP：同样拦下，但**不给**"允许"出口（local=false）', async () => {
    const error = await importSkillFromUrl(
      { ...deps, lookup: async () => Promise.reject(new Error('ENOTFOUND')) },
      'http://skill-host.example/SKILL.md'
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SkillEgressBlockedError)
    const blocked = error as SkillEgressBlockedError
    expect(blocked.local).toBe(false)
    expect(blocked.message).toContain('解析不出 IP 地址')
    expect(blocked.message).not.toContain('允许这台主机')
    expect(blocked.message).toContain('KYCLAW_FETCH_ALLOW_HOSTS')
    expectCleanSkillsDir()
  })
})
