/**
 * 网页引用协议（0.1.3）：助手正文里的数字 Markdown 链接是**引用标记**，不是普通链接。
 *
 * ## P0 provenance（2026-10-17 审核返工）
 *
 * 正文 URL **不授权来源**。只有同一轮里**已完成**的 web_search / fetch 工具结果中出现过的
 * URL（按 citationKey 规范化）才算已知来源；调用方把这份 allowlist（`knownSources`）传进来：
 *   - 正文数字链接命中 allowlist → 角标 + 来源面板；
 *   - 未命中 → 保持普通安全外链（不是 citation，也不进来源面板）；
 *   - 工具输出自己永远不会变成一条来源：来源必须由正文数字链接引用。
 *
 * 多 assistant 消息（审批 / ask-user / 计划续跑）的 allowlist 由 MessageList 按用户消息
 * 划轮、在本轮连续的 assistant 消息之间合并；不允许跨用户轮。
 *
 * ## 解析口径
 *
 *   - 只认 1–3 位数字的链接文本，且目标必须是 http(s)（`javascript:` / `data:` / 相对路径一律不算）；
 *   - 先剥围栏代码（含 blockquote / 列表内的围栏）、缩进代码、行内代码、HTML 注释与 reference
 *     definition，再扫内联链接与 reference-style 链接；代码示例里的 `[1](url)` 不进来源；
 *   - HTML 实体按 CommonMark 的可见结果解码（`&amp;` 等），保证面板 href 与正文链接一致；
 *   - 来源按**规范化 URL**去重（忽略 fragment、保留 query、host/协议小写、去默认端口、
 *     `www.` 与非默认端口的展示/匹配口径一致），顺序 = 首次出现顺序；后面出现的 title
 *     回填给第一次没写 title 的那条；
 *   - 已完成 web_search / fetch 的工具结果建立 allowlist（授权）；两者的 title/snippet
 *     用于补 hover 卡（2026-10-18 引用返工：fetch 也解析 HTML title/meta 或正文摘要，
 *     不再"没有标题就不编"；仍缺就由正文引用上下文兜底）；
 *   - `extractCitations()` 必须显式传 allowlist（没有默认空 map 的旁路），文本按 part 分别提取，
 *     避免未闭合围栏跨 text part 把下一段正文一起吞掉。
 */

/** hover 卡里补全的站点信息（来自工具结果；只用于已知来源的展示） */
export interface CitationHint {
  title?: string
  snippet?: string
}

/** 正文里的一条来源（派生视图，不落存储） */
export interface Citation {
  label: string
  url: string
  host: string
  title?: string
  snippet?: string
}

/** web_search 输出解析出的一条结果（用于补全 hover 卡 / 建立 allowlist） */
export interface WebSearchSource {
  title: string
  url: string
  snippet: string
}

/** 本轮已知来源：citationKey → 可选展示信息。键存在即授权，值可以为空对象。 */
export type KnownSources = ReadonlyMap<string, CitationHint>

/** 单条消息 / 一轮最多收这么多来源：病态长回复不把面板撑爆 */
export const MAX_SOURCES = 50

/** hover 摘要的长度上限（参考文档的 160 字口径） */
export const SOURCE_SNIPPET_CHARS = 160

/** 单条消息 / 一轮最多解析这么多工具结果条目（正常一次搜索 ≤ 10 条） */
export const MAX_HINTS = 200

/** 工具输出最多读这么多字符（fetch 正文上限 64KB；留一倍余量，病态输出不反复扫描） */
export const MAX_TOOL_OUTPUT_CHARS = 256 * 1024

/** 没有来源时的稳定空数组（避免每次渲染换身份） */
export const EMPTY_CITATIONS: readonly Citation[] = []

/** 没有已知来源时的稳定空 map（没有工具结果的宿主用） */
export const EMPTY_KNOWN_SOURCES: KnownSources = new Map()

/**
 * CommonMark 会解码 HTML 实体后再渲染。这里只覆盖 URL / 标题里常见的命名实体与全部数字实体；
 * 认不出的命名实体原样保留（与"不猜"一致）。不为了完整 HTML5 实体表引入依赖。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  sol: '/',
  quest: '?',
  num: '#',
  equals: '=',
  percnt: '%',
  plus: '+',
  commat: '@',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrack: '[',
  rbrack: ']',
  ast: '*',
  midast: '*',
  excl: '!',
  dollar: '$',
  semi: ';',
  comma: ',',
  period: '.',
  lowbar: '_',
  hyphen: '-',
  dash: '-',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™'
}

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g

/** 解码 Markdown 可见文本里的 HTML 实体；非法码点原样保留 */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(
    ENTITY_PATTERN,
    (
      match: string,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined
    ): string => {
      if (decimal !== undefined) {
        const code = Number.parseInt(decimal, 10)
        if (!isValidCodePoint(code)) return match
        return String.fromCodePoint(code)
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16)
        if (!isValidCodePoint(code)) return match
        return String.fromCodePoint(code)
      }
      const entity = named === undefined ? undefined : NAMED_ENTITIES[named.toLowerCase()]
      return entity ?? match
    }
  )
}

function isValidCodePoint(code: number): boolean {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
}

/** 数字引用文本：`1` / `[12]` / `^3`（允许模型套加粗/斜体） */
export function citationLabel(text: string): string | undefined {
  const cleaned = decodeHtmlEntities(text)
    .replace(/\\/g, '')
    .replace(/[*_~`]/g, '')
    .trim()
  const match = /^(?:\[(\d{1,3})\]|\^?(\d{1,3}))$/.exec(cleaned)
  return match?.[1] ?? match?.[2]
}

/** 安全外链：只接受带主机名的 http(s)，返回 URL 规范化后的 href（其余一律 undefined） */
export function safeHttpUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  // Markdown 渲染会先解码实体（`&amp;` → `&`）；这里同一口径，否则面板 href 会与正文分裂
  const trimmed = decodeHtmlEntities(value.trim())
  if (trimmed === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '') return undefined
  // 带账号密码的 URL 不在引用卡里展示（host 会遮住凭据，用户看不出点去哪）
  if (parsed.username !== '' || parsed.password !== '') return undefined
  return parsed.href
}

/**
 * 规范化 host：小写、去 `www.`、保留**非默认端口**。
 *
 * 展示与去重必须同一口径：否则工具结果 `https://www.example.org/x` 与正文
 * `https://example.org/x` 会显示成同一个 host、却匹配不上；`:8443` 也会被显示层吞掉。
 */
function canonicalHost(hostname: string): string {
  const lower = hostname.toLowerCase()
  // `www.example.org` → `example.org`；`www.com` 这种单标签后缀不剥（会变成 `com`）
  if (!lower.startsWith('www.') || lower.indexOf('.', 4) === -1) return lower
  return lower.slice(4)
}

/** 展示用 host：URL 解析器统一小写、去默认端口；`www.` 前缀不占卡片宽度；非默认端口要显示 */
export function hostOf(value: string): string {
  const url = safeHttpUrl(value)
  if (url === undefined) return ''
  const parsed = new URL(url)
  const host = canonicalHost(parsed.hostname)
  return parsed.port === '' ? host : `${host}:${parsed.port}`
}

/**
 * 去重键：fragment 不算身份（同一页不同锚点合并），query 算（`?page=2` 是另一页）。
 * URL 解析器负责协议/host 小写与默认端口归一；`www.` 与展示层同口径去掉。
 * 返回值仍是可点击的绝对 URL。
 */
export function citationKey(value: string): string | undefined {
  const url = safeHttpUrl(value)
  if (url === undefined) return undefined
  const parsed = new URL(url)
  parsed.hash = ''
  const host = canonicalHost(parsed.hostname)
  const authority = parsed.port === '' ? host : `${host}:${parsed.port}`
  return `${parsed.protocol}//${authority}${parsed.pathname}${parsed.search}`
}

/** 摘要压成一行并按码点截断（避免切出半个代理对） */
export function clipSnippet(text: string, maxChars = SOURCE_SNIPPET_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const points = Array.from(clean)
  return points.length <= maxChars ? clean : `${points.slice(0, maxChars).join('')}…`
}

interface MarkdownLine {
  start: number
  end: number
}

interface LinkDefinition {
  url: string
  title?: string
}

function lineRanges(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const end = offset + line.length
    lines.push({ start: offset, end })
    offset = end + 1
  }
  return lines
}

function lineTextOf(chars: readonly string[], line: MarkdownLine): string {
  return chars.slice(line.start, line.end).join('')
}

/** 把一段替换成等长空格（保留换行/位置对齐），后续链接扫描就不会命中被剥掉的内容 */
function maskRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index++) {
    const char = chars[index]
    if (char !== '\n' && char !== '\r') chars[index] = ' '
  }
}

/** HTML 注释不会渲染成正文；里面的 `[1](url)` 不能变成来源 */
function maskHtmlComments(chars: string[]): void {
  const text = chars.join('')
  const comment = /<!--[\s\S]*?(?:-->|$)/g
  for (let match = comment.exec(text); match !== null; match = comment.exec(text)) {
    maskRange(chars, match.index, match.index + match[0].length)
  }
}

/** 剥掉 blockquote 前缀（支持嵌套 `> >`），返回正文起点 */
function stripBlockquotePrefix(line: string): { content: string; offset: number } {
  let offset = 0
  for (;;) {
    const match = /^ {0,3}>[ \t]?/.exec(line.slice(offset))
    if (match === null) break
    offset += match[0].length
  }
  return { content: line.slice(offset), offset }
}

/** 行内 code：成对的等长反引号串（块级代码已先变成空格） */
function maskInlineCode(chars: string[]): void {
  let index = 0
  while (index < chars.length) {
    if (chars[index] !== '`') {
      index += 1
      continue
    }
    let runLength = 1
    while (chars[index + runLength] === '`') runLength += 1
    let cursor = index + runLength
    let close = -1
    while (cursor < chars.length) {
      if (chars[cursor] !== '`') {
        cursor += 1
        continue
      }
      let closeRun = 1
      while (chars[cursor + closeRun] === '`') closeRun += 1
      if (closeRun === runLength) {
        close = cursor
        break
      }
      cursor += closeRun
    }
    if (close < 0) {
      index += runLength
      continue
    }
    maskRange(chars, index, close + runLength)
    index = close + runLength
  }
}

const DEFINITION =
  /^ {0,3}\[([^\]]+)\]:[ \t]*(?:<([^<>\n]*)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/

const DEFINITION_TITLE = /^ {0,3}(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))[ \t]*$/

/** definition 可能写在 blockquote / 列表项里：剥掉容器前缀后再匹配（renderer 也认） */
function definitionContentOf(line: string): string {
  return stripBlockquotePrefix(line).content.replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/, '')
}

function normalizeReferenceLabel(label: string): string {
  return decodeHtmlEntities(label)
    .replace(/\\([\\[\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 在扫描链接前把**渲染成代码/注释**的内容替换成空格，并收集 reference definitions。
 *
 * 覆盖审核报告里会导致"面板有来源、正文没有角标"的几类：
 *   - blockquote 内的围栏代码（`> ``` `）；
 *   - 缩进代码（4 空格 / tab；按 CommonMark 的"前一行是空行"才起块，避免误伤列表续行）；
 *   - 列表项里的围栏（`- ``` `）；
 *   - HTML 注释；
 *   - reference definition 行本身（它不渲染）。
 * 不做完整 AST；真正的 HTML / 复杂容器仍可能留下边角，但不为此引入新依赖。
 */
function prepareMarkdownText(text: string): {
  masked: string
  definitions: Map<string, LinkDefinition>
} {
  const chars = text.split('')
  maskHtmlComments(chars)
  const lines = lineRanges(text)
  let fence: { marker: string; length: number } | null = null
  let inIndentedCode = false
  let previousBlank = true
  /** 前一行是标题 / 分隔线 / 围栏结束这类"块边界"：缩进代码可以直接起块 */
  let previousBlockBoundary = false

  for (const line of lines) {
    const current = lineTextOf(chars, line)
    const { content } = stripBlockquotePrefix(current)
    const blank = content.trim() === ''

    if (fence !== null) {
      maskRange(chars, line.start, line.end)
      const close = /^ {0,4}(`{3,}|~{3,})[ \t]*$/.exec(content)
      let closed = false
      if (close !== null) {
        const run = close[1] ?? ''
        if ((run[0] ?? '') === fence.marker && run.length >= fence.length) {
          fence = null
          closed = true
        }
      }
      previousBlank = false
      previousBlockBoundary = closed
      continue
    }

    if (inIndentedCode) {
      if (blank || /^(?: {4}|\t)/.test(content)) {
        maskRange(chars, line.start, line.end)
        previousBlank = blank
        previousBlockBoundary = false
        continue
      }
      inIndentedCode = false
    }

    // 缩进代码不能打断段落：前一行是空行 / 块边界（标题、分隔线、围栏结束）才起块；
    // 列表项的缩进续行仍按段落处理，避免把真实链接误判成代码。
    const indented = /^(?: {4}|\t)/.test(content)
    if ((previousBlank || previousBlockBoundary) && indented) {
      inIndentedCode = true
      maskRange(chars, line.start, line.end)
      previousBlank = false
      previousBlockBoundary = false
      continue
    }

    const opener = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/.exec(content)
    if (opener !== null) {
      const run = opener[1] ?? ''
      fence = { marker: run[0] ?? '`', length: run.length }
      maskRange(chars, line.start, line.end)
      previousBlank = false
      previousBlockBoundary = false
      continue
    }

    const heading = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content)
    const thematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
      content
    )
    previousBlank = blank
    previousBlockBoundary = heading || thematicBreak
  }

  const definitions = new Map<string, LinkDefinition>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const content = definitionContentOf(lineTextOf(chars, line))
    const match = DEFINITION.exec(content)
    if (match === null) continue

    const label = normalizeReferenceLabel(match[1] ?? '')
    const rawUrl = match[2] ?? match[3] ?? ''
    const rawTitle = match[4] ?? match[5] ?? match[6]
    let title =
      rawTitle === undefined ? undefined : decodeHtmlEntities(unescapeTitle(rawTitle)).trim()
    const url = decodeHtmlEntities(unescapeDestination(rawUrl.trim())).trim()
    maskRange(chars, line.start, line.end)
    if (label === '' || url === '') continue

    // title 可以写在下一行（CommonMark 的 reference definition 允许）
    if (title === undefined || title === '') {
      const next = lines[index + 1]
      if (next !== undefined) {
        const nextContent = definitionContentOf(lineTextOf(chars, next))
        const titleMatch = DEFINITION_TITLE.exec(nextContent)
        if (titleMatch !== null) {
          const nextTitle = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3]
          if (nextTitle !== undefined) {
            title = decodeHtmlEntities(unescapeTitle(nextTitle)).trim()
            maskRange(chars, next.start, next.end)
            index += 1
          }
        }
      }
    }

    if (!definitions.has(label)) {
      definitions.set(label, {
        url,
        ...(title === undefined || title === '' ? {} : { title })
      })
    }
  }

  maskInlineCode(chars)
  return { masked: chars.join(''), definitions }
}

/** 从 `[` 开始找配对的 `]`（支持转义与嵌套方括号） */
function closingBracket(text: string, open: number): number {
  let depth = 0
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') {
      depth += 1
      continue
    }
    if (char !== ']') continue
    if (depth === 0) return index
    depth -= 1
  }
  return -1
}

/** Markdown 链接的 `(` 后允许空白（最多一个换行） */
function skipWhitespace(text: string, start: number): number {
  let index = start
  let lineBreaks = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      lineBreaks += 1
      if (lineBreaks > 1) break
      index += 1
      continue
    }
    break
  }
  return index
}

function unescapeDestination(value: string): string {
  return value.replace(/\\([\\()<> ])/g, '$1')
}

function unescapeTitle(value: string): string {
  return value.replace(/\\(["'()\\])/g, '$1')
}

interface RawMarkdownLink {
  label: string
  url: string
  title?: string
  /** 链接在 markdown 原文里的起点（collectLinks 填；上下文摘句用） */
  start: number
  end: number
}

/**
 * 解析一个内联链接 `[label](destination "title")`。
 *
 * 目标地址用**平衡括号**扫描：Wikipedia 的 `Paris_(disambiguation)` 不会被截断；
 * `<...>` 形式也支持。title 支持双引号 / 单引号 / 圆括号三种 Markdown 写法。
 */
function parseLinkAt(text: string, open: number): RawMarkdownLink | null {
  if (text[open] !== '[') return null
  // `![alt](url)` 是图片，不是引用
  if (open > 0 && text[open - 1] === '!') return null
  const labelEnd = closingBracket(text, open)
  if (labelEnd < 0) return null
  let cursor = labelEnd + 1
  if (text[cursor] !== '(') return null
  cursor = skipWhitespace(text, cursor + 1)

  let url = ''
  if (text[cursor] === '<') {
    const close = text.indexOf('>', cursor + 1)
    if (close < 0) return null
    url = text.slice(cursor + 1, close)
    cursor = close + 1
  } else {
    const start = cursor
    let depth = 0
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '(') {
        depth += 1
        cursor += 1
        continue
      }
      if (char === ')') {
        if (depth === 0) break
        depth -= 1
        cursor += 1
        continue
      }
      if (depth === 0 && (char === ' ' || char === '\t' || char === '\r' || char === '\n')) {
        break
      }
      cursor += 1
    }
    url = text.slice(start, cursor)
  }

  const afterUrl = cursor
  cursor = skipWhitespace(text, cursor)
  let title: string | undefined
  const closer =
    text[cursor] === '"' ? '"' : text[cursor] === "'" ? "'" : text[cursor] === '(' ? ')' : null
  if (closer !== null) {
    const titleStart = cursor + 1
    cursor = titleStart
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (text[cursor] === closer) break
      cursor += 1
    }
    if (cursor >= text.length) return null
    title = text.slice(titleStart, cursor)
    cursor += 1
  } else {
    cursor = afterUrl
  }

  cursor = skipWhitespace(text, cursor)
  if (text[cursor] !== ')') return null
  const decodedUrl = decodeHtmlEntities(unescapeDestination(url.trim())).trim()
  if (decodedUrl === '') return null
  const decodedTitle =
    title === undefined ? undefined : decodeHtmlEntities(unescapeTitle(title)).trim()
  return {
    label: text.slice(open + 1, labelEnd),
    url: decodedUrl,
    ...(decodedTitle === undefined || decodedTitle === '' ? {} : { title: decodedTitle }),
    start: open,
    end: cursor + 1
  }
}

/**
 * Reference-style link：`[1][ref]` / `[1][]` / `[1]`（只有 definition 存在才算链接）。
 *
 * 完整引用找不到 definition 时，CommonMark 会回退到 shortcut（用链接文本本身找 definition）；
 * 这里同口径。没命中返回 null，正文按普通文本渲染。
 */
function parseReferenceLinkAt(
  text: string,
  open: number,
  definitions: ReadonlyMap<string, LinkDefinition>
): RawMarkdownLink | null {
  if (text[open] !== '[') return null
  if (open > 0 && text[open - 1] === '!') return null
  const labelEnd = closingBracket(text, open)
  if (labelEnd < 0) return null

  const labelText = text.slice(open + 1, labelEnd)
  let end = labelEnd + 1
  let referenceLabel = labelText
  if (text[end] === '[') {
    const referenceEnd = closingBracket(text, end)
    if (referenceEnd >= 0) {
      const rawReference = text.slice(end + 1, referenceEnd).trim()
      if (rawReference !== '') referenceLabel = rawReference
      end = referenceEnd + 1
    }
  }

  let definition = definitions.get(normalizeReferenceLabel(referenceLabel))
  if (definition === undefined && end !== labelEnd + 1) {
    definition = definitions.get(normalizeReferenceLabel(labelText))
  }
  if (definition === undefined) return null
  return {
    label: labelText,
    url: definition.url,
    ...(definition.title === undefined ? {} : { title: definition.title }),
    start: open,
    end
  }
}

/** 去掉代码/注释后扫出所有链接（图片跳过；链接内部不再二次扫描） */
function collectLinks(text: string): RawMarkdownLink[] {
  const { masked, definitions } = prepareMarkdownText(text)
  const links: RawMarkdownLink[] = []
  for (let index = 0; index < masked.length; index++) {
    if (masked[index] !== '[') continue
    if (index > 0 && masked[index - 1] === '\\') continue
    const inline = parseLinkAt(masked, index)
    if (inline !== null) {
      links.push(inline)
      index = inline.end - 1
      continue
    }
    const reference = parseReferenceLinkAt(masked, index, definitions)
    if (reference !== null) {
      links.push(reference)
      index = reference.end - 1
    }
  }
  return links
}

function collectCitationsInto(
  text: string,
  knownSources: KnownSources,
  byKey: Map<string, Citation>
): void {
  for (const link of collectLinks(text)) {
    const label = citationLabel(link.label)
    if (label === undefined) continue
    const url = safeHttpUrl(link.url)
    if (url === undefined) continue
    const key = citationKey(url)
    if (key === undefined) continue
    // P0：正文 URL 只负责"引用"，授权来自已知工具结果
    if (!knownSources.has(key)) continue

    const existing = byKey.get(key)
    if (existing !== undefined) {
      if (existing.title === undefined && link.title !== undefined) existing.title = link.title
      continue
    }
    if (byKey.size >= MAX_SOURCES) continue
    byKey.set(key, {
      label,
      url,
      host: hostOf(url),
      ...(link.title === undefined ? {} : { title: link.title })
    })
  }
}

function withKnownHints(byKey: Map<string, Citation>, knownSources: KnownSources): Citation[] {
  return [...byKey.values()].map((citation) => {
    const key = citationKey(citation.url)
    const hint = key === undefined ? undefined : knownSources.get(key)
    const hintTitle = hint?.title?.trim()
    const hintSnippet = hint?.snippet?.trim()
    const title =
      citation.title ?? (hintTitle === undefined || hintTitle === '' ? undefined : hintTitle)
    const snippet = hintSnippet === undefined || hintSnippet === '' ? undefined : hintSnippet
    return {
      ...citation,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet })
    }
  })
}

/**
 * 从整段助手正文提取来源：只收**命中 knownSources** 的数字文本 + 安全 http(s) 链接，
 * 按规范化 URL 首次顺序去重。`knownSources` 只补 title / snippet；没有对应正文链接的
 * 工具结果不会出现在返回值里。
 */
export function extractCitations(text: string, knownSources: KnownSources): Citation[] {
  if (knownSources.size === 0) return []
  const byKey = new Map<string, Citation>()
  collectCitationsInto(text, knownSources, byKey)
  return withKnownHints(byKey, knownSources)
}

/**
 * 按 text part 分别提取再合并。
 *
 * 为什么不先 join：未闭合围栏 / 行内 code 的状态会跨 part 传染（流式消息尤其常见），
 * 把下一段真实引用吞掉；每个 part 在渲染时也是独立的 Markdown 实例，提取必须同粒度。
 */
export function extractCitationsFromTexts(
  texts: readonly string[],
  knownSources: KnownSources
): Citation[] {
  if (knownSources.size === 0) return []
  const byKey = new Map<string, Citation>()
  for (const text of texts) collectCitationsInto(text, knownSources, byKey)
  return withKnownHints(byKey, knownSources)
}

/**
 * 工具输出里没有 title/snippet 时的**正文上下文兜底**（2026-10-18 引用返工）：
 * 找到正文里该 citation 的链接位置，截引用前后各 ~100 字、去掉 markdown 标记后作为
 * 「引用上下文」给 hover 卡。代码块/行内码里的引用不算（与 provenance 同口径）。
 *
 * 返回 citationKey → 上下文；同一 key 只取第一次出现。
 */
const CITATION_CONTEXT_RADIUS = 100
const CITATION_CONTEXT_CHARS = 140

function contextAroundLink(masked: string, start: number, end: number): string {
  const from = Math.max(0, start - CITATION_CONTEXT_RADIUS)
  const to = Math.min(masked.length, end + CITATION_CONTEXT_RADIUS)
  const window = masked.slice(from, to)
  const plain = window
    // 链接 / 图片整段去掉（上下文里不留引用序号/URL）；窗口可能从链接中间开始，截断括号一并清掉
    .replace(/!?\[[^\]]{0,160}\]\([^)]*\)/g, ' ')
    .replace(/!?\[[^\]]{0,160}\]/g, ' ')
    // 行内码 / 围栏残片
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
  if (plain === '') return ''
  const prefix = from > 0 ? '…' : ''
  const suffix = to < masked.length ? '…' : ''
  return `${prefix}${clipSnippet(plain, CITATION_CONTEXT_CHARS)}${suffix}`
}

export function citationContextsFromText(
  text: string,
  knownSources: KnownSources
): Map<string, string> {
  const contexts = new Map<string, string>()
  if (knownSources.size === 0 || text.trim() === '') return contexts
  const links = collectLinks(text)
  if (links.length === 0) return contexts
  const { masked } = prepareMarkdownText(text)
  for (const link of links) {
    const label = citationLabel(link.label)
    if (label === undefined) continue
    const url = safeHttpUrl(link.url)
    if (url === undefined) continue
    const key = citationKey(url)
    if (key === undefined || !knownSources.has(key) || contexts.has(key)) continue
    const context = contextAroundLink(masked, link.start, link.end)
    if (context === '') continue
    contexts.set(key, context)
    if (contexts.size >= MAX_SOURCES) break
  }
  return contexts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 工具输出的文本面：字符串 / 数组 / `{text|value|content|result}` 都认。
 * 只做"取文本"这一件事；解析结构化字段前先过它，避免为每种适配器写一套。
 */
function textOfToolOutput(output: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof output === 'string') return clipToolOutput(output)
  if (Array.isArray(output)) {
    const pieces: string[] = []
    for (const item of output) {
      const text = textOfToolOutput(item, depth + 1)
      if (text !== '') pieces.push(text)
      if (pieces.length >= MAX_HINTS) break
    }
    return clipToolOutput(pieces.join('\n'))
  }
  if (!isRecord(output)) return ''
  for (const key of ['text', 'value', 'content', 'result'] as const) {
    const value = output[key]
    if (typeof value === 'string') return clipToolOutput(value)
    if (Array.isArray(value) || isRecord(value)) {
      const text = textOfToolOutput(value, depth + 1)
      if (text !== '') return text
    }
  }
  return ''
}

function clipToolOutput(value: string): string {
  return value.length <= MAX_TOOL_OUTPUT_CHARS ? value : value.slice(0, MAX_TOOL_OUTPUT_CHARS)
}

function sourceRecord(value: unknown): WebSearchSource | null {
  if (!isRecord(value)) return null
  const url = safeHttpUrl(typeof value.url === 'string' ? value.url : '')
  if (url === undefined) return null
  const title = decodeHtmlEntities(typeof value.title === 'string' ? value.title : '').trim()
  const rawSnippet =
    typeof value.snippet === 'string'
      ? value.snippet
      : typeof value.content === 'string'
        ? value.content
        : typeof value.description === 'string'
          ? value.description
          : typeof value.highlights === 'string'
            ? value.highlights
            : Array.isArray(value.highlights)
              ? value.highlights
                  .filter((item): item is string => typeof item === 'string')
                  .join(' ')
              : ''
  return {
    title,
    url,
    snippet: clipSnippet(decodeHtmlEntities(rawSnippet))
  }
}

function sourcesFromRecords(records: readonly unknown[]): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  for (const record of records) {
    const source = sourceRecord(record)
    if (source !== null) sources.push(source)
    if (sources.length >= MAX_HINTS) break
  }
  return sources
}

/**
 * `formatSearchOutcome()` 的稳定文本形状：
 *
 *   联网搜索「query」（后端：…）
 *
 *   1. 标题
 *      URL: https://…
 *      发布: …
 *      摘要: …
 *
 * 只解析首行确实是联网搜索回执的文本；解析不出结构化结果时的后端原文不当结构化结果用。
 */
function sourcesFromSearchText(text: string): WebSearchSource[] {
  if (!text.trimStart().startsWith('联网搜索「')) return []
  const sources: WebSearchSource[] = []
  let current: { title: string; url: string; snippet: string[] } | null = null

  const flush = (): void => {
    if (current === null) return
    if (sources.length >= MAX_HINTS) {
      current = null
      return
    }
    const url = safeHttpUrl(current.url)
    if (url !== undefined) {
      sources.push({
        title: decodeHtmlEntities(current.title).trim(),
        url,
        snippet: clipSnippet(decodeHtmlEntities(current.snippet.join(' ')))
      })
    }
    current = null
  }

  for (const line of text.split(/\r?\n/)) {
    const item = /^\d+\.\s+(.*)$/.exec(line)
    if (item !== null) {
      flush()
      current = { title: item[1] ?? '', url: '', snippet: [] }
      continue
    }
    if (current === null) continue
    const urlLine = /^\s+URL:\s*(.*)$/.exec(line)
    if (urlLine !== null) {
      // 每个结果只认第一条 URL 行；摘要里再出现的 `URL:` 不覆盖真实结果地址
      if (current.url === '') current.url = (urlLine[1] ?? '').trim()
      continue
    }
    const snippetLine = /^\s+摘要:\s?(.*)$/.exec(line)
    if (snippetLine !== null) current.snippet.push((snippetLine[1] ?? '').trim())
  }
  flush()
  return sources
}

/**
 * 解析 web_search 的工具输出（字符串 / 结构化对象 / JSON 字符串 / content 包裹）。
 * 只返回安全 http(s) 的条目；解析不出结构化结果时返回空数组（不猜）。
 */
export function parseWebSearchSources(output: unknown): WebSearchSource[] {
  if (typeof output === 'string') {
    const trimmed = clipToolOutput(output).trim()
    if (trimmed === '') return []
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseWebSearchSources(JSON.parse(trimmed) as unknown)
      } catch {
        return []
      }
    }
    return sourcesFromSearchText(trimmed)
  }
  if (Array.isArray(output)) {
    const records = sourcesFromRecords(output)
    if (records.length > 0) return records
    const text = textOfToolOutput(output).trim()
    return text === '' ? [] : parseWebSearchSources(text)
  }
  if (!isRecord(output)) return []

  const hits = output.hits ?? output.results
  if (Array.isArray(hits)) return sourcesFromRecords(hits)

  const result = output.result
  if (result !== undefined && result !== output) {
    const parsed = parseWebSearchSources(result)
    if (parsed.length > 0) return parsed
  }

  const text = textOfToolOutput(output).trim()
  if (text === '') return []
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return parseWebSearchSources(JSON.parse(text) as unknown)
    } catch {
      return []
    }
  }
  return sourcesFromSearchText(text)
}

/** 工具 part 的最小读取面（静态 `tool-<name>` 与动态 `dynamic-tool` 都认） */
export interface CitationToolPartLike {
  type?: unknown
  toolName?: unknown
  state?: unknown
  input?: unknown
  output?: unknown
  errorText?: unknown
}

function isWebSearchPart(part: CitationToolPartLike): boolean {
  if (part.type === 'tool-web_search') return true
  return part.type === 'dynamic-tool' && part.toolName === 'web_search'
}

function isFetchPart(part: CitationToolPartLike): boolean {
  if (part.type === 'tool-fetch') return true
  return part.type === 'dynamic-tool' && part.toolName === 'fetch'
}

/**
 * fetch 的已知 URL：只从 `part.input.url` 与工具回执里的 `final-url:` 安全取。
 * 不从正文、标题或别的字段猜；`input-available` / `output-error` 不算已完成。
 */
function fetchResultUrls(part: CitationToolPartLike): string[] {
  const urls: string[] = []
  if (isRecord(part.input) && typeof part.input.url === 'string') urls.push(part.input.url)
  const output = textOfToolOutput(part.output)
  if (output !== '') {
    // 只看响应头（第一个空行之前）：正文里出现 `final-url:` 不能被当成工具的落点
    const separator = output.search(/\r?\n\r?\n/)
    const header = separator < 0 ? output : output.slice(0, separator)
    const finalUrl = /^[ \t]*final-url:[ \t]*(\S+)[ \t]*$/gim
    for (let match = finalUrl.exec(header); match !== null; match = finalUrl.exec(header)) {
      const url = match[1]
      if (url !== undefined) urls.push(url)
    }
  }
  return urls
}

/** fetch 回执里能展示给 hover 卡的信息（2026-10-18 引用返工：fetch 不再只授权 URL） */
export interface FetchSourceHint {
  title?: string
  snippet?: string
}

const FETCH_TITLE_CHARS = 120

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed !== '') return trimmed
  }
  return undefined
}

function cleanInlineHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** HTML 正文 → 可见文本（去 script/style/noscript/svg 与标签，保留段落空格） */
function htmlToVisibleText(html: string): string {
  return cleanInlineHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, ' ')
  )
}

/** Jina reader / 纯文本：去掉 reader 头部与 markdown 标记，只留可读正文 */
function cleanReaderBody(body: string): string {
  const marker = /^[ \t]*Markdown Content:[ \t]*$/im.exec(body)
  const content = marker === null ? body : body.slice(marker.index + marker[0].length)
  return content
    .replace(/^[ \t]*(?:Title|URL Source|Published Time|Warning):[^\n]*$/gim, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]{0,160})\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析 fetch 回执的可展示信息（页面标题 + 摘要）。
 *
 * 回执形状（`readResponseText`）：`HTTP 200` / `content-type: …` / 可选 `final-url: …`，
 * 空行之后是正文。正文可能是：
 *   - 原始 HTML：`<title>` / og:title / `<h1>` 取标题；meta description → 首个 `<p>` → 全文可见文本
 *     依次兜底（优先描述，避免把导航/面包屑当摘要）；
 *   - reader 模式（Jina Markdown）：`Title: …` / `Published Time: …` / `Markdown Content:`，
 *     取 `Title:` 行，摘要用 Markdown Content 之后的正文；
 *   - 纯文本：标题缺失就不编（`title` 不返回），摘要截正文。
 * 解析不出任何可读内容时返回空对象（不猜）。
 */
export function parseFetchSource(output: unknown): FetchSourceHint {
  const text = textOfToolOutput(output)
  if (text.trim() === '') return {}
  const separator = text.search(/\r?\n\r?\n/)
  const body = (separator < 0 ? '' : text.slice(separator)).replace(/^\r?\n\r?\n/, '')
  if (body.trim() === '') return {}

  const looksHtml = /<\s*(?:!doctype\s+html|html|head|body|title|meta|article)\b/i.test(body)
  let rawTitle = ''
  let rawSnippet = ''

  if (looksHtml) {
    const metaTitle =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ??
      /<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']*)["']/i.exec(
        body
      )?.[1] ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] ??
      ''
    rawTitle = cleanInlineHtml(metaTitle)
    const description =
      /<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*content=["']([^"']*)["']/i.exec(
        body
      )?.[1] ?? ''
    const firstParagraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1] ?? ''
    rawSnippet =
      firstNonEmpty(
        cleanInlineHtml(description),
        cleanInlineHtml(firstParagraph),
        htmlToVisibleText(body)
      ) ?? ''
  } else {
    const head = body.slice(0, 4_000)
    rawTitle =
      firstNonEmpty(
        /^[ \t]*Title:[ \t]*(.+)$/im.exec(head)?.[1]?.trim(),
        /^[ \t]{0,3}#[ \t]+(.+)$/m.exec(head)?.[1]?.trim()
      ) ?? ''
    rawSnippet = cleanReaderBody(body)
  }

  const title = cleanInlineHtml(rawTitle)
  const snippet = rawSnippet.replace(/\s+/g, ' ').trim()
  return {
    ...(title === '' ? {} : { title: clipSnippet(title, FETCH_TITLE_CHARS) }),
    ...(snippet === '' ? {} : { snippet: clipSnippet(snippet) })
  }
}

function addKnownSource(
  known: Map<string, CitationHint>,
  rawUrl: string,
  title?: string,
  snippet?: string
): void {
  const url = safeHttpUrl(rawUrl)
  if (url === undefined) return
  const key = citationKey(url)
  if (key === undefined) return

  const cleanTitle = title?.trim()
  const cleanSnippet = snippet?.trim()
  const existing = known.get(key)
  if (existing === undefined) {
    if (known.size >= MAX_HINTS) return
    known.set(key, {
      ...(cleanTitle === undefined || cleanTitle === '' ? {} : { title: cleanTitle }),
      ...(cleanSnippet === undefined || cleanSnippet === '' ? {} : { snippet: cleanSnippet })
    })
    return
  }
  if (existing.title === undefined && cleanTitle !== undefined && cleanTitle !== '') {
    existing.title = cleanTitle
  }
  if (existing.snippet === undefined && cleanSnippet !== undefined && cleanSnippet !== '') {
    existing.snippet = cleanSnippet
  }
}

/**
 * 从一组工具 part 建 **provenance allowlist**：citationKey → 可选 title/snippet。
 *
 * 只认已完成的 web_search（结构化结果）与 fetch（`input.url` / `final-url:`）。
 * 与旧版 `citationHintsFromParts` 的关键区别：**没有 title/snippet 的 URL 也会进 map**
 * —— 它不需要展示信息，但必须能授权正文引用。工具输出本身仍然不会变成来源。
 */
export function knownSourcesFromParts(
  parts: readonly CitationToolPartLike[]
): Map<string, CitationHint> {
  const known = new Map<string, CitationHint>()
  for (const part of parts) {
    if (part.state !== 'output-available') continue
    if (isWebSearchPart(part)) {
      for (const source of parseWebSearchSources(part.output)) {
        addKnownSource(known, source.url, source.title, source.snippet)
        if (known.size >= MAX_HINTS) return known
      }
      continue
    }
    if (isFetchPart(part)) {
      // 2026-10-18 引用返工：fetch 回执也解析 title/snippet（HTML title/meta、reader Title、
      // 正文干净摘要），否则 hover 卡只剩 URL；解析不出就只授权、由正文上下文兜底。
      const info = parseFetchSource(part.output)
      for (const url of fetchResultUrls(part)) {
        addKnownSource(known, url, info.title, info.snippet)
        if (known.size >= MAX_HINTS) return known
      }
    }
  }
  return known
}

const KNOWN_SOURCES_CACHE = new WeakMap<object, Map<string, CitationHint>>()

/**
 * 同 `parts` 数组身份复用 allowlist。
 *
 * React 的不可变更新口径下，流式 delta 只会换当前消息的 parts 数组；历史消息的 parts
 * 身份不变。缓存让历史轮不随每个 delta 重扫工具输出，也让 TextPart 的 context 值保持稳定。
 * 如果调用方原地改同一个 parts 数组（违反不变式），缓存会与 React 的 useMemo 一样过期。
 */
export function knownSourcesOfParts(
  parts: readonly CitationToolPartLike[]
): Map<string, CitationHint> {
  const cached = KNOWN_SOURCES_CACHE.get(parts)
  if (cached !== undefined) return cached
  const next = knownSourcesFromParts(parts)
  KNOWN_SOURCES_CACHE.set(parts, next)
  return next
}

/** 合并多份 allowlist（同一 key 的 title/snippet 只补空位，不覆盖已有值） */
export function mergeKnownSources(target: Map<string, CitationHint>, source: KnownSources): void {
  for (const [key, hint] of source) {
    const existing = target.get(key)
    if (existing === undefined) {
      if (target.size >= MAX_HINTS) return
      target.set(key, { ...hint })
      continue
    }
    if (existing.title === undefined && hint.title !== undefined) existing.title = hint.title
    if (existing.snippet === undefined && hint.snippet !== undefined) {
      existing.snippet = hint.snippet
    }
  }
}
