/**
 * read 的「已注册技能目录」只读通道（011）。
 *
 * 为什么需要它：`use_skill` 能读 `<userData>/skills/<dir>/SKILL.md`，但回包列出的
 * `reference/*.md` 等配套资源不在任何授权工作区里 —— 模型照着手册去 `read` 会失败，错误提示
 * 又把它推向 `bash`（区外审批）。这里给 `read` 增加一个**只读**入口：`skill` 只是注册表里的
 * **索引**，不是路径；目标路径永远由应用侧注册的目录 + 受校验的相对路径拼出来。
 *
 * 信任来源只有一个：`ToolContext.trustedReadRoots`（生产 = `discoverSkills(skillSourcesFor(),
 * { warn: false })` 现读，**只含当前有效的技能**，与 use_skill / 系统指令清单同一份判据）。
 * 不信任模型自述、`use_skill` 的输出文本、SKILL.md 正文、MCP 工具名或描述。
 *
 * 边界（每条都在 `read-skill.spec.ts` 里钉住）：
 *   - 技能目录本身必须是**真实目录**（lstat 不是符号链接 / junction），且**当前仍是有效技能**
 *     （SKILL.md 可读、realpath 不越出根、带闭合 frontmatter）—— 运行中被改坏/卸载同样拒绝；
 *   - 资源只能用技能目录内的**相对路径**：拒绝绝对路径、盘符（含 `C:foo`）、UNC / 设备路径、
 *     `..` 段；段级检查与技能导入（skill-zip 的 assertSegments）同一套：段尾点/空格、冒号
 *     （ADS/盘符）、Windows 非法字符/控制符、设备名都拒绝。`.` 与普通带点文件名照常放行
 *     （`.. .` 这类写法会被段尾点规则拒绝；只把它当**校验歧义**处理，不宣称已证明越界）；
 *   - 隐藏段（`.git` / `.env` 等）与 `node_modules` 不读 —— 与 use_skill 返回的文件清单同一口径；
 *   - 最终路径走 `resolveInsideWorkspace` 的 realpath containment：技能目录内的链接/junction
 *     指向外部时会被拒（指向目录内部的链接无害，放行）。
 */
import { lstatSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { isUncPath, resolveInsideWorkspace } from '../../main/permission/realpath'
import { isValidSkillSource, isWindowsReservedName } from '../../shared/skills'
import type { ToolContext, TrustedReadRoot } from './guard'

export interface TrustedReadTarget {
  /** 引擎归一后的真实绝对路径；调用方只能拿它去碰文件系统 */
  abs: string
  /** 技能目录的真实根（图片档的相对路径按它算） */
  root: string
  entry: TrustedReadRoot
}

/** 与 `findSkill` 同一套写法：去引用前缀 / 反引号，大小写不敏感（这里只认目录 ID） */
function skillIdOf(raw: string): string {
  return raw
    .trim()
    .replace(/^【引用】\s*技能：/, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
}

function registeredRoot(ctx: ToolContext, skill: string): TrustedReadRoot {
  const needle = skillIdOf(skill)
  if (needle === '') {
    throw new Error('read 的 skill 参数不能为空；读普通工作区文件不要带 skill 参数')
  }

  const roots = ctx.trustedReadRoots()
  const entry = roots.find((candidate) => candidate.id.toLowerCase() === needle)
  if (entry === undefined) {
    const ids = roots.map((candidate) => candidate.id)
    throw new Error(
      `没有已注册的技能「${skill.trim()}」。当前可用的技能目录 ID：${ids.join('、') || '（一个都没有）'}。` +
        'read 的 skill 只接受 use_skill 回包里的目录 ID；普通工作区文件不要带 skill 参数。'
    )
  }
  return entry
}

/** 技能目录本身不能是链接（扫描侧也过滤；这里是执行侧的防线，防注册表被手工塞进链接目录） */
function assertRealDirectory(entry: TrustedReadRoot): void {
  if (entry.path.trim() === '') {
    throw new Error(`技能目录不可读：「${entry.id}」`)
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    // 先词法归一：Windows 上 `link\` 会跟随链接，lstat 就看不出来了
    stat = lstatSync(resolve(entry.path))
  } catch {
    throw new Error(`技能目录不可读：「${entry.id}」`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`技能目录不是一个真实目录：「${entry.id}」`)
  }
}

/**
 * 运行时复查：注册表里的目录**现在**仍要是一份有效技能。生产侧的 `trustedReadRoots` 已用
 * `discoverSkills(..., { warn:false })` 过滤；这里是执行侧兜底（防旧装配 / 手工注册 / 扫描后被改坏）。
 */
function assertValidSkill(entry: TrustedReadRoot): void {
  if (!isValidSkillSource({ path: entry.path })) {
    throw new Error(
      `技能「${entry.id}」当前不可用：目录里没有可读的 SKILL.md，或 SKILL.md 缺少有效的 frontmatter`
    )
  }
}

/** Windows 文件名里非法/会被改写的字符（与 skill-zip 导入的段级检查同一套） */
const WINDOWS_ILLEGAL_CHARS = /[*?"<>|]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/

/**
 * 一个路径段的显式校验（与 `skill-zip` 的 assertSegments 同口径）。返回 null = 放行，
 * 否则返回给模型看的原因。`.` 与普通带点文件名（`foo.bar`）照常放行。
 */
function segmentProblem(segment: string): string | null {
  if (segment === '' || segment === '.') return null
  // 既有拒 `..` 策略保持不变：两个点以上的纯点段一律拒（`...` 也算，不扩到普通带点名）
  if (/^\.{2,}$/.test(segment.trim())) return '不能包含 ..（不允许穿越技能目录）'
  // Windows 会吞掉路径段尾的点/空格：`.. .`、`foo.`、`foo ` 的系统解释与字面不一致
  if (/[. ]$/.test(segment)) return '路径段不能以点或空格结尾（Windows 会改写它）'
  // 与 use_skill 返回的文件清单同一口径：点开头的隐藏段与 node_modules 不读
  if (segment.startsWith('.')) return '不能读隐藏文件或隐藏目录（点开头的路径段）'
  if (segment.toLowerCase() === 'node_modules') return '不能读 node_modules'
  if (segment.includes(':')) return '不能包含冒号（Windows 上会被当成数据流或盘符）'
  if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
    return '路径段不能包含 Windows 不接受的字符（* ? " < > |）'
  }
  if (CONTROL_CHARS.test(segment)) return '路径段不能包含控制字符'
  if (isWindowsReservedName(segment)) return '不能用 Windows 设备名（CON / NUL / COM1 这类）'
  return null
}

/** 模型给相对路径的**形状**校验：只接受技能目录内的普通相对路径（不解释成链接或设备） */
function resourcePathOf(raw: string, entry: TrustedReadRoot): string {
  if (raw.trim() === '') throw new Error('要读的技能资源路径不能为空')
  const rel = raw.replace(/\\/g, '/')
  if (rel.includes('\0') || isUncPath(rel) || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(
      `技能「${entry.id}」的资源只能用技能目录内的相对路径（不能是绝对路径 / UNC / 盘符）：${raw}`
    )
  }
  for (const segment of rel.split('/')) {
    const problem = segmentProblem(segment)
    if (problem !== null) {
      throw new Error(`技能「${entry.id}」的资源路径不合法：${problem}：${raw}`)
    }
  }
  return rel
}

/**
 * `read({ skill, path })` → 已校验的绝对目标。
 * 抛出的错误都是给模型看的人话（原因 + 可用 ID / 正确写法），不含技能目录的绝对路径。
 */
export function resolveTrustedRead(
  ctx: ToolContext,
  skill: string,
  relativePath: string
): TrustedReadTarget {
  const entry = registeredRoot(ctx, skill)
  assertRealDirectory(entry)
  assertValidSkill(entry)

  // 先 realpath 技能目录本身：注册路径的父级可能是链接，后面的相对路径必须以真实根为基准
  const root = resolveInsideWorkspace(resolve(entry.path), '.')
  if (!root.ok) {
    throw new Error(`技能目录不可用：「${entry.id}」（${root.reason}）`)
  }

  const rel = resourcePathOf(relativePath, entry)
  const resolved = resolveInsideWorkspace(root.abs, rel)
  if (!resolved.ok) {
    throw new Error(
      `技能资源不在技能「${entry.id}」的目录内：${relativePath}（${resolved.reason}）`
    )
  }
  return { abs: resolved.abs, root: root.abs, entry }
}
