/**
 * create_skill / delete_skill（round 65）：让模型**自己**把技能落到用户技能目录里。
 *
 * 为什么需要：现在很多 MCP / 技能 / 插件项目的部署说明都写着"把下面这段发给你的 agent，让它自己装"，
 * 而我们原来只有"插件页装插件"这一条人工路径 —— 用户贴一段安装说明，模型没有手可用。
 * 这两个工具就是那双手：写 `<userData>/skills/<技能名>/`（就是 `skillSourcesFor` 已经在扫的目录），
 * 写完**下一轮对话就能被 discoverSkills 扫到**（技能清单是每轮现算的，不必重启、不必重装）。
 *
 * 边界（都是硬口径）：
 *   - **目录名白名单**：`SKILL_NAME_PATTERN`（小写字母/数字/短横线，1-64 位）—— 它同时是 frontmatter
 *     的 `name`，所以中文/空格/大写一律拒（回人话并给 slug 建议，不抛异常）；
 *   - **写死在托管目录内**：目标 = `<userData>/skills/<名字>`，附带文件的相对路径过
 *     `resolveWithin`（词法 + realpath 硬化，与市场/插件同一把尺）——`..` / 绝对路径 / 符号链接逃逸
 *     全部回 null 即拒；
 *   - **不动插件与内置**：插件技能目录（`<插件 id>-<技能名>`）与内置技能都不许覆盖，删也删不掉
 *     （内置根本不在这个目录里）；
 *   - **上界**：SKILL.md ≤60k 字符，附带文件 ≤20 个、单文件 ≤64KB、合计 ≤256KB（防模型写出巨文件）；
 *   - **写顺序**：先写附带文件、**最后写 SKILL.md** —— SKILL.md 是"这个技能存在"的唯一标志，
 *     最后落它才不会留下半个可见的技能；
 *   - **写完自检**：读回头部确认能解析出来（拿不到就回人话，宁可让模型知道坏了）。
 *
 * 审批：create_skill 按写类（classify 里的表 + guard.needsApproval 的"无显式目标"档：
 * 工作区「完全访问」时免审，与 MCP 外部工具同口径）；delete_skill 是**危险档**，永远问。
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import {
  composeSkillFile,
  readSkillHeader,
  skillEntryPath,
  skillNameProblem,
  type SkillSource
} from '../../shared/skills'
import { resolveWithin } from '../../shared/plugins'
import type { AuthoringRuntime } from '../../shared/authoring'
import { z } from '../../shared/zod'
import { removeDirRobust } from '../../main/plugins/store'
import { approvalSessionOf, needsApproval, type ToolContext } from './guard'

/** 名字不合规时给的建议（模型据此改名重试，而不是反复换写法） */
function nameProblemMessage(tool: 'create_skill' | 'delete_skill', name: string): string {
  return (
    `${tool} 失败：${skillNameProblem(name) ?? '技能名不合法'}。` +
    '示例：把「发票助手」写成 invoice-helper（中文写进 description 与正文里），再调一次。'
  )
}

/** 运行时没注入（无窗口环境 / 单测没给）时的同一句人话 */
const NO_RUNTIME_MESSAGE =
  '当前运行环境不支持创建技能（没有注入技能写入的运行时）：只有桌面端应用里才能写用户技能目录。'

/** 输入上界 */
export const SKILL_BODY_MAX_CHARS = 60000
export const SKILL_FILE_MAX_CHARS = 40000
export const SKILL_FILE_MAX_BYTES = 64 * 1024
export const SKILL_PACKAGE_MAX_BYTES = 256 * 1024
export const SKILL_FILES_MAX = 20

const skillFileSchema = z.object({
  path: z
    .string()
    .min(1, '附带文件的相对路径不能为空（如 reference/checklist.md）')
    .describe(
      'Relative path of the extra file inside the skill directory, for example reference/checklist.md; it cannot be absolute, cannot contain .. and must be at most 3 levels deep'
    ),
  content: z
    .string()
    .max(SKILL_FILE_MAX_CHARS, `单个附带文件最长 ${SKILL_FILE_MAX_CHARS} 字符，请精简或拆开`)
    .describe('File content as text')
})

export const createSkillInputSchema = z.object({
  name: z
    .string()
    .min(1, '技能名不能为空（只能用 1-64 位小写字母、数字或短横线）')
    .max(64, '技能名最长 64 字符（只能用 1-64 位小写字母、数字或短横线）')
    .describe(
      'Skill name, which is both the directory name and the frontmatter name: lowercase letters, digits and hyphens, for example invoice-helper. ' +
        'Non-ASCII characters, spaces and capitals are rejected'
    ),
  description: z
    .string()
    .min(1, 'description 不能为空：模型就是靠它判断"什么时候该用这个技能"')
    .max(1024, '描述最长 1024 字，请精简')
    .describe(
      'One sentence stating when to use this skill: the words the user would use to ask for it. The system instructions show only the name and this sentence'
    ),
  body: z
    .string()
    .min(1, '技能正文不能为空：技能的价值全在正文（做法 + 坑 + 自检）')
    .max(SKILL_BODY_MAX_CHARS, `正文最长 ${SKILL_BODY_MAX_CHARS} 字符，请拆成附带文件`)
    .describe(
      'SKILL.md body in Markdown: the procedure, parameter rules, common pitfalls and the pre-delivery self-check; do not repeat the frontmatter'
    ),
  license: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Source and licence note; when text or structure comes from someone else, state the origin and licence, otherwise write that the user authored it'
    ),
  files: z
    .array(skillFileSchema)
    .max(SKILL_FILES_MAX, `最多 ${SKILL_FILES_MAX} 个附带文件`)
    .optional()
    .describe(
      `Optional supporting files such as reference/*.md or scripts/*, at most ${SKILL_FILES_MAX}`
    )
})

export type CreateSkillInput = z.infer<typeof createSkillInputSchema>

export const deleteSkillInputSchema = z.object({
  name: z
    .string()
    .min(1, '要删除的技能名不能为空（就是 create_skill 时的 name）')
    .max(64, '技能名最长 64 字符（就是 create_skill 时的 name）')
    .describe('Name of the user skill to delete, the same name passed to create_skill')
})

export type DeleteSkillInput = z.infer<typeof deleteSkillInputSchema>

/** 目标技能目录：名字过白名单后再过一遍 resolveWithin（双层防线，链接逃逸在第二层挡住） */
function skillDirOf(
  tool: 'create_skill' | 'delete_skill',
  runtime: AuthoringRuntime,
  name: string
): { ok: true; dir: string } | { ok: false; message: string } {
  const problem = skillNameProblem(name)
  if (problem !== null) return { ok: false, message: nameProblemMessage(tool, name) }
  const dir = resolveWithin(runtime.skillsDir, name.trim())
  if (dir === null) return { ok: false, message: nameProblemMessage(tool, name) }
  return { ok: true, dir }
}

/** 用户自己建的技能目录名（插件的不算）：够用来给"没有这个技能"的提示列清单 */
function userSkillDirs(runtime: AuthoringRuntime): string[] {
  try {
    return readdirSync(runtime.skillsDir)
      .filter((name) => !runtime.pluginSkillDirs.includes(name))
      .filter((name) => {
        const dir = resolveWithin(runtime.skillsDir, name)
        return dir !== null && isFile(skillEntryPath({ path: dir }))
      })
      .sort()
  } catch {
    return []
  }
}

export async function createCreateSkillTool(
  ctx: ToolContext,
  runtime: () => AuthoringRuntime | null
): Promise<Tool<CreateSkillInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'create_skill',
    description:
      // round 70 瘦身：技能名规则与"可带附带文件"分别写在 name / files 字段上，顶层不重复
      'Create or overwrite a user skill by writing <user data dir>/skills/<name>/SKILL.md. ' +
      'Usable from the next turn, since the skill list is recomputed every turn, and visible under Plugins → Skills. ' +
      'Use it when the user pastes skill instructions or asks to remember a procedure.',
    inputSchema: createSkillInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'create_skill', input, approvalSessionOf(approval)),
    execute: async (input) => {
      const rt = runtime()
      if (rt === null) return NO_RUNTIME_MESSAGE

      const target = skillDirOf('create_skill', rt, input.name)
      if (!target.ok) return target.message
      const name = input.name.trim()
      if (rt.pluginSkillDirs.includes(name)) {
        return (
          `create_skill 失败：目录名「${name}」是插件复制进来的技能目录（卸载插件会清掉它），不能覆盖。` +
          '换个名字（比如加个前缀：my-' +
          name +
          '）再试。'
        )
      }
      if (rt.builtinSkillNames.includes(name)) {
        return (
          `create_skill 失败：「${name}」是内置技能名（随应用分发，删不掉也改不动），同名会让 use_skill 先命中内置那份。` +
          '换个名字（比如 my-' +
          name +
          ' 或加业务前缀）再试。'
        )
      }

      // 附带文件：路径先全部校验（逃逸/深度/上界），**一个都不写**地失败 —— 要么整体成功要么整体不写
      const files = input.files ?? []
      const prepared: Array<{ abs: string; relative: string; content: string }> = []
      let totalBytes = 0
      for (const file of files) {
        const relative = file.path.replace(/\\/g, '/').replace(/^\.\//, '')
        const segments = relative.split('/').filter((segment) => segment !== '')
        if (segments.includes('..')) {
          return `create_skill 失败：附带文件「${file.path}」越出了技能目录（相对路径里不能有 ..）。`
        }
        if (
          segments.length === 0 ||
          segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')
        ) {
          return `create_skill 失败：附带文件「${file.path}」的路径里不能有隐藏目录或 node_modules。`
        }
        if (segments.length > 3) {
          return `create_skill 失败：附带文件「${file.path}」层级太深（最多 3 层，与技能目录的文件清单口径一致）。`
        }
        const abs = resolveWithin(target.dir, relative)
        if (abs === null) {
          return (
            `create_skill 失败：附带文件「${file.path}」越出了技能目录（不能是绝对路径、不能含 ..）。` +
            '相对路径请写成 reference/xxx.md 这样。'
          )
        }
        const bytes = Buffer.byteLength(file.content, 'utf8')
        if (bytes > SKILL_FILE_MAX_BYTES) {
          return `create_skill 失败：附带文件「${file.path}」有 ${bytes} 字节，超过单文件上限 ${SKILL_FILE_MAX_BYTES} 字节。`
        }
        totalBytes += bytes
        prepared.push({ abs, relative: segments.join('/'), content: file.content })
      }

      const skillText = composeSkillFile({
        name,
        description: input.description,
        license: input.license?.trim() || '用户自建技能（在对话里创建）',
        body: input.body
      })
      totalBytes += Buffer.byteLength(skillText, 'utf8')
      if (totalBytes > SKILL_PACKAGE_MAX_BYTES) {
        return `create_skill 失败：技能包合计 ${totalBytes} 字节，超过上限 ${SKILL_PACKAGE_MAX_BYTES} 字节（SKILL.md + 全部附带文件）。`
      }

      const existed = existsDir(target.dir)

      try {
        for (const file of prepared) {
          mkdirSync(dirname(file.abs), { recursive: true })
          writeFileSync(file.abs, file.content, 'utf8')
        }
        // SKILL.md 最后写：它是"这个技能存在"的唯一标志（先写它会留下半个可见的技能）
        mkdirSync(target.dir, { recursive: true })
        writeFileSync(skillEntryPath({ path: target.dir }), skillText, 'utf8')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return `create_skill 失败：写盘出错（${detail}）。可以换个技能名或先删掉同名目录再试。`
      }

      // 写完自检：读回头部 —— 解析不出来说明 frontmatter 写坏了，如实告诉模型（别假装成功）
      const source: SkillSource = {
        kind: 'builtin',
        path: target.dir,
        dir: name,
        pluginId: null,
        pluginName: null,
        namePrefix: ''
      }
      const header = readSkillHeader(source)
      if (header === null || header.name !== name) {
        return (
          `create_skill 写完了但自检没过：${skillEntryPath({ path: target.dir })} 读不回可用的 frontmatter。` +
          '请检查 name/description 是否含特殊字符后重试。'
        )
      }

      const fileNote =
        prepared.length === 0
          ? ''
          : `；附带 ${prepared.length} 个文件（${prepared.map((file) => file.relative).join('、')}）`
      return (
        `已${existed ? '更新' : '创建'}技能「${name}」：${skillEntryPath({ path: target.dir })}` +
        `（${header.bytes} 字节${fileNote}）。` +
        `下一轮对话起它就在技能清单里，用户也能在「插件 → 技能」和 + → 引用技能 里看到；` +
        `要立刻确认可以用 use_skill 读回它。`
      )
    }
  })
}

export async function createDeleteSkillTool(
  ctx: ToolContext,
  runtime: () => AuthoringRuntime | null
): Promise<Tool<DeleteSkillInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'delete_skill',
    description:
      'Delete a user skill, removing <user data dir>/skills/<name>/ entirely. Built-in and plugin-copied skills cannot be deleted. Cannot be undone.',
    inputSchema: deleteSkillInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'delete_skill', input, approvalSessionOf(approval)),
    execute: async (input) => {
      const rt = runtime()
      if (rt === null) return NO_RUNTIME_MESSAGE

      const target = skillDirOf('delete_skill', rt, input.name)
      if (!target.ok) return target.message
      const name = input.name.trim()
      if (rt.pluginSkillDirs.includes(name)) {
        return `delete_skill 失败：「${name}」是插件带进来的技能，要删就卸载对应插件（插件页 → 卸载）。`
      }
      if (rt.builtinSkillNames.includes(name)) {
        return `delete_skill 失败：「${name}」是内置技能，随应用分发，删不掉。`
      }
      if (!existsDir(target.dir)) {
        const mine = userSkillDirs(rt)
        return (
          `delete_skill 失败：没有用户技能「${name}」。当前用户技能：` +
          `${mine.length === 0 ? '（一个都没有）' : mine.join('、')}。` +
          '内置技能（如 pptx / docx）删不掉，插件的技能要卸载插件。'
        )
      }

      try {
        removeDirRobust(target.dir)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return `delete_skill 失败：${detail}`
      }
      return `已删除用户技能「${name}」（目录 ${target.dir}）。下一轮对话起它就不在技能清单里了。`
    }
  })
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
