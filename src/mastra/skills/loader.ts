/**
 * 技能加载（agent 侧，round 64；本部署事实 round 68）：把"技能目录"读成两样东西 ——
 *   ① **清单**（每个技能的 name + description，注入每轮系统指令：渐进式披露的第一层）；
 *   ② **全文**（`use_skill` 按需读的 SKILL.md + **本部署事实**段 + 该技能目录下的文件清单：第二层）。
 *
 * 为什么分两层：SKILL.md 是操作手册，动辄几百行。全量塞进系统指令会把每轮上下文吃掉一大块，
 * 而且**大部分轮次用不到**（改个变量、查个文件）。所以默认只给名字与"什么时候该用我"，
 * 模型判断要用了再 `use_skill` 取全文（Anthropic 的 Agent Skills 就是这个口径）。
 *
 * 来源两类（都在 `SkillSource` 里描述，由主进程按现读设置算好传进来）：
 *   - 内置：随包分发的 `resources/skills/<名字>/SKILL.md`（office 四件套，见仓库该目录）；
 *   - 插件：装插件时复制到 `<userData>/skills/<插件 id>-<技能名>/` 的那份（installer 落地）。
 * 本模块**只管读**：装/卸/扫描目录归属都在 main/plugins 那一侧（谁写谁负责收拾）。
 *
 * round 68 的两条新口径：
 *   - **容错**：一份写坏的技能（没有 frontmatter）只记一条警告后忽略，坏的不会带倒好的，更不会抛；
 *   - **部署事实拼在全文末尾**（`readSkill` 的 `facts` 参数）：那段讲的是"本机现在能不能渲染页图、
 *     当前模型能不能读图"，由 main 侧探测后注入（本模块不 import 硬件探测），见 skills/runtime.ts。
 *
 * 纯函数 + 同步 fs（口径与 settings/插件目录扫描一致）：技能目录就几十 KB 级，
 * 每轮现读能保证"用户刚装的插件下一轮就能用"，不必重启、也不用缓存失效逻辑。
 */
import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  readSkillSource,
  resolveSkillEntryFile,
  SKILL_FILE,
  type SkillSource,
  type SkillSummary
} from '../../shared/skills'
import { skillRuntimeFactsText, type SkillRuntimeFacts } from './runtime'

/** 技能的完整描述（清单用头部，读全文时才用这里的 file） */
export interface SkillEntry extends SkillSummary {
  /** SKILL.md 的绝对路径 */
  file: string
  /** SKILL.md 的字节数（发现时快照；readSkill 按当前长度重新判断，见该函数） */
  bytes: number
  /** frontmatter 里的 license（没有 = 空串）；第三方技能的来源声明靠它 */
  license: string
  source: SkillSource
}

/** use_skill 读全文的字节上界（与 read 工具同量级：单份手册 256KB 足够，超了截断并注明） */
export const SKILL_TEXT_MAX_BYTES = 256 * 1024

/** 文件清单的上限（条数与深度；够模型知道"这份技能还带了哪些参考资料"） */
export const SKILL_FILE_LIST_MAX = 100
export const SKILL_FILE_DEPTH_MAX = 3

/**
 * 扫一遍来源 → 技能清单。**按来源顺序**保留（内置在前由调用方决定）；
 * 同一份 SKILL.md 被两条来源指到（去重按路径，Windows 大小写不敏感）只留第一条。
 *
 * **容错（round 68）**：一条来源出问题只影响它自己 ——
 *   - 目录里没有 SKILL.md → 静默跳过（插件根目录下什么目录都有，这不是异常）；
 *   - 有 SKILL.md 但没有（闭合的）frontmatter → **记一条警告后整份忽略**（它不是一个技能文件；
 *     元数据是模型判断"什么时候用它"的唯一依据，缺了它进清单只会误导）；
 *   - 文件读不出来 / 解析过程里任何异常一律被吞成"跳过"（见 readSkillSource 与 readBounded）。
 * 无论哪一条，都**不抛**：技能是加法，一份写坏的技能不该让这一轮对话倒下。
 */
export interface DiscoverSkillsOptions {
  /**
   * 坏 frontmatter 是否记警告（缺省 true）。`read({ skill })` 的信任根每次工具调用都要现算，
   * 用 `warn: false` 复用同一份"有效技能"判据，但不在每次 read 时重复刷日志。
   */
  warn?: boolean
}

export function discoverSkills(
  sources: readonly SkillSource[],
  options: DiscoverSkillsOptions = {}
): SkillEntry[] {
  const seen = new Set<string>()
  const entries: SkillEntry[] = []
  for (const source of sources) {
    const read = readSkillSource(source)
    if (!read.ok) {
      if (read.kind === 'invalid' && options.warn !== false) {
        console.warn(`[kyclaw] 技能被忽略：${read.file} —— ${read.why}`)
      }
      continue
    }
    const { header } = read
    const key = normalizePath(header.file)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      name: header.name,
      description: header.description,
      dir: source.dir,
      kind: source.kind,
      file: header.file,
      bytes: header.bytes,
      license: header.license,
      source
    })
  }
  return entries
}

function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * 技能名/目录名 → 一条技能（大小写不敏感）。
 * 认三种写法：清单里的名字、目录名、插件技能目录名去掉 `<插件 id>-` 前缀的那段。
 * 用户在 `+ → 引用技能` 里点到的是最后一种，`【引用】技能：<名字>` 进消息后照样能命中。
 */
export function findSkill(entries: readonly SkillEntry[], query: string): SkillEntry | undefined {
  const needle = query
    .trim()
    .replace(/^【引用】\s*技能：/, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
  if (needle === '') return undefined
  return entries.find(
    (entry) =>
      entry.name.toLowerCase() === needle ||
      entry.dir.toLowerCase() === needle ||
      entry.dir.toLowerCase() === `${entry.source.namePrefix}${needle}`.toLowerCase()
  )
}

/** 清单里一行：`名字：描述`（描述缺了也要给名字，模型至少知道有这个技能） */
export function skillLine(entry: SkillEntry): string {
  return entry.description === '' ? entry.name : `${entry.name}：${entry.description}`
}

/**
 * **渐进式披露的第一层**：拼进系统指令的技能清单（只给名字与描述）。
 * 与 `shellGuidance` / `pptTemplateGuidance` 同一形态 —— 一段以 `\n- ` 开头的追加行；
 * 没有技能就回空串（指令里不留半句空话）。
 *
 * 措辞里有三件必须说清的事（round 68 定前两件，round 74 / P5 加第三件）：
 *   ① 这些**只是摘要**，不是手册内容 —— 否则模型会拿一行描述当"我已经读过它了"；
 *   ② 用法是**先加载再照做** —— 不加载就按名字推断技能要求，等于假装读过一份没读过的文档；
 *   ③ **匹配即先加载**（CC 的 Skill 工具口径）：时序是"动手之前"，不是"边做边补"；
 *      且**同一轮不重复加载** —— 读过的全文已经在上下文里，再调一次只是白花一遍钱。
 *
 * 语言口径（round 74）：**我们自己写的规则用英文**（与稳定层一致），技能名与描述是**数据**，
 * 来自各份 SKILL.md 的 frontmatter，保持它们本来的语言 —— 所以这一段是英文框架 + 中文数据行。
 */
export function skillsGuidance(entries: readonly SkillEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => `  · ${skillLine(entry)}`).join('\n')
  return (
    '\n- Skills (work manuals): each line below is a **summary only** (name + when to use it), **not the manual** — ' +
    'until use_skill loads one, never infer what it says from its name or description, and never act as if you had followed it. ' +
    'The moment a task matches one of these, read its full manual with use_skill **before the first step of that task**, not halfway through. ' +
    'Never load the same manual twice in one turn: it is already in your context. ' +
    'To read a file inside a skill directory (the list use_skill returns; hidden paths and node_modules are not readable), call `read` with `skill` set to the ' +
    'skill directory ID that use_skill prints and `path` set to the relative file path — never use bash, glob or grep for skill files. ' +
    'A `【引用】技能：<name>` in the user message names the skill to use:' +
    `\n${lines}` +
    '\n  (names and descriptions only; the procedure, parameter rules, pitfalls and pre-delivery self-check are all in the full text use_skill returns.)'
  )
}

/** 一份技能的全文与配套文件清单（use_skill 的回包） */
export interface SkillReading {
  name: string
  /**
   * 全文（SKILL.md 正文 + 末尾那段**本部署事实**；渲染不可用等部署差异就在这里说清）。
   * 超过 256KB 只取前一段 —— 上界算的是**返回的全部文本**（含尾部那段），见 readSkill。
   */
  text: string
  truncated: boolean
  /**
   * 技能目录下的**真实文件**（相对路径、正斜杠；最多 100 条）。
   * 入口是真实文件时包含 SKILL.md 自己；符号链接条目（含指向目录内部的 SKILL.md 链接）不进清单 ——
   * 清单只列 `lstat` 认为是普通文件的东西，隐藏段与 node_modules 也已排除。
   */
  files: string[]
  filesTruncated: boolean
}

/**
 * 读全文（按字节上界截断，截断点收在字符边界上）。
 *
 * `facts` 是**本部署事实**（由调用方注入；缺省/拿不到 = null）：它拼在全文**末尾**，
 * 与技能正文用 `---` 隔开（形状见 skills/runtime.ts）。为什么拼在这里而不是写进 SKILL.md：
 * 同一份手册要适配无数台机器，路径与能力只能是"加载那一刻"的部署事实（DSH 的做法，见
 * `.superpowers/sdd/2026-10-10-kyclaw-mvp/_r68-dsh-notes.md` §2.3）。
 *
 * 截断口径：上界 `SKILL_TEXT_MAX_BYTES` 算的是**返回的全部文本**，所以正文先让出尾部那段的
 * 字节数再截 —— 结果就是"手册可能被切，但部署事实永远看得见"。
 *
 * 011：入口不可读（目录/入口消失、根变成链接、入口链接指向目录外）时**抛错**，不返回成功形状的
 * 空正文，也不列目录（否则链接根会把外部文件名带出去）。截断按**当前文件长度**算，不信任
 * discovery 时的 `entry.bytes` 快照；无论是否截断都只读 budget 字节。
 */
export function readSkill(entry: SkillEntry, facts?: SkillRuntimeFacts | null): SkillReading {
  // 011：discovery 之后入口可能被删 / 改成坏 frontmatter / 换成链接；这里按当前盘面再判一次，
  // 不把"入口已经不是一个技能"当成成功形状的空正文（use_skill 会把它翻成明确失败）
  const readable = readSkillSource(entry.source)
  if (!readable.ok) {
    throw new Error(
      `技能「${entry.name}」的 ${SKILL_FILE} 不可读：` +
        (readable.kind === 'invalid'
          ? '缺少有效的 frontmatter'
          : '入口不存在，或不是技能目录内的真实文件')
    )
  }

  const tail = skillRuntimeFactsText(facts ?? null)
  const tailBytes = Buffer.byteLength(tail, 'utf8')
  const budget = Math.max(1024, SKILL_TEXT_MAX_BYTES - tailBytes)
  const file = resolveSkillEntryFile(entry.source)
  if (file === null) {
    throw new Error(
      `技能「${entry.name}」的 ${SKILL_FILE} 不可读：入口不存在，或不是技能目录内的真实文件`
    )
  }
  const size = skillEntrySize(file, entry.name)
  const limited = size > budget
  let text = ''
  try {
    if (size > 0) text = readPrefix(file, Math.min(size, budget))
  } catch {
    throw new Error(`技能「${entry.name}」的 ${SKILL_FILE} 读取失败`)
  }

  const listing = listSkillFiles(entry.source.path)
  return {
    name: entry.name,
    text: `${text}${tail}`,
    truncated: limited,
    files: listing.files,
    filesTruncated: listing.truncated
  }
}

/** 当前入口文件的字节数；不是普通文件 / 拿不到 → 明确失败（不返回空正文） */
function skillEntrySize(file: string, name: string): number {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error('not a regular file')
    return stat.size
  } catch {
    throw new Error(`技能「${name}」的 ${SKILL_FILE} 不可读：文件不存在或不是普通文件`)
  }
}

function readPrefix(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    return new StringDecoder('utf8').write(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
}

/**
 * 技能目录下的文件清单（递归、按路径排序、条数与深度都有上界）。
 * 只列文件不列目录：模型关心的是"还有哪些资料可读"，不是目录树。
 * 隐藏目录（`.git` 之类）与 `node_modules` 不进清单（技能包里偶尔混进这些）。
 *
 * 011：**不跟随链接** —— 根目录本身与每个目录项都用 `lstat`（不是 `stat`）判断：
 * 根是符号链接 / junction（技能目录在扫描后被替换）时直接返回空清单，子项链接也跳过。
 * 否则清单会把链接指向的外部文件名列给模型，等于泄露一份可探测的目录
 * （而且那些名字随后也过不了 `read` 的 containment）。
 *
 * 为什么不用 `readdirSync(..., { withFileTypes: true }).isFile()`：部分网络盘 / 文件系统返回
 * `DT_UNKNOWN`，Dirent 的 is* 全是 false，会把正常文件整批漏掉。`lstat` 在两边都可靠。
 */
export function listSkillFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  try {
    const rootStat = lstatSync(root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { files, truncated }
  } catch {
    return { files, truncated }
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > SKILL_FILE_DEPTH_MAX) return
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (files.length >= SKILL_FILE_LIST_MAX) {
        truncated = true
        return
      }
      if (name.startsWith('.') || name.toLowerCase() === 'node_modules') continue
      const full = join(dir, name)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile()) continue
      files.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 1)
  return { files, truncated }
}

/** 技能来源的人话说明（use_skill 回包里的"来自哪里"） */
export function skillOrigin(entry: SkillEntry): string {
  if (entry.source.kind === 'builtin') return '内置技能'
  return entry.source.pluginName === null ? '插件技能' : `插件「${entry.source.pluginName}」`
}

/** use_skill 找不到名字时的引导（可用清单 + 兜底建议） */
export function missingSkillMessage(entries: readonly SkillEntry[], query: string): string {
  const names = entries.map((entry) => entry.name)
  const list = names.length === 0 ? '（当前没有可用技能）' : names.join('、')
  return (
    `没找到技能「${query.trim()}」。当前可用技能：${list}。` +
    '核对名字后重试；如果只是想生成文件，也可以直接调对应工具' +
    '（create_ppt / create_docx / create_excel / create_report / create_pdf）。'
  )
}
