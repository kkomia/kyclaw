// @vitest-environment node
/**
 * 本部署事实（round 68）：`use_skill` 加载技能时拼在全文末尾的那一段。
 *
 * 钉住的几件事（注入什么就拼出什么 —— 这一段是给模型看的操作口径，含糊就等于没写）：
 *   ① 三态两字段（渲染 可用/不可用/未知 × 读图 支持/不支持/未知）各自的话说清了"到底怎么办"：
 *      渲染不可用 → 退到逐页文字 + 写明"未做视觉检查" + 不许去找/装渲染器、不许换模型；
 *      读图不支持 → 不许为了"看一眼"反复渲染；
 *   ② **缺省安全**：整段拿不到（null）时不编造，写"未知"并给出保守的收尾；
 *   ③ 拼在**全文末尾**、与正文用 `---` 隔开；256KB 上界算的是返回的全部文本（手册可能被切，
 *      这一段永远看得见）；
 *   ④ 注册表现读、取值函数抛错只 warn 后当"没有结论"（拿不到部署事实不该让 use_skill 失败）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_FILE, type SkillSource } from '../../../shared/skills'
import { discoverSkills, readSkill, SKILL_TEXT_MAX_BYTES } from '../loader'
import {
  currentSkillRuntimeFacts,
  resetSkillRuntimeFactsSource,
  setSkillRuntimeFactsSource,
  SKILL_RUNTIME_FACTS_HEADING,
  skillRuntimeFactsText,
  type SkillRuntimeFacts
} from '../runtime'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-skill-facts-'))
  resetSkillRuntimeFactsSource()
})

afterEach(() => {
  resetSkillRuntimeFactsSource()
  rmSync(tmp, { recursive: true, force: true })
})

const HEADING = SKILL_RUNTIME_FACTS_HEADING

describe('skillRuntimeFactsText：四种组合各说清"自检怎么收尾"', () => {
  it('能渲染 + 能读图：让模型逐页看图，并要求不重复渲染没改过的源', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'powerpoint', vision: true })

    expect(text).toContain(HEADING)
    expect(text).toContain('页图渲染：可用')
    expect(text).toContain('当前模型读图：支持')
    expect(text).toContain('逐页看图核')
    expect(text).toContain('同一份没改动过的源不要重复渲染')
  })

  it('能渲染但看不到图：不要为一个看不到的东西反复渲染，也别换模型', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'powerpoint', vision: false })

    expect(text).toContain('当前模型读图：不支持')
    expect(text).toContain('别为了"看一眼"反复调用 `render_ppt`')
    expect(text).toContain('未做视觉检查')
    expect(text).not.toContain('你也能看图')
  })

  it('随包渲染器（libreoffice）：说得清"不需要你装 Office"，收尾口径与 PowerPoint 那条路一致', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'libreoffice', vision: true })

    expect(text).toContain('页图渲染：可用')
    expect(text).toContain('随包')
    expect(text).toContain('不需要你装 Office')
    expect(text).toContain('当前模型读图：支持')
    // 与 'powerpoint' 是同一套收尾指令（对模型来说差别只在页图从哪台引擎出来）
    expect(text).toContain('逐页看图核')
    expect(text).toContain('同一份没改动过的源不要重复渲染')
  })

  it('渲染不可用：退到逐页文字 + 写明没做视觉检查；不许找/装别的渲染器', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'none', vision: true })

    expect(text).toContain('页图渲染：不可用')
    expect(text).toContain('逐页文字结构')
    // round 77：不可用是"本机没有 PowerPoint / WPS **且** 随包那份也没装上"，两条路都说了
    expect(text).toContain('既没有 PowerPoint / WPS、也没有随包渲染器')
    expect(text).toContain('只做了结构与内容校验，未做视觉检查')
    expect(text).toContain('LibreOffice')
    expect(text).toContain('不要装渲染器')
    expect(text).toContain('不要为此换模型')
  })

  it('本机引擎（powerpoint）那条也说到 WPS：个人 PC 上装的多半是它', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'powerpoint', vision: true })

    expect(text).toContain('页图渲染：可用')
    expect(text).toContain('PowerPoint / WPS')
    expect(text).toContain('你自己打开这份 pptx 看到的一致')
  })

  it('读图能力没有结论：以实际收到的内容为准（图到了就看、没到就声明没看过）', () => {
    const text = skillRuntimeFactsText({ pptRenderer: 'powerpoint', vision: null })

    expect(text).toContain('当前模型读图：未知')
    expect(text).toContain('以你实际收到的内容为准')
  })

  it('渲染器没有结论：先按正文走，别自己去装或找渲染器', () => {
    const text = skillRuntimeFactsText({ pptRenderer: null, vision: true })

    expect(text).toContain('页图渲染：未知')
    expect(text).toContain('别自己去装或找渲染器')
  })

  it('整段拿不到（null）：不编造，写"未知" + 保守收尾', () => {
    const text = skillRuntimeFactsText(null)

    expect(text).toContain('页图渲染：未知')
    expect(text).toContain('当前模型读图：未知')
    expect(text).toContain('本机这次**没给出**部署结论')
    expect(text).toContain('未做视觉检查')
    // 不许出现任何"已经是可用/支持"的断言
    expect(text).not.toContain('：可用')
    expect(text).not.toContain('：支持')
  })
})

describe('readSkill：那一段拼在全文末尾', () => {
  function entryOf(content: string): ReturnType<typeof discoverSkills>[number] {
    const path = join(tmp, 'pptx')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, SKILL_FILE), content, 'utf8')
    const source: SkillSource = {
      kind: 'builtin',
      path,
      dir: 'pptx',
      pluginId: null,
      pluginName: null,
      namePrefix: ''
    }
    const entry = discoverSkills([source])[0]
    if (entry === undefined) throw new Error('样本技能没被扫到')
    return entry
  }

  it('手册在前、事实在后，用 --- 隔开；没给事实时也是"未知"那一版', () => {
    const entry = entryOf('---\nname: pptx\ndescription: 演示\n---\n手册正文。')
    const facts: SkillRuntimeFacts = { pptRenderer: 'none', vision: false }

    const withFacts = readSkill(entry, facts)
    const withoutFacts = readSkill(entry)

    expect(withFacts.text).toContain('手册正文。')
    expect(withFacts.text.indexOf('手册正文。')).toBeLessThan(withFacts.text.indexOf(HEADING))
    expect(withFacts.text).toContain('页图渲染：不可用')
    expect(withoutFacts.text).toContain('页图渲染：未知')
  })

  it('256KB 上界算的是返回的全部文本：手册被切，那一段仍然在末尾', () => {
    const entry = entryOf(
      `---\nname: big\ndescription: 大\n---\n${'a'.repeat(SKILL_TEXT_MAX_BYTES)}`
    )

    const reading = readSkill(entry, { pptRenderer: 'powerpoint', vision: true })

    expect(reading.truncated).toBe(true)
    expect(Buffer.byteLength(reading.text, 'utf8')).toBeLessThanOrEqual(SKILL_TEXT_MAX_BYTES)
    expect(
      reading.text.endsWith(skillRuntimeFactsText({ pptRenderer: 'powerpoint', vision: true }))
    ).toBe(true)
  })
})

describe('注册表：现读、且拿不到结论不拖垮调用方', () => {
  it('默认没有来源 → null；装上之后现读（换结论立即生效），可清空', () => {
    expect(currentSkillRuntimeFacts()).toBeNull()

    let renderer: SkillRuntimeFacts['pptRenderer'] = 'powerpoint'
    setSkillRuntimeFactsSource(() => ({ pptRenderer: renderer, vision: true }))
    expect(currentSkillRuntimeFacts()).toEqual({ pptRenderer: 'powerpoint', vision: true })

    renderer = 'none'
    expect(currentSkillRuntimeFacts()).toEqual({ pptRenderer: 'none', vision: true })

    resetSkillRuntimeFactsSource()
    expect(currentSkillRuntimeFacts()).toBeNull()
  })

  it('来源抛错：warn 后当"没有结论"（技能加载不该因为一次探测失败而失败）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      setSkillRuntimeFactsSource(() => {
        throw new Error('探测炸了')
      })
      expect(currentSkillRuntimeFacts()).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
