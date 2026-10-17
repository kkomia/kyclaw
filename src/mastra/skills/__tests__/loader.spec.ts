// @vitest-environment node
/**
 * 技能加载（round 64；容错与部署事实 round 68）：来源 → 清单（名字 + 描述）→ 指令文本；
 * 以及按需读全文（含末尾那段本部署事实）与文件清单。
 *
 * 钉住的几件事：
 *   ① 来源两类（内置 / 插件）都认，没有 SKILL.md 的目录静默跳过，重复来源去重；
 *   ② 名字口径与插件页一致（frontmatter name > 目录名去插件前缀），并保留"目录名"这个别名；
 *   ③ 渐进式披露：指令段只有名字 + 描述（**不含正文**），没有技能时是空串；
 *   ④ 全文读取：超过 256KB 截断、文件清单列出配套资料（最多 100 条，隐藏目录不进）；
 *   ⑤ round 68 容错：没有（闭合的）frontmatter 的文件**记警告后整份忽略**，别的技能照常可用。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readSkillHeader,
  readSkillSource,
  SKILL_FILE,
  type SkillSource
} from '../../../shared/skills'
import {
  discoverSkills,
  findSkill,
  listSkillFiles,
  missingSkillMessage,
  readSkill,
  skillLine,
  skillOrigin,
  skillsGuidance,
  SKILL_TEXT_MAX_BYTES,
  type SkillEntry
} from '../loader'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-skills-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 造一个技能目录（`content` 为 SKILL.md 内容；不给就不写这个文件） */
function makeSkill(root: string, dir: string, content?: string): string {
  const path = join(root, dir)
  mkdirSync(path, { recursive: true })
  if (content !== undefined) writeFileSync(join(path, SKILL_FILE), content, 'utf8')
  return path
}

function builtinSource(dir: string): SkillSource {
  return {
    kind: 'builtin',
    path: join(tmp, 'builtin', dir),
    dir,
    pluginId: null,
    pluginName: null,
    namePrefix: ''
  }
}

function pluginSource(dir: string, pluginId = 'market-p1', pluginName = 'p1'): SkillSource {
  return {
    kind: 'plugin',
    path: join(tmp, 'skills', dir),
    dir,
    pluginId,
    pluginName,
    namePrefix: `${pluginId}-`
  }
}

describe('discoverSkills：来源 → 清单', () => {
  it('内置 + 插件都认；名字走 frontmatter，描述取 description', () => {
    makeSkill(join(tmp, 'builtin'), 'pptx', '---\nname: pptx\ndescription: 做演示文稿\n---\n正文')
    makeSkill(
      join(tmp, 'skills'),
      'market-p1-demo',
      '---\nname: demo\ndescription: 示例技能\n---\n'
    )

    const entries = discoverSkills([builtinSource('pptx'), pluginSource('market-p1-demo')])

    expect(entries.map((entry) => [entry.name, entry.description, entry.kind])).toEqual([
      ['pptx', '做演示文稿', 'builtin'],
      ['demo', '示例技能', 'plugin']
    ])
    const [first, second] = entries
    expect(first?.file).toBe(join(tmp, 'builtin', 'pptx', SKILL_FILE))
    expect(first === undefined ? '' : skillOrigin(first)).toBe('内置技能')
    expect(second === undefined ? '' : skillOrigin(second)).toBe('插件「p1」')
  })

  it('没有 frontmatter：**整份忽略**并记一条警告（坏技能不带倒好的，也不抛）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // 三份坏技能：没有 frontmatter / frontmatter 没闭合 / 纯二进制垃圾；外加一份真是技能的
      makeSkill(join(tmp, 'skills'), 'market-p1-nofm', '正文没有 frontmatter')
      makeSkill(
        join(tmp, 'skills'),
        'market-p1-unclosed',
        '---\nname: unclosed\n\n# 没有收尾的 ---'
      )
      makeSkill(join(tmp, 'skills'), 'market-p1-junk', '\u0000\u0001乱码\u0002')
      makeSkill(
        join(tmp, 'skills'),
        'market-p1-good',
        '---\nname: good\ndescription: 好的\n---\n手册'
      )

      const entries = discoverSkills([
        pluginSource('market-p1-nofm'),
        pluginSource('market-p1-unclosed'),
        pluginSource('market-p1-junk'),
        // 目录里根本没有 SKILL.md：静默跳过（插件根目录下什么目录都有），不当"坏技能"记日志
        { ...pluginSource('market-p1-empty'), path: join(tmp, 'skills', 'market-p1-empty') },
        pluginSource('market-p1-good')
      ])

      expect(entries.map((entry) => entry.name)).toEqual(['good'])
      // 坏的那几份各留一条警告（能查到原因），没有 SKILL.md 的那份不记
      expect(warn).toHaveBeenCalledTimes(3)
      expect(String(warn.mock.calls[0]?.[0])).toContain('技能被忽略')
    } finally {
      warn.mockRestore()
    }
  })

  it('warn:false：坏技能仍被排除，但不打印警告（read 的信任根每次现算）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      makeSkill(join(tmp, 'skills'), 'market-p1-bad', '正文没有 frontmatter')
      expect(discoverSkills([pluginSource('market-p1-bad')], { warn: false })).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('frontmatter 在、description 缺：仍然算技能（名字退回目录名去前缀，描述是空串）', () => {
    makeSkill(join(tmp, 'skills'), 'market-p1-nodesc', '---\nname: nodesc\n---\n手册')
    makeSkill(join(tmp, 'skills'), 'market-p1-noname', '---\ndescription: 有描述没名字\n---\n手册')

    const entries = discoverSkills([
      pluginSource('market-p1-nodesc'),
      pluginSource('market-p1-noname')
    ])

    expect(entries.map((entry) => [entry.name, entry.description])).toEqual([
      ['nodesc', ''],
      ['noname', '有描述没名字']
    ])
    expect(skillLine(entries[0] as SkillEntry)).toBe('nodesc')
    // 名字退回"目录名去插件前缀"（与插件页显示口径一致）
    expect(skillLine(entries[1] as SkillEntry)).toBe('noname：有描述没名字')
  })

  it('同一份 SKILL.md 被两条来源指到：只留第一条（去重按路径）', () => {
    makeSkill(join(tmp, 'builtin'), 'pdf', '---\nname: pdf\ndescription: PDF\n---\n')
    const first = builtinSource('pdf')
    const second = pluginSource('pdf')
    second.path = first.path

    expect(discoverSkills([first, second]).map((entry) => entry.name)).toEqual(['pdf'])
  })
})

describe('findSkill：三种写法都命中', () => {
  const entries = (): SkillEntry[] => {
    makeSkill(join(tmp, 'builtin'), 'xlsx', '---\nname: xlsx\ndescription: 表格\n---\n')
    makeSkill(join(tmp, 'skills'), 'market-p1-demo', '---\nname: demo-skill\n---\n')
    return discoverSkills([builtinSource('xlsx'), pluginSource('market-p1-demo')])
  }

  it('技能名 / 目录名 / 去掉插件前缀的目录名；大小写不敏感', () => {
    const list = entries()
    expect(findSkill(list, 'xlsx')?.name).toBe('xlsx')
    expect(findSkill(list, 'XLSX')?.name).toBe('xlsx')
    expect(findSkill(list, 'demo-skill')?.name).toBe('demo-skill')
    expect(findSkill(list, 'market-p1-demo')?.name).toBe('demo-skill')
    expect(findSkill(list, 'demo')?.name).toBe('demo-skill')
  })

  it('引用标记 / 反引号包裹的名字照样命中；空串或未知名回 undefined', () => {
    const list = entries()
    expect(findSkill(list, '【引用】技能：xlsx')?.name).toBe('xlsx')
    expect(findSkill(list, '`xlsx`')?.name).toBe('xlsx')
    expect(findSkill(list, '   ')).toBeUndefined()
    expect(findSkill(list, '没有这个')).toBeUndefined()
  })
})

describe('skillsGuidance：渐进式披露第一层', () => {
  it('只给名字与描述（不含正文），拼成一段 `\\n- ` 追加行', () => {
    makeSkill(
      join(tmp, 'builtin'),
      'pptx',
      '---\nname: pptx\ndescription: 做演示文稿\n---\n秘密正文'
    )

    const text = skillsGuidance(discoverSkills([builtinSource('pptx')]))

    expect(text.startsWith('\n- Skills (work manuals)')).toBe(true)
    expect(text).toContain('· pptx：做演示文稿')
    expect(text).toContain('use_skill')
    // 011：技能资源明确走 read 的 skill 参数，不再把模型引向 bash
    expect(text).toContain('`skill`')
    expect(text).toContain('never use bash, glob or grep for skill files')
    expect(text).not.toContain('秘密正文')
  })

  it('没有技能：空串（指令里不留半句空话）', () => {
    expect(skillsGuidance([])).toBe('')
  })
})

describe('readSkill：全文 + 配套文件清单', () => {
  it('读全文并列出技能目录下的文件（递归、正斜杠、跳过隐藏目录）', () => {
    const path = makeSkill(
      join(tmp, 'builtin'),
      'docx',
      '---\nname: docx\ndescription: 写文档\n---\n手册正文'
    )
    mkdirSync(join(path, 'reference'), { recursive: true })
    writeFileSync(join(path, 'reference', 'styles.md'), '# 样式', 'utf8')
    mkdirSync(join(path, '.git'), { recursive: true })
    writeFileSync(join(path, '.git', 'config'), 'x', 'utf8')

    const [entry] = discoverSkills([builtinSource('docx')])
    expect(entry).toBeDefined()
    const reading = readSkill(entry as NonNullable<typeof entry>)

    expect(reading.name).toBe('docx')
    expect(reading.text).toContain('手册正文')
    expect(reading.truncated).toBe(false)
    expect(reading.files).toEqual(['SKILL.md', 'reference/styles.md'])
  })

  it('超过 256KB：截断并标记（不把巨文件整个读进来）', () => {
    const path = makeSkill(join(tmp, 'builtin'), 'big', '---\nname: big\ndescription: 大\n---\n')
    writeFileSync(
      join(path, SKILL_FILE),
      `---\nname: big\ndescription: 大\n---\n${'a'.repeat(SKILL_TEXT_MAX_BYTES)}`,
      'utf8'
    )

    const [entry] = discoverSkills([builtinSource('big')])
    expect(entry).toBeDefined()
    const reading = readSkill(entry as NonNullable<typeof entry>)

    expect(reading.truncated).toBe(true)
    expect(Buffer.byteLength(reading.text, 'utf8')).toBeLessThanOrEqual(SKILL_TEXT_MAX_BYTES)
  })

  it('listSkillFiles：条数上界（100）到了就标记 truncated', () => {
    const path = join(tmp, 'many')
    mkdirSync(path, { recursive: true })
    for (let index = 0; index < 130; index += 1) {
      writeFileSync(join(path, `f${String(index).padStart(3, '0')}.md`), 'x', 'utf8')
    }

    const listing = listSkillFiles(path)
    expect(listing.files).toHaveLength(100)
    expect(listing.truncated).toBe(true)
    // 目录不存在：空清单，不抛
    expect(listSkillFiles(join(tmp, 'nope'))).toEqual({ files: [], truncated: false })
  })

  it('011：SKILL.md 是链接指向目录外 → discover / header 不认，全文明确失败（不读外部正文）', (context) => {
    const path = makeSkill(join(tmp, 'skills'), 'market-p1-linked')
    const outside = join(tmp, 'outside.md')
    writeFileSync(outside, '---\nname: leak\ndescription: 外部\n---\nSECRET 正文', 'utf8')
    try {
      symlinkSync(outside, join(path, SKILL_FILE), 'file')
    } catch {
      context.skip()
      return
    }

    const source = pluginSource('market-p1-linked')
    expect(readSkillHeader(source)).toBeNull()
    expect(readSkillSource(source).ok).toBe(false)
    expect(discoverSkills([source])).toEqual([])

    // 手工构造的旧 entry 也不能把链接目标读成技能正文：明确报错，不是成功形状的空正文
    const entry: SkillEntry = {
      name: 'leak',
      description: '',
      dir: source.dir,
      kind: source.kind,
      file: join(path, SKILL_FILE),
      bytes: 100,
      license: '',
      source
    }
    expect(() => readSkill(entry)).toThrow(/不可读/)
  })

  it('011：SKILL.md 链接指向技能目录内部 → 允许（真实根内），但清单不跟随链接', (context) => {
    const path = makeSkill(join(tmp, 'skills'), 'market-p1-inner')
    writeFileSync(
      join(path, 'manual.md'),
      '---\nname: inner\ndescription: 内部链接\n---\n内部手册正文',
      'utf8'
    )
    try {
      symlinkSync(join(path, 'manual.md'), join(path, SKILL_FILE), 'file')
    } catch {
      context.skip()
      return
    }

    const source = pluginSource('market-p1-inner')
    expect(readSkillHeader(source)?.name).toBe('inner')
    const [entry] = discoverSkills([source])
    expect(entry).toBeDefined()
    const reading = readSkill(entry as NonNullable<typeof entry>)
    expect(reading.text).toContain('内部手册正文')
    // 清单只列真实文件：内部链接的 SKILL.md 不进清单，真实目标 manual.md 在
    expect(reading.files).toEqual(['manual.md'])
  })

  it('readSkill：入口被删 / 根被换成 junction → 明确失败，且不列外部文件名', (context) => {
    const path = makeSkill(join(tmp, 'skills'), 'market-p1-gone', '---\nname: gone\n---\n入口')
    const [entry] = discoverSkills([pluginSource('market-p1-gone')])
    expect(entry).toBeDefined()
    writeFileSync(join(path, SKILL_FILE), 'not frontmatter', 'utf8')
    expect(() => readSkill(entry as NonNullable<typeof entry>)).toThrow(/不可读/)
    rmSync(join(path, SKILL_FILE))
    expect(() => readSkill(entry as NonNullable<typeof entry>)).toThrow(/不可读/)

    // 根被换成指向外部目录的 junction：readSkill 不列外部文件名，listSkillFiles 根也不跟随
    const outsideDir = join(tmp, 'outside-root')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'SKILL.md'), '---\nname: leak\n---\n外部', 'utf8')
    writeFileSync(join(outsideDir, 'secret.md'), 'FAKE_MARKER_NOT_A_REAL_SECRET', 'utf8')
    const linked = join(tmp, 'skills', 'market-p1-replaced')
    try {
      symlinkSync(outsideDir, linked, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      context.skip()
      return
    }
    const replaced: SkillEntry = {
      name: 'replaced',
      description: '',
      dir: 'market-p1-replaced',
      kind: 'plugin',
      file: join(linked, SKILL_FILE),
      bytes: 100,
      license: '',
      source: pluginSource('market-p1-replaced')
    }
    expect(() => readSkill(replaced)).toThrow(/不可读/)
    expect(listSkillFiles(linked)).toEqual({ files: [], truncated: false })
  })

  it('011：SKILL.md 在 discovery 后变大 → 按当前长度有界截断（旧 bytes 快照不作数）', () => {
    const path = makeSkill(join(tmp, 'builtin'), 'grow', '---\nname: grow\n---\n小文件')
    const [entry] = discoverSkills([builtinSource('grow')])
    expect(entry).toBeDefined()
    writeFileSync(
      join(path, SKILL_FILE),
      `---\nname: grow\ndescription: 变大\n---\n${'a'.repeat(SKILL_TEXT_MAX_BYTES * 2)}`,
      'utf8'
    )

    const reading = readSkill(entry as NonNullable<typeof entry>)
    expect(reading.truncated).toBe(true)
    expect(Buffer.byteLength(reading.text, 'utf8')).toBeLessThanOrEqual(SKILL_TEXT_MAX_BYTES)
  })

  it('011：listSkillFiles 不跟随目录 junction（不把外部目录的文件名列给模型）', (context) => {
    const path = makeSkill(join(tmp, 'builtin'), 'docx', '---\nname: docx\n---\n')
    const outsideDir = join(tmp, 'outside-dir')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.md'), 'secret', 'utf8')
    writeFileSync(join(path, 'real.md'), 'x', 'utf8')
    try {
      symlinkSync(
        outsideDir,
        join(path, 'link-out'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } catch {
      context.skip()
      return
    }

    expect(listSkillFiles(path).files).toEqual(['SKILL.md', 'real.md'])
  })

  it('011：listSkillFiles 不跟随文件符号链接（无权限建文件链接则 skip）', (context) => {
    const path = makeSkill(join(tmp, 'builtin'), 'docx', '---\nname: docx\n---\n')
    const outsideDir = join(tmp, 'outside-dir')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.md'), 'secret', 'utf8')
    writeFileSync(join(path, 'real.md'), 'x', 'utf8')
    try {
      symlinkSync(join(outsideDir, 'secret.md'), join(path, 'linked.md'), 'file')
    } catch {
      context.skip()
      return
    }

    expect(listSkillFiles(path).files).toEqual(['SKILL.md', 'real.md'])
  })
})

describe('missingSkillMessage：可读的错误 + 可用清单', () => {
  it('列出可用技能名，并给"直接用工具"的兜底建议', () => {
    makeSkill(join(tmp, 'builtin'), 'pptx', '---\nname: pptx\ndescription: 演示\n---\n')
    const entries = discoverSkills([builtinSource('pptx')])

    const message = missingSkillMessage(entries, ' pptx2 ')
    expect(message).toContain('没找到技能「pptx2」')
    expect(message).toContain('pptx')
    expect(message).toContain('create_ppt')
  })

  it('一个技能都没有时也回人话', () => {
    expect(missingSkillMessage([], 'x')).toContain('当前没有可用技能')
  })
})

describe('内置技能（仓库 resources/skills）：文件本身得合格', () => {
  const root = resolve(__dirname, '../../../../resources/skills')
  const sources: SkillSource[] = ['pptx', 'docx', 'xlsx', 'pdf', 'skill-author'].map((dir) => ({
    kind: 'builtin' as const,
    path: join(root, dir),
    dir,
    pluginId: null,
    pluginName: null,
    namePrefix: ''
  }))

  it('内置技能都在，name 与目录名一致，description 足够模型判断"什么时候用我"', () => {
    const entries = discoverSkills(sources)
    expect(entries.map((entry) => entry.name)).toEqual([
      'pptx',
      'docx',
      'xlsx',
      'pdf',
      'skill-author'
    ])
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(40)
      expect(entry.license).not.toBe('')
    }
  })

  it('手册是真内容（不是空壳）：说了用哪个工具、给了上界与自检', () => {
    const entries = discoverSkills(sources)
    const expectations: Record<string, string[]> = {
      pptx: ['create_ppt', 'layout', '常见坑', '自检', '功能位', '设计原则'],
      docx: [
        'create_docx',
        'edit_docx',
        'heading',
        '常见坑',
        '自检',
        'GB/T 9704',
        '全角标点',
        '三线表'
      ],
      xlsx: ['create_excel', 'edit_excel', 'rows', '常见坑', '自检', '行类型', '假设与结果分开'],
      pdf: [
        'create_pdf',
        'create_report',
        'html',
        '常见坑',
        '自检',
        '强调色',
        '成品文档的排版口径'
      ],
      'skill-author': [
        'create_skill',
        'add_mcp_server',
        'frontmatter',
        '常见坑',
        '自检',
        'description 是唯一的触发开关',
        '渐进式披露'
      ]
    }
    for (const [name, needles] of Object.entries(expectations)) {
      const entry = entries.find((item) => item.name === name)
      expect(entry, `内置技能缺了 ${name}`).toBeDefined()
      const text = readSkill(entry as NonNullable<typeof entry>).text
      for (const needle of needles) {
        expect(text, `${name} 应包含 ${needle}`).toContain(needle)
      }
      expect(text.length).toBeGreaterThan(1500)
    }
  })

  /**
   * 采纳第三方文本的**合规面**（本轮为 office 四件套 + skill-author 引入的开源规范）：
   * 每个采纳过的技能都必须自带来源声明，且声明里点到具体仓库；许可全文随包分发。
   * 这几条不是"解释后端"，是再分发他人文本时的署名义务。
   */
  it('采纳过的技能自带来源声明，许可全文随包分发', () => {
    const entries = discoverSkills(sources)
    const adopters: Record<string, string> = {
      pptx: 'MiniMax-AI/skills',
      docx: 'MiniMax-AI/skills',
      xlsx: 'MiniMax-AI/skills',
      pdf: 'MiniMax-AI/skills',
      'skill-author': 'anthropics/skills'
    }
    for (const [name, upstream] of Object.entries(adopters)) {
      const entry = entries.find((item) => item.name === name)
      expect(entry, `内置技能缺了 ${name}`).toBeDefined()
      const text = readSkill(entry as NonNullable<typeof entry>).text
      // 来源 + 许可 + 我们改了什么，三样都要在技能文件里写清
      expect(text, `${name} 缺「来源与许可」一节`).toContain('## 来源与许可')
      expect(text, `${name} 没写明上游仓库`).toContain(upstream)
      expect(text, `${name} 没写明我们改了什么`).toContain('我们改了什么')
      expect(text, `${name} 没写明许可`).toMatch(/MIT License|Apache License 2\.0/)
    }

    const notices = join(root, 'THIRD_PARTY_NOTICES.md')
    expect(existsSync(notices), '许可全文没随包分发').toBe(true)
    const noticeText = readFileSync(notices, 'utf8')
    // MIT（MiniMax-AI/skills）：版权行 + 授权句
    expect(noticeText).toContain('MIT License')
    expect(noticeText).toContain('Copyright (c) 2026 MiniMax')
    expect(noticeText).toContain('60aaae52bb2af8162732751a4332f62a5fef518b')
    // Apache-2.0（anthropics/skills 的 skill-creator）：完整条款
    expect(noticeText).toContain('Apache License')
    expect(noticeText).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
    // 并且要点明 Anthropic 那四个 document-skills 不在采纳范围内
    expect(noticeText).toContain('skills/docx')
    expect(noticeText).toContain('All rights reserved')
  })

  /**
   * 设计判断层 = **可选口味（默认打法）**（用户拍板）：字号梯度、留白、配色纪律、排版惯例这类
   * "做成什么样"的判断只是默认打法，用户明确要求别的风格时以用户为准 —— 审美留给模型判断力与
   * 用户品味，技能不把它固化成硬口径。**内容不删**（有署名约束，见上一条），只是把口径降级。
   */
  it('设计判断层标成「可选口味（默认打法）」，并写明用户要求别的风格时以用户为准', () => {
    const entries = discoverSkills(sources)
    for (const name of ['pptx', 'docx', 'pdf', 'xlsx']) {
      const entry = entries.find((item) => item.name === name)
      expect(entry, `内置技能缺了 ${name}`).toBeDefined()
      const text = readSkill(entry as NonNullable<typeof entry>).text
      expect(text, `${name} 的设计判断层没标成可选口味`).toContain('可选口味（默认打法）')
      expect(text, `${name} 没写明"用户明确要求别的风格时以用户为准"`).toContain('以用户为准')
    }
  })
})
