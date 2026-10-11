/**
 * 输入框建议浮窗的纯逻辑（round 15）：`@` 引用工作区文件 / `/` 引用插件与技能。
 *
 * 触发按**词边界**判定：光标前的"当前词"（到上一个空白为止）以 `@` 或 `/` 开头、词里无空白。
 * 于是邮箱（`a@b.com`）、路径（`src/main`、`D:/notes`）里出现在词中的符号**不触发**；
 * 行首或空白后的 `@`/`/` 才触发，触发符与光标之间是过滤关键词。选中某行把 [start, caret)
 * 整段替换成 round 14 的引用标记（`【引用】<kind>：<label>` + 尾随空格）。
 * 「命令」分区本轮不做（没有斜杠命令系统），斜杠浮窗只有 插件 / 技能 两组。
 */
export type SuggestionTriggerKind = 'file' | 'slash'

export interface SuggestionTrigger {
  kind: SuggestionTriggerKind
  /** 触发符在文本里的下标（选中时把 [start, caret) 换成标记） */
  start: number
  /** 触发符后到光标的关键词（空串 = 不过滤） */
  query: string
}

/** 建议行（浮窗统一形状）：主行 label + 次要 hint；选中后插入 reference */
export interface SuggestionRow {
  id: string
  label: string
  hint?: string
  reference: { kind: '文件' | '插件' | '技能'; label: string }
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
}

/** / 浮窗的分组（分区只在非空时出现；顺序 = 插件 → 技能） */
export function slashGroups(input: SlashInputs, query: string): SuggestionGroup[] {
  const q = query.trim().toLowerCase()
  const hit = (name: string): boolean => q === '' || name.toLowerCase().includes(q)

  const groups: SuggestionGroup[] = []
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
