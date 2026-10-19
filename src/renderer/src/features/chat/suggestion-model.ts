/**
 * 输入框建议浮窗的纯逻辑（round 15）：`@` 引用工作区文件 / `/` 引用插件与技能。
 *
 * 触发按**词边界**判定：光标前的"当前词"（到上一个空白为止）以 `@` 或 `/` 开头、词里无空白。
 * 于是邮箱（`a@b.com`）、路径（`src/main`、`D:/notes`）里出现在词中的符号**不触发**；
 * 行首或空白后的 `@`/`/` 才触发，触发符与光标之间是过滤关键词。选中某行把 [start, caret)
 * 整段替换成 round 14 的引用标记（`【引用】<kind>：<label>` + 尾随空格）。
 *
 * round 19：`/` 浮窗加了**「命令」分区**（首条 = 「压缩上下文」，次要位显示当前使用率）——
 * 命令行不插引用标记，选中是"立即执行"（`command` 字段），由 Composer 转交上层；过滤/键盘
 * 导航照旧（命令行也参与同一根平铺轴）。
 *
 * round 85：同一分区多了「进入规划模式」（用户实报 016 问题三：`/` 菜单里没有进规划的入口）——
 * 它**不是**第二条实现，选中走的是 ＋ 菜单那条**同一个** `enterPlan`（Composer 的 mode props）；
 * 已在规划里 / 实例未就绪时不传 `plan`，这条就不出现。它排在「压缩上下文」**后面**，默认高亮
 * 仍是压缩（打 `/` 回车不该被切进规划模式）。
 */
import type { KernelCommandSummary } from '@shared/kernel-ui'
import { PLAN_ENTER_LABEL } from './plan-ui'

export type SuggestionTriggerKind = 'file' | 'slash'

export interface SuggestionTrigger {
  kind: SuggestionTriggerKind
  /** 触发符在文本里的下标（选中时把 [start, caret) 换成标记 / 命令行则整段移除） */
  start: number
  /** 触发符后到光标的关键词（空串 = 不过滤） */
  query: string
}

/**
 * 建议行（浮窗统一形状）：主行 label + 次要 hint；
 * 引用行（reference）选中后插入标记，命令行（command）选中后立即执行。
 */
export interface SuggestionRow {
  id: string
  label: string
  hint?: string
  /** 不可用（如压缩命令在流式/等审批期间）：可见但点了没反应 */
  disabled?: boolean
  reference?: { kind: '文件' | '插件' | '技能'; label: string }
  /** 命令行的动作标识（round 19「压缩上下文」；round 85「进入规划模式」；PB-039 加「目标」） */
  command?: string
  /**
   * 选中后的动作（PB-018）：`insert` = 只把 `/<命令名> ` 留在输入框（leadingInput，如 goal），
   * `execute` = 立即交给内核命令平面执行；缺省 = 旧路径（compact/plan 的既有回调）。
   */
  commandRun?: 'insert' | 'execute'
}

export interface SuggestionGroup {
  title: string
  rows: SuggestionRow[]
}

/** 文件浮窗最多显示几条（过滤后再截） */
export const FILE_SUGGESTION_LIMIT = 8

/** 光标处的触发（没有就 null） */
export function detectTrigger(text: string, caret: number): SuggestionTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const match = /(^|\s)([@/])([^\s]*)$/.exec(before)
  if (match === null) return null
  const query = match[3]
  return {
    kind: match[2] === '@' ? 'file' : 'slash',
    start: before.length - query.length - 1,
    query
  }
}

/** 路径尾段（列表主行显示文件名） */
export function nameOfPath(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * 过滤文件（大小写不敏感、路径子串）：文件名命中排在"只命中目录段"的前面；同档保持原序
 * （主进程给的稳定排序），到限即截。
 */
export function filterFiles(
  files: readonly string[],
  query: string,
  limit = FILE_SUGGESTION_LIMIT
): string[] {
  const q = query.trim().toLowerCase()
  if (q === '') return files.slice(0, limit)
  const score = (file: string): number => (nameOfPath(file).toLowerCase().includes(q) ? 0 : 1)
  return files
    .map((file, index) => ({ file, index }))
    .filter((entry) => entry.file.toLowerCase().includes(q))
    .sort((a, b) => score(a.file) - score(b.file) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.file)
}

/** @ 浮窗的行（主行 = 文件名，次要 = 相对路径；选中插 `【引用】文件：<相对路径>`） */
export function fileRows(
  files: readonly string[],
  query: string,
  limit = FILE_SUGGESTION_LIMIT
): SuggestionRow[] {
  return filterFiles(files, query, limit).map((path) => ({
    id: `file:${path}`,
    label: nameOfPath(path),
    hint: path,
    reference: { kind: '文件', label: path }
  }))
}

export interface SlashInputs {
  /** 启用中的 MCP server（id + 用户取的名字；round 15 的「插件」组） */
  plugins: ReadonlyArray<{ id: string; name: string }>
  /** 已安装技能（dir + 名字；round 13 起的数据源） */
  skills: ReadonlyArray<{ dir: string; name: string }>
  /**
   * 命令分区（round 19）：`percent` = 当前上下文使用率（0–100；取不到 null）；
   * `busy` = 压缩进行中（hint 显示「压缩中…」）；`disabled` = 流式/等审批时不给点。
   */
  command?: {
    percent: number | null
    busy: boolean
    disabled: boolean
  }
  /**
   * 「进入规划模式」这一条（round 85）：不传 = 这条不出现（**已在规划里**没有"再进入"这件事，
   * 实例未就绪时也没有可动的对象）；`disabled` = 正在跑 / 等审批 / 压缩中，可见但按不动
   * （与 ＋ 菜单那条同一档）。选中走的是 ＋ 菜单**同一个实现**，这里只决定露不露这一行。
   */
  plan?: { disabled: boolean }
  /**
   * PB-018：内核 `commands/list` 的目录。给了 = **命令分区只来自它**（不再拼静态三行）；
   * 不给 = 旧路径（flag 关，保持 0.1.6 菜单）。
   */
  commands?: readonly KernelCommandSummary[]
}

/** 内核命令名 → 菜单展示文案（只做本地化/图标文案，不决定命令是否存在；清单永远来自 catalog） */
const KERNEL_COMMAND_LABEL: Readonly<Record<string, string>> = {
  compact: '压缩上下文',
  plan: PLAN_ENTER_LABEL,
  goal: '目标',
  export: '导出',
  feedback: '反馈',
  permission: '权限'
}

function kernelCommandLabel(command: KernelCommandSummary): string {
  return KERNEL_COMMAND_LABEL[command.name] ?? command.name
}

/** / 浮窗的分组（分区只在非空时出现；顺序 = 命令 → 插件 → 技能） */
export function slashGroups(input: SlashInputs, query: string): SuggestionGroup[] {
  const q = query.trim().toLowerCase()
  const hit = (name: string): boolean => q === '' || name.toLowerCase().includes(q)

  const groups: SuggestionGroup[] = []
  const commands: SuggestionRow[] = []
  if (input.commands !== undefined) {
    // PB-018：内核模式 —— 命令分区**只来自 catalog**（顺序也照内核给的原序），不再拼静态行。
    for (const entry of input.commands) {
      const label = kernelCommandLabel(entry)
      const description = entry.description?.trim() ?? ''
      if (!hit(entry.name) && !hit(label) && !hit(description)) continue
      const compact = entry.name === 'compact'
      const plan = entry.name === 'plan'
      const state = input.command
      commands.push({
        id: `command:${entry.name}`,
        label,
        ...(compact
          ? {
              ...(state === undefined
                ? {}
                : state.busy
                  ? { hint: '压缩中…' }
                  : state.percent === null
                    ? {}
                    : { hint: `已使用 ${state.percent}%` }),
              disabled: state?.disabled === true || state?.busy === true
            }
          : plan
            ? { disabled: input.plan?.disabled === true }
            : {
                ...(description === '' ? {} : { hint: description }),
                disabled: state?.disabled === true
              }),
        command: entry.name,
        commandRun: entry.name === 'goal' ? 'insert' : 'execute'
      })
    }
  } else {
    // flag 关：保持 0.1.6 静态三行（内核目录此时不可用，不能假装有命令）
    // 首选顺序照旧是「压缩上下文」（默认高亮 = 平铺第一行）：习惯性打 `/` 再回车的人不该被切进规划模式。
    // 模式入口排在它**后面** —— 它是"换一种做法"，要选得先下移一行
    if (hit('压缩上下文')) {
      const command = input.command
      commands.push({
        id: 'command:compact',
        label: '压缩上下文',
        ...(command === undefined
          ? {}
          : {
              ...(command.busy
                ? { hint: '压缩中…' }
                : command.percent === null
                  ? {}
                  : { hint: `已使用 ${command.percent}%` }),
              disabled: command.disabled || command.busy
            }),
        command: 'compact'
      })
    }
    if (input.plan !== undefined && hit(PLAN_ENTER_LABEL)) {
      commands.push({
        id: 'command:plan',
        label: PLAN_ENTER_LABEL,
        disabled: input.plan.disabled,
        command: 'plan'
      })
    }
    // PB-039：`/goal` 是 leadingInput（选中只把 `/goal ` 留在输入框，由提交时的解析器执行）
    if (hit('目标')) {
      commands.push({
        id: 'command:goal',
        label: '目标',
        hint: '设置 / 查看 goal',
        command: 'goal'
      })
    }
  }
  if (commands.length > 0) groups.push({ title: '指令', rows: commands })
  const plugins = input.plugins.filter((plugin) => hit(plugin.name))
  if (plugins.length > 0) {
    groups.push({
      title: '插件',
      rows: plugins.map((plugin) => ({
        id: `plugin:${plugin.id}`,
        label: plugin.name,
        reference: { kind: '插件', label: plugin.name }
      }))
    })
  }
  const skills = input.skills.filter((skill) => hit(skill.name))
  if (skills.length > 0) {
    groups.push({
      title: '技能',
      rows: skills.map((skill) => ({
        id: `skill:${skill.dir}`,
        label: skill.name,
        reference: { kind: '技能', label: skill.name }
      }))
    })
  }
  return groups
}

/** 分组 → 平铺行（键盘上下走的是一条轴） */
export function flattenGroups(groups: readonly SuggestionGroup[]): SuggestionRow[] {
  return groups.flatMap((group) => group.rows)
}
