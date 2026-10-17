// @vitest-environment node
/**
 * 渐进式披露的**注入点**（round 64）：技能清单进的是每轮现算的系统指令（第二层全文只在 use_skill 里）。
 *
 * 钉住：
 *   ① 有技能时，指令末尾出现清单（名字 + 描述）与"先用 use_skill 读全文"这条行为要求；
 *   ② **手册正文不进指令**（这一条是渐进式披露的意义所在：SKILL.md 动辄几百行，全量塞进
 *      每轮上下文纯属浪费——大部分轮次用不到）；
 *   ③ 没有技能时指令里不留半句空话（`shellGuidance` / `pptTemplateGuidance` 同一口径）。
 *
 * 用仓库里的内置技能（`resources/skills`）做样本：既钉住注入行为，也顺带守住"内置技能真的能被扫到"。
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { kyclawInstructions, KYCLAW_INSTRUCTIONS } from '../../agents/kyclaw'
import type { SkillSource } from '../../../shared/skills'
import { discoverSkills, skillsGuidance } from '../loader'

const ROOT = resolve(__dirname, '../../../../resources/skills')

const builtinSources: SkillSource[] = ['pptx', 'docx', 'xlsx', 'pdf'].map((dir) => ({
  kind: 'builtin' as const,
  path: join(ROOT, dir),
  dir,
  pluginId: null,
  pluginName: null,
  namePrefix: ''
}))

describe('kyclawInstructions：技能清单注入', () => {
  it('有技能：指令里出现四个技能的名字与描述，且要求先 use_skill 读全文', () => {
    const guidance = skillsGuidance(discoverSkills(builtinSources))
    const text = kyclawInstructions(null, guidance)

    expect(text.startsWith(KYCLAW_INSTRUCTIONS)).toBe(true)
    for (const name of ['pptx', 'docx', 'xlsx', 'pdf']) {
      expect(text, `指令里应出现技能 ${name}`).toContain(`· ${name}：`)
    }
    expect(text).toContain('use_skill')
    expect(text).toContain('【引用】技能：')
    // 011：没有工作区时也明确"技能资源仍用 read 的 skill 参数读"，不要走 bash
    expect(text).toContain("read's `skill` parameter")
    expect(text).toContain('never use bash for skill files')
  })

  // round 68：目录里那几行**只是摘要**——不写清这一点，模型会拿一行描述当作"我读过它了"
  it('说清"这几行只是摘要、加载前不要推断也不要遵循"', () => {
    const text = skillsGuidance(discoverSkills(builtinSources))

    expect(text).toContain('summary only')
    expect(text).toContain('not the manual')
    expect(text).toContain('never infer what it says from its name or description')
    expect(text).toContain('act as if you had followed it')
  })

  // round 74 / P5：时序（动手前先加载，不是边做边补）与"别重复加载"（读过的全文已在上下文里）
  it('说清加载时序与"同一轮不重复加载"（P5）', () => {
    const text = skillsGuidance(discoverSkills(builtinSources))

    expect(text).toContain('before the first step of that task')
    expect(text).toContain('Never load the same manual twice in one turn')
  })

  // round 68：description 的写法口径是"什么时候用"（触发场景）而不是"是什么"
  it('内置技能的 description 都以"什么时候用"开头（触发场景，而不是内容摘要）', () => {
    for (const entry of discoverSkills(builtinSources)) {
      expect(entry.description, `${entry.name} 的 description 该写触发场景`).toContain('时用它')
    }
  })

  it('手册正文不进指令（只看得到名字与描述）', () => {
    const entries = discoverSkills(builtinSources)
    const text = kyclawInstructions(null, skillsGuidance(entries))

    // 正文的小节标题与操作细节都不该出现在指令里
    expect(text).not.toContain('## 常见坑')
    expect(text).not.toContain('## 交付前自检')
    expect(text).not.toContain('create_ppt({')
    // 指令长度应该是"几十行的一段"，而不是把四份手册拼起来
    expect(text.length).toBeLessThan(KYCLAW_INSTRUCTIONS.length + 3000)
  })

  it('没有技能：指令与 round 63 一致（不留空话）', () => {
    const text = kyclawInstructions(null, '')
    expect(text).toContain(KYCLAW_INSTRUCTIONS)
    expect(text).not.toContain('Skills (work manuals)')
  })

  // round 66：PPT 模板从"全局设置"改成"会话级"，指令那一层拿不到会话 id，所以模板名**不进指令**
  // （缺省模板的解析挪到 create_ppt 的工具执行里做）。这条按新事实钉住，免得又有人把它加回来。
  it('PPT 模板不进指令；技能清单照常注入且排在 shell 追加行之后', () => {
    const text = kyclawInstructions(
      null,
      skillsGuidance(discoverSkills([builtinSources[0] as SkillSource]))
    )

    expect(text).not.toContain('固定了 PPT 模板')
    expect(text).not.toContain('学术紫')
    expect(text).toContain('· pptx：')
    expect(text.indexOf('Skills (work manuals)')).toBeGreaterThan(0)
  })
})
