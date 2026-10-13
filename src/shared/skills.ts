import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'

/**
 * 技能（Agent Skills 约定）的**跨进程共用面**：技能来源的形状、SKILL.md 的 frontmatter 解析、
 * 技能名派生、以及"只读文件头"这一口。
 *
 * 约定（agentskills.io / Claude Code 事实标准，与插件市场同一生态）：
 *   技能 = 一个目录，目录里有 `SKILL.md`；文件以 `---` 包围的 frontmatter 开头，
 *   官方只要求 `name` + `description` 两个字段（还可能有 license / allowed-tools 之类，我们**只取需要的**）。
 *
 * round 68：**有没有 frontmatter 是"这份文件算不算技能"的判据** —— 没有就整份忽略（`readSkillSource`
 * 给出原因，调用方记一条警告），不再拿裸文本当技能（元数据是技能的入口面：名字与"什么时候用"都从
 * 那里来，少了它模型无从判断要不要读它）。解析的**内容**仍然一律宽容（见 parseSkillFrontmatter 的边界）。
 *
 * 为什么放在 shared：主进程（插件页总览列技能名）与 agent 侧（渐进式披露的清单、use_skill 读全文）
 * 都要同一套解析与命名口径 —— 两处各写一份必然分叉（`+ → 引用技能` 插进消息的名字，
 * 与 use_skill 认的名字必须是同一个）。
 *
 * 依赖纪律：**不为了 YAML 装新依赖**。frontmatter 只用极简的 `key: value` 行解析
 * （外加 `|`/`>` 块标量这一种常见写法）；嵌套结构 / 锚点 / 多文档一律不认（跳过，不报错）。
 */
export const SKILL_FILE = 'SKILL.md'

/** 技能来源：内置（随包分发）或插件（用户在插件页装进来的） */
export type SkillKind = 'builtin' | 'plugin'

/** 一份技能的来源信息（扫描口径：技能目录，不是插件目录） */
export interface SkillSource {
  kind: SkillKind
  /** 技能目录的绝对路径（SKILL.md 就在它下面） */
  path: string
  /** 技能目录名（`<userData>/skills` 下的一级目录名；内置 = 技能目录名） */
  dir: string
  /** 来自哪个已安装插件（内置、没记录 = null） */
  pluginId: string | null
  pluginName: string | null
  /** 插件技能的目录名前缀（`<插件 id>-`）：去掉它也算命中该技能；内置 = 空串 */
  namePrefix: string
}

/** SKILL.md 里我们真正会用到的字段（其余键解析出来但不参与行为） */
export interface SkillDocs {
  /** frontmatter 的全部键值（键已小写；值已去引号 / 展平块标量） */
  data: Record<string, string>
  /** frontmatter 之后的正文（文件没有 frontmatter 时 = 原文） */
  body: string
  /**
   * 有没有**闭合的** frontmatter（首行 `---` 且找到收尾行）。
   *
   * 它是"这份文件算不算技能"的判据（round 68，照 Agent Skills / DSH 的约定）：frontmatter 是
   * 技能的元数据面 —— 少了它，文件名与描述都无处可取，模型也就无从判断"什么时候该用我"。
   * 解析的**内容**仍然一律宽容（认不出的键跳过、值写坏照原样收），但"有没有"这件事必须能判：
   * `readSkillSource` 据此把整份忽略掉（见那里的口径）。
   */
  frontmatter: boolean
}

/** frontmatter 只读这么多字节就够（它必然在文件开头，官方要求 description 一句话） */
const HEADER_READ_MAX_BYTES = 64 * 1024

/** 从路径按字节上界读一段 UTF-8 文本（截断点收在字符边界上，不会切出半个汉字） */
function readBounded(file: string, maxBytes: number): { text: string; bytes: number } | null {
  let size: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return null
    size = stat.size
  } catch {
    return null
  }
  const take = Math.min(size, maxBytes)
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(take)
    const read = readSync(fd, buffer, 0, take, 0)
    return { text: new StringDecoder('utf8').write(buffer.subarray(0, read)), bytes: size }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** 去引号：成对的 `"…"` / `'…'` 去掉引号并解一层转义，其余原样 */
function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** 块标量（`|` / `>`，可带 `-`/`+` 收尾符）→ 一段文本：去公共缩进，`>` 折成段落、`|` 保留换行 */
function foldBlock(lines: readonly string[], folded: boolean): string {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const strip = indents.length === 0 ? 0 : Math.min(...indents)
  const body = lines.map((line) => (line.trim() === '' ? '' : line.slice(strip)))
  if (!folded) return body.join('\n').trim()

  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of body) {
    if (line === '') {
      if (current.length > 0) paragraphs.push(current.join(' '))
      current = []
      continue
    }
    current.push(line.trim())
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n')
}

/**
 * 解析 SKILL.md：返回 frontmatter 的键值 + 正文 + "有没有 frontmatter"。
 *
 * 边界（都是"不报错、按没有 frontmatter 处理"的保守取舍；此时 `frontmatter: false`，
 * 调用方（readSkillSource）据此把这份文件整个忽略 —— 但**绝不抛错**）：
 *   - 首行不是 `---` → 没有 frontmatter（整份都是正文）；
 *   - 没找到闭合的 `---`/`...` → 同样当没有（宁可当正文，也不吃掉半份操作手册）；
 *   - 缩进行（嵌套 map/数组）、`#` 注释行、认不出的行 → 跳过；
 *   - 值里 `#` 不做行内注释切分（引号里的 `#` 与裸值一视同仁——技能描述里常有 `C#` 之类）。
 */
export function parseSkillFrontmatter(text: string): SkillDocs {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return { data: {}, body: normalized, frontmatter: false }
  }

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (line === '---' || line === '...') {
      end = index
      break
    }
  }
  if (end === -1) return { data: {}, body: normalized, frontmatter: false }

  const data: Record<string, string> = {}
  for (let index = 1; index < end; index += 1) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#') || /^\s/.test(raw)) continue
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const key = raw.slice(0, colon).trim().toLowerCase()
    if (key === '') continue
    const value = raw.slice(colon + 1).trim()

    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = []
      let cursor = index + 1
      for (; cursor < end; cursor += 1) {
        const line = lines[cursor] ?? ''
        if (line.trim() === '') {
          block.push('')
          continue
        }
        if (!/^\s/.test(line)) break
        block.push(line)
      }
      index = cursor - 1
      data[key] = foldBlock(block, value.startsWith('>'))
      continue
    }

    data[key] = unquote(value)
  }

  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, ''),
    frontmatter: true
  }
}

/**
 * 技能名（权威口径）：frontmatter 的 `name` 优先；没有就用目录名 ——
 * 插件技能把 `<插件 id>-` 前缀去掉（与插件页显示的、`+ → 引用技能` 插入的名字一致）。
 */
export function skillNameOf(
  source: Pick<SkillSource, 'dir' | 'namePrefix'>,
  declared: string
): string {
  const name = declared.trim()
  if (name !== '') return name
  const prefix = source.namePrefix
  if (prefix !== '' && source.dir.startsWith(prefix)) {
    const rest = source.dir.slice(prefix.length)
    return rest === '' ? source.dir : rest
  }
  return source.dir
}

/**
 * 用户自建技能的**名字白名单**（round 65）：它同时是目录名与 frontmatter 的 `name`，
 * 所以按官方 Agent Skills 的命名约定收紧成小写 slug —— 目录名跨平台安全（Windows 大小写不敏感、
 * `:`/`\`/空格都不该出现），`+ → 引用技能` 插进消息的名字也不必转义。
 *
 * 中文等内容放 `description` 与正文里（模型与用户看到的都是那段），名字保持拉丁 slug：
 * 「发票助手」→ `invoice-helper`。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 名字不合规时的同一句人话（工具、内置作者手册、界面提示共用一份口径） */
export const SKILL_NAME_PROBLEM =
  '技能名只能用 1-64 位小写字母、数字或短横线，且首字符是字母或数字（它同时是目录名与引用名）'

/** 名字能用作技能目录名吗？不合规回原因，合规回 null */
export function skillNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return '技能名不能为空'
  if (!SKILL_NAME_PATTERN.test(trimmed)) return `${SKILL_NAME_PROBLEM}；「${trimmed}」不可以`
  return null
}

/**
 * frontmatter 的一行（`key: value`）——**写**的那一侧，与 parseSkillFrontmatter 成对：
 * 值折成单行（我们的解析器只认单行键值 + 块标量，不认多行普通标量），必要时加双引号转义。
 * 需要引号的情形：空值、以 `>`/`|` 开头（会被当块标量）、以引号/`#` 开头（会被去引号或当注释）。
 */
export function frontmatterLine(key: string, value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  const needsQuote =
    flat === '' ||
    /^[|>]/.test(flat) ||
    /^['"]/.test(flat) ||
    /^#/.test(flat) ||
    flat.includes('\\')
  return needsQuote ? `${key}: "${flat.replace(/(["\\])/g, '\\$1')}"` : `${key}: ${flat}`
}

/**
 * 拼一份 SKILL.md（frontmatter + 正文）——只有**写**技能的那一侧用它，
 * 与 parseSkillFrontmatter 构成往返（见 spec：写出来的文件要能被同一条解析路读回原值）。
 */
export function composeSkillFile(input: {
  name: string
  description: string
  license: string
  body: string
}): string {
  const lines = [
    '---',
    frontmatterLine('name', input.name),
    frontmatterLine('description', input.description),
    frontmatterLine('license', input.license),
    '---',
    '',
    input.body.replace(/\r\n?/g, '\n').trim(),
    ''
  ]
  return lines.join('\n')
}

/** SKILL.md 的入口绝对路径 */
export function skillEntryPath(source: Pick<SkillSource, 'path'>): string {
  return join(source.path, SKILL_FILE)
}

/** 一份技能的头部信息（清单/指令里只需要名字与描述，不必读全文） */
export interface SkillHeader {
  name: string
  description: string
  license: string
  /** SKILL.md 的绝对路径 */
  file: string
  /** SKILL.md 的字节数 */
  bytes: number
}

/**
 * 读一个技能来源：**三种结局都可判**，且一律不抛（round 68）——
 * 一份写坏的技能只该被忽略，不该让整条技能链路（乃至这一轮对话）倒下。
 *
 *   - `ok: true`：拿到头部（名字走 frontmatter，缺了退回目录名去插件前缀）；
 *   - `kind: 'missing'`：这个目录里没有可读的 `SKILL.md` —— **正常情况**（插件根目录下什么目录都有），
 *     调用方静默跳过，不必记日志；
 *   - `kind: 'invalid'`：文件在，但**没有（闭合的）frontmatter** —— 它不是一个技能文件。
 *     调用方记一条警告后忽略这一份（照 Agent Skills / DSH 的约定：元数据是技能的入口面）。
 */
export type SkillHeaderRead =
  | { ok: true; header: SkillHeader }
  | { ok: false; file: string; kind: 'missing' | 'invalid'; why: string }

export function readSkillSource(source: SkillSource): SkillHeaderRead {
  const file = skillEntryPath(source)
  const read = readBounded(file, HEADER_READ_MAX_BYTES)
  if (read === null) {
    return { ok: false, file, kind: 'missing', why: `没有可读的 ${SKILL_FILE}` }
  }
  const { data, frontmatter } = parseSkillFrontmatter(read.text)
  if (!frontmatter) {
    return {
      ok: false,
      file,
      kind: 'invalid',
      why: `没有 frontmatter：${SKILL_FILE} 必须以 --- 包围的元数据开头（至少写 name 与 description）`
    }
  }
  return {
    ok: true,
    header: {
      name: skillNameOf(source, data.name ?? ''),
      description: (data.description ?? '').trim(),
      license: (data.license ?? '').trim(),
      file,
      bytes: read.bytes
    }
  }
}

/**
 * 读一个技能来源的头部：读不出来 → null（调用方跳过这条来源）。
 * 只读前 64KB —— frontmatter 必然在开头，不为了一个 description 把整份手册读进内存。
 * 要"为什么跳过"（记日志用）就用 `readSkillSource`。
 */
export function readSkillHeader(source: SkillSource): SkillHeader | null {
  const read = readSkillSource(source)
  return read.ok ? read.header : null
}

/** `plugins:overview` / 指令清单里的一行技能（不含正文） */
export interface SkillSummary {
  name: string
  description: string
  dir: string
  kind: SkillKind
}
