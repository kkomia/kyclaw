/**
 * use_skill：按名字读出一份技能（SKILL.md）的全文 —— 渐进式披露的**第二层**。
 *
 * 第一层是每轮系统指令里的技能清单（名字 + 描述，见 loader.skillsGuidance）；模型判断
 * "这件事该按某技能做"时，用这个工具把该技能的操作手册取全文，再照着做。这样上下文只为
 * 真正用到的技能付费（技能库里多几十份也不影响每轮开销）。
 *
 * 口径：
 *   - **只读**：不碰工作区、不写盘、不改状态 —— 与 read/glob/grep 同档（classify 里点名 `read`，免审批）；
 *   - 来源现读（`sources()` 每轮现取）：用户刚在插件页装了个带技能的插件，下一轮就能用，不必重启；
 *   - 名字大小写不敏感，认识三种写法（技能名 / 目录名 / 去掉插件前缀的目录名）—— 用户从
 *     `+ → 引用技能` 点进来的 `【引用】技能：<名字>` 正好是第三种；
 *   - **找不到不抛错**：回一句人话 + 当前可用技能清单（模型据此改名字或改走对应工具），
 *     抛异常只会让这一轮以错误卡收场，用户还得自己猜可用名字有哪些；
 *   - 回包里带上技能目录的文件清单（`reference/*.md`、`scripts/*` 之类）：
 *     手册里常写"细节见 xxx.md"，模型得先知道有哪些文件，才知道下一步读谁。
 *   - round 68：全文末尾拼一段**本部署事实**（渲染器能不能用 / 当前模型能不能读图），
 *     取值函数由调用方注入（第三个参数；缺省走 `skills/runtime` 的注册表）。见 skills/runtime.ts。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import type { SkillSource } from '../../shared/skills'
import {
  discoverSkills,
  findSkill,
  missingSkillMessage,
  readSkill,
  skillOrigin,
  SKILL_TEXT_MAX_BYTES
} from './loader'
import { approvalSessionOf, needsApproval, type ToolContext } from '../tools/guard'
import {
  currentSkillRuntimeFacts,
  SKILL_RUNTIME_FACTS_HEADING,
  type SkillRuntimeFactsSource
} from './runtime'

export const useSkillInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Skill name as listed in the "Skills (work manuals)" section of the system instructions, or the name in the user message’s `【引用】技能：<name>` marker; case-insensitive'
    )
})

export type UseSkillInput = z.infer<typeof useSkillInputSchema>

/**
 * 回包里的文件清单段（空清单就不写这一段）。
 *
 * 011：清单必须带**怎么读**的示例 —— 只列相对路径会把模型引向 `bash`（区外 → 审批卡），
 * 而正确入口是 `read({ skill: <目录 ID>, path: <相对路径> })`（只读、免审、不扩大写权限）。
 */
function filesSection(skillDir: string, files: readonly string[], truncated: boolean): string {
  if (files.length === 0) return ''
  const tail = truncated ? `（只列了前 ${files.length} 个）` : ''
  const sample = files[0] ?? ''
  const call = `read({ skill: ${JSON.stringify(skillDir)}, path: ${JSON.stringify(sample)} })`
  return (
    `\n技能目录下的文件${tail}（读其中一份：${call} —— skill 填目录 ID，path 填下面的相对路径；` +
    '不要用 bash / glob / grep 读技能文件）：\n' +
    `${files.map((file) => `  · ${file}`).join('\n')}\n`
  )
}

export async function createUseSkillTool(
  ctx: ToolContext,
  sources: () => readonly SkillSource[],
  /**
   * round 68：**本部署事实**的取值函数（现读；缺省 = skills/runtime 的注册表，生产由
   * `createKyclawMastra` 装上）。拼在全文末尾的那一段 —— 渲染器能不能用、模型能不能读图，
   * 直接决定自检该怎么收尾。注入什么就拼出什么（spec 直接钉这一段）。
   */
  facts: SkillRuntimeFactsSource = currentSkillRuntimeFacts
): Promise<Tool<UseSkillInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'use_skill',
    description:
      'Read one skill’s full manual (parameter rules, pitfalls, pre-delivery self-check) plus the file list of its directory. ' +
      'Read those files with the read tool: skill = the skill directory ID printed in the result (read accepts only this ID, not the skill name), path = the listed relative path; never use bash for them. ' +
      'The "Skills (work manuals)" section of the system instructions carries names and descriptions only, so load the manual here before doing that kind of work. ' +
      'The result ends with a "本部署事实" block stating what this deployment can actually do (whether it can render page images, whether the current model reads images); that block overrides any "should" in the manual. ' +
      'The name is case-insensitive and an unknown name returns the list of available skills instead of failing. Read-only: it changes nothing.',
    inputSchema: useSkillInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'use_skill', input, approvalSessionOf(approval)),
    execute: async (input) => {
      const entries = discoverSkills(sources())
      const entry = findSkill(entries, input.name)
      if (entry === undefined) return missingSkillMessage(entries, input.name)

      const loaded = (() => {
        try {
          return { ok: true as const, reading: readSkill(entry, facts()) }
        } catch (error) {
          return { ok: false as const, why: error instanceof Error ? error.message : String(error) }
        }
      })()
      if (!loaded.ok) {
        return (
          `技能「${entry.name}」的全文读不出来：${loaded.why}。` +
          '技能目录可能刚被删除或改动；请稍后重试，或让用户重新安装该技能。'
        )
      }
      const reading = loaded.reading
      const header = [
        `技能「${reading.name}」（${skillOrigin(entry)}）的全文：`,
        entry.description === '' ? '' : `> ${entry.description}`,
        entry.license === '' ? '' : `> 许可：${entry.license}`,
        `> 技能目录 ID：${entry.dir}（read 的 skill 参数只认这个目录 ID，不认技能名；读目录里的资源用 read({ skill: ${JSON.stringify(entry.dir)}, path: "…" })；只读，不要用 bash）`,
        `> 末尾那一段「${SKILL_RUNTIME_FACTS_HEADING.replace(/^#+\s*/, '')}」由本机在加载时拼上，优先于正文里的应然说法。`,
        filesSection(entry.dir, reading.files, reading.filesTruncated)
      ]
        .filter((line) => line !== '')
        .join('\n')

      const truncatedNote = reading.truncated
        ? `\n\n（SKILL.md 超过 ${Math.floor(SKILL_TEXT_MAX_BYTES / 1024)}KB：这里只给了它前面一段；` +
          '末尾那段「本部署事实」是随文附上的，照常有效）'
        : ''

      return `${header}\n\n${reading.text}${truncatedNote}`
    }
  })
}
