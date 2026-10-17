// @vitest-environment node
/**
 * SKILL.md 的 frontmatter 解析（round 64）：技能清单与 use_skill 的名字/描述都从这一层来。
 *
 * 钉住的取舍：
 *   ① 官方只要求 name + description；引号、单行、块标量（`>`/`|`）三种常见写法都要认；
 *   ② 嵌套结构（缩进行）、注释行、认不出的行**跳过而不是报错**（插件市场里什么 SKILL.md 都有，
 *      一份写得怪的技能不该让整条技能链路倒下）；
 *   ③ 没有 frontmatter（或没有闭合 `---`）时整份当正文——宁可当手册，也不吃掉半份内容。
 */
import { describe, expect, it } from 'vitest'
import { isWindowsReservedName, parseSkillFrontmatter, skillNameOf } from '../../../shared/skills'

describe('parseSkillFrontmatter：基本形状', () => {
  it('name + description（引号包裹、值里有冒号）', () => {
    const text = [
      '---',
      'name: pptx',
      'description: "做演示文稿时用它：含冒号、含 `引号` 都不要紧"',
      '---',
      '',
      '# 正文标题',
      '内容一'
    ].join('\n')

    const parsed = parseSkillFrontmatter(text)
    expect(parsed.data.name).toBe('pptx')
    expect(parsed.data.description).toBe('做演示文稿时用它：含冒号、含 `引号` 都不要紧')
    expect(parsed.body).toBe('# 正文标题\n内容一')
  })

  it('单引号、裸值、键统一小写、`...` 也能闭合', () => {
    const parsed = parseSkillFrontmatter(
      ['---', 'NAME: 技能A', "License: 'Proprietary. 见 LICENSE.txt'", '...', 'B'].join('\n')
    )
    expect(parsed.data.name).toBe('技能A')
    expect(parsed.data.license).toBe('Proprietary. 见 LICENSE.txt')
    expect(parsed.body).toBe('B')
  })

  it('块标量：`>` 折成一行、`|` 保留换行，缩进被剥掉', () => {
    const folded = parseSkillFrontmatter(
      ['---', 'description: >', '  第一句', '  第二句', '', '  第三段', '---', 'x'].join('\n')
    )
    expect(folded.data.description).toBe('第一句 第二句\n第三段')

    const literal = parseSkillFrontmatter(
      ['---', 'description: |', '  第一行', '  第二行', '---', 'x'].join('\n')
    )
    expect(literal.data.description).toBe('第一行\n第二行')
  })

  it('注释行 / 缩进行 / 没有冒号的行：跳过，不影响其它键', () => {
    const parsed = parseSkillFrontmatter(
      [
        '---',
        '# 说明',
        'name: docx',
        'allowed-tools:',
        '  - read',
        '  - write',
        '没有冒号的一行',
        'description: 写文档',
        '---',
        'body'
      ].join('\n')
    )
    expect(parsed.data).toEqual({ name: 'docx', 'allowed-tools': '', description: '写文档' })
    expect(parsed.body).toBe('body')
  })

  it('CRLF 与 UTF-8 BOM：都能认', () => {
    const parsed = parseSkillFrontmatter(
      '\uFEFF---\r\nname: xlsx\r\ndescription: 表格\r\n---\r\n正文\r\n'
    )
    expect(parsed.data.name).toBe('xlsx')
    expect(parsed.data.description).toBe('表格')
    expect(parsed.body).toBe('正文\n')
  })
})

describe('parseSkillFrontmatter：保守取舍', () => {
  it('没有 frontmatter：整份都是正文', () => {
    const parsed = parseSkillFrontmatter('# 标题\n没有 frontmatter')
    expect(parsed.data).toEqual({})
    expect(parsed.body).toBe('# 标题\n没有 frontmatter')
  })

  it('没有闭合的 `---`：当没有 frontmatter（不吃掉半份手册）', () => {
    const text = '---\nname: a\n\n# 正文'
    const parsed = parseSkillFrontmatter(text)
    expect(parsed.data).toEqual({})
    expect(parsed.body).toBe(text)
  })

  it('空 frontmatter 块：正文从下一行开始，不留空行', () => {
    const parsed = parseSkillFrontmatter('---\n---\n\n# 一\n')
    expect(parsed.data).toEqual({})
    expect(parsed.body).toBe('# 一\n')
  })
})

describe('skillNameOf：名字派生', () => {
  it('frontmatter 的 name 优先', () => {
    expect(skillNameOf({ dir: 'market-p1-demo', namePrefix: 'market-p1-' }, 'demo-skill')).toBe(
      'demo-skill'
    )
  })

  it('没有 name：用目录名去掉插件前缀（与 round 10 的插件页显示口径一致）', () => {
    expect(skillNameOf({ dir: 'market-p1-demo', namePrefix: 'market-p1-' }, '')).toBe('demo')
    expect(skillNameOf({ dir: 'pptx', namePrefix: '' }, '')).toBe('pptx')
    // 前缀不是目录名前缀时原样用目录名（不硬切）
    expect(skillNameOf({ dir: 'demo', namePrefix: 'other-' }, '')).toBe('demo')
  })
})

/**
 * round 94：Windows 保留设备名（`con` / `nul` / `com1`…）——技能名与 zip 条目段共用的那一份口径。
 * 它挡的是"落盘的名字与校验过的名字分叉"：`nul.txt` 在 Windows 上写不进真文件（或被静默改写），
 * 于是导入声称成功、文件却不在（或换了个名字）。
 */
describe('isWindowsReservedName：保留设备名', () => {
  it('设备名本身与带扩展名的写法都算（大小写不敏感）', () => {
    for (const name of [
      'con',
      'CON',
      'nul',
      'nul.txt',
      'con.md',
      'com1',
      'COM9',
      'lpt1',
      'aux',
      'conin$',
      'CONOUT$',
      'clock$',
      'conin$.txt'
    ]) {
      expect(isWindowsReservedName(name), name).toBe(true)
    }
  })

  it('只在整段就是设备名时命中（`console` / `com10` / `mynul` 都不算）', () => {
    for (const name of ['console', 'com10', 'mynul', 'aux-skill', 'nul-', 'pptx']) {
      expect(isWindowsReservedName(name), name).toBe(false)
    }
  })
})
