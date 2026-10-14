/**
 * PPT 版式**预算引擎**（round 77）：把"这一页排不排得下"从散文约定变成**确定性量测**。
 *
 * 为什么非要有它（实测，真实产物与页图见 `.superpowers/ppt-layout-fix/`）：
 *   - `fit:'shrink'` 是**空操作**：pptxgenjs 只写裸 `<a:normAutofit/>`（库自己的注释就写着
 *     "Shrink does not work automatically"），缩放值得 PowerPoint 打开后按需算 —— 而
 *     "生成 → 导出页图"这条路上没人算过，于是全尺寸硬排、直接溢出画布。
 *   - 各版式写死的框高（正文 3.35in、分栏卡 3.05in、表格行高 0.4in）与 schema 宣传的输入上界
 *     （30 条 × 500 字）没有任何换算关系：排不下的页只能靠肉眼看页图发现。
 *
 * 本模块的口径（全部**纯函数**：无 IO、不依赖 pptxgenjs、不 import ppt.ts）：
 *   - **量测模型**（用真实页图的换行点标定）：行高 = 字号 × 1.2 × 行距倍数；CJK/全角 1.0em、
 *     ASCII 0.54em（粗体 0.6em）、空格 0.4em；断行只在 CJK 边界 / 空格后 / 连字符后（无分隔符的
 *     ASCII 串 —— 典型是长 URL —— 整块不劈开，放不下就整个挪到下一行）。
 *     标定结果（`render-kyclaw-final` 的 8 张页图）：正文 24 个对照点里 21 个逐字一致，其余 3 个比
 *     PowerPoint **早断一个字符**（方向保守，宁可多算一行）；7 个真实页面标题的行数**全部对上**
 *     （1 行的 1 行、2 行的 2 行 —— 靠粗体那一档系数）。
 *   - **可用高度**：正文 / 卡片 / 表格一律止于 `FRAME.contentBottom`（页脚细线之上再留 0.16in），
 *     并把文本框内边距算进去（pptxgenjs 不写 `lIns/rIns`，PowerPoint 用的就是 OOXML 默认的
 *     0.1in / 0.05in —— 与真实页图上量到的文字左右边界一致）：量测宽度一律 = 文本框宽 − 0.2in。
 *   - **固定框**（封面标题 / 副标题、章节页的引导语与章标题、结尾页那句话）单算：它们各自占了
 *     设计给的一块（见 `SECTION_FRAME` / `CLOSING_FRAME` / `CENTER_COVER_FRAME`），可用高就是
 *     框高本身，**没有字号阶梯** —— 放不下直接 `report`（缩它们等于改封面层级，宁可让调用方改短）。
 *   - **字号阶梯有下限**：逐档试，第一档排得下就用它（`ok` / `shrunk`）；到下限仍排不下 →
 *     `report`：由调用方**拒绝这次输入**（不落盘），回人话点名第几页、差多少、怎么改
 *     （拆页 / 减字），绝不静默出一份明显溢出的稿子。
 *   - **不量**两个不由输入决定的块：内容全空时那张占位页的文案（工具自己写的常量），
 *     以及章节页的序号（自动生成，两位数字放得进 2.2in 的框）。其余所有页都量。
 *
 * 不复用它来实现的两件事（刻意）：
 *   - **不插零宽断点（U+200B）软化长链接**：`artifact-check` 的 `hits()` 是精确 `includes`，
 *     插了就会让模型的 `expect.contains` 对原样 URL 误报"找不到"，而 URL 的语义也不该被改。
 *     改行只做**保守计量**（长 token 整块算一行宽）。
 *   - **固定框里的文字不缩字号**：见上 —— 封面 / 章节 / 结尾的框是设计给死的，缩字号会改掉
 *     封面与章节页的层级；放不下就拒绝，让调用方把那句话改短。
 */

/** 八种版式（`layout` 取值）。定义在这里：预算引擎按版式给阶梯，而 ppt.ts 反向依赖它 */
export const PPT_LAYOUTS = [
  'cover',
  'section',
  'content',
  'stats',
  'table',
  'two-column',
  'quote',
  'closing'
] as const

export type PptLayout = (typeof PPT_LAYOUTS)[number]

/**
 * 页面栅格（英寸）——**生成侧与测试共用的唯一真相源**。
 * `contentBottom` 是"内容不许越过的那条线"：细线在 `hairlineY`，两者相差
 * `FOOTER_CLEARANCE`（0.16in ≈ 11.5pt），即正文最后一行的行盒下沿离细线还有 0.16in。
 */
export const FRAME = {
  x: 0.6,
  w: 8.8,
  titleY: 0.4,
  /** 单行标题的框高（沿用原设计：26pt 一行居中） */
  titleSingleH: 0.72,
  /** 标题下 accent 短线的 y（单行标题；两行标题由 titleLayout 往下推） */
  ruleY: 1.18,
  ruleW: 1.0,
  ruleH: 0.06,
  /** 正文顶（单行标题；两行标题由 titleLayout 往下推） */
  bodyY: 1.5,
  /** 页脚细线 */
  hairlineY: 5.02,
  footerY: 5.08,
  footerH: 0.3,
  /** 内容底：正文 / 卡片 / 表格一律止步于此（见 FOOTER_CLEARANCE） */
  contentBottom: 4.86
} as const

/** 内容底与页脚细线之间的安全距离（英寸） */
export const FOOTER_CLEARANCE = FRAME.hairlineY - FRAME.contentBottom

/**
 * 文本框内边距（英寸）。pptxgenjs 不写 `lIns/rIns/tIns/bIns`，PowerPoint 就按 OOXML 的默认值
 * 渲染（0.1 / 0.05）——真实页图上文字左右边界正是 0.7in / 9.3in，故量测必须扣掉它。
 */
export const TEXT_INSET = { x: 0.1, y: 0.05 } as const

/** 表格单元格内边距（英寸）：pptxgenjs 的 `marL/marR = 0.1`、`marT/marB = 0.05` */
export const CELL_INSET_X = 0.1
export const CELL_PAD_Y = 0.1

/** 行高系数：单倍行距 = 字号 × 1.2（真实页图反解：15pt @1.25 → 0.3125in 行距） */
export const LINE_FACTOR = 1.2
/**
 * 字符宽度（em）：ASCII 0.54（非粗体，标定值）、空格 0.4、CJK/全角 1.0。
 * **粗体另算**（0.6）：CJK 粗体字宽不变，但拉丁字母/数字在粗体下确实更宽 —— 页面标题就是粗体，
 * 用非粗体的系数量会把本来两行的标题算成一行（真实页 4/5/6 的标题正是这样被规则线穿过的那几页）。
 */
export const ASCII_EM = 0.54
export const ASCII_BOLD_EM = 0.6
export const SPACE_EM = 0.4
const WIDE_EM = 1
const FALLBACK_EM = 0.9

/** 量测的写法选项（只有粗细会影响宽度） */
export interface MeasureOptions {
  /** 粗体文本（页面标题 / 分栏小标题 / 数字卡数值 / 表头） */
  bold?: boolean
}

/** 不能出现在行首的收尾标点（避头尾：断了就把它拉回上一行） */
const NO_LINE_START = new Set('，。；：、！？）】》」』’”%…·,.;:!?)]}>')

/** 这个字符是不是全角/CJK（宽度按 1em 算） */
export function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首扩展 + 汉字
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x2018 && code <= 0x201d) || // 弯引号
    code === 0x2014 || // —
    code === 0x2026 // …
  )
}

/** 一个字符占几个 em */
export function charWidthEm(char: string, options: MeasureOptions = {}): number {
  if (char === ' ') return SPACE_EM
  if (isWideChar(char)) return WIDE_EM
  if ((char.codePointAt(0) ?? 0) >= 0x2500) return FALLBACK_EM
  return options.bold === true ? ASCII_BOLD_EM : ASCII_EM
}

/** 一段文本的宽度（em） */
export function textWidthEm(text: string, options: MeasureOptions = {}): number {
  let total = 0
  for (const char of text) total += charWidthEm(char, options)
  return total
}

/** 两个字符之间能不能断行 */
function canBreak(prev: string, next: string): boolean {
  return prev === ' ' || prev === '-' || isWideChar(prev) || next === ' ' || isWideChar(next)
}

/**
 * 按 PowerPoint 的断行口径把文本切成行（宽度单位：英寸）：
 * 断点 = CJK 字符之间 / 空格后 / 连字符后；一段 ASCII（无空格无连字符）是**不可断的整块**，
 * 放不下就整个挪到下一行 —— 这正是真实页图上长 URL 的行为（`…/saudi-` 后断，而不是任意处断）。
 */
export function wrapText(
  text: string,
  widthIn: number,
  fontSize: number,
  options: MeasureOptions = {}
): string[] {
  const chars = Array.from(text)
  const limit = widthIn * 72
  const lines: string[] = []
  let index = 0

  while (index < chars.length) {
    let line = ''
    let used = 0
    while (index < chars.length) {
      const cost = charWidthEm(chars[index], options) * fontSize
      if (line !== '' && used + cost > limit) break
      line += chars[index]
      used += cost
      index += 1
    }

    if (index < chars.length) {
      // 回退到本行最后一个合法断点：不可断的 ASCII 串不许被劈开
      let cut = -1
      for (let at = 0; at < line.length; at += 1) {
        const next = at + 1 < line.length ? line[at + 1] : chars[index]
        if (canBreak(line[at], next)) cut = at
      }
      if (cut >= 0 && cut + 1 < line.length) {
        index -= line.length - (cut + 1)
        line = line.slice(0, cut + 1)
      }
    }

    // 避头尾：收尾标点不落在行首（拉回本行；最多拉 3 个，避免病态输入死循环）
    let pulled = 0
    while (index < chars.length && NO_LINE_START.has(chars[index]) && pulled < 3) {
      line += chars[index]
      index += 1
      pulled += 1
    }

    lines.push(line)
  }

  return lines
}

/** 一段文本占几行 */
export function lineCount(
  text: string,
  widthIn: number,
  fontSize: number,
  options: MeasureOptions = {}
): number {
  if (text === '') return 1
  return wrapText(text, widthIn, fontSize, options).length
}

/** 要点的圆点前缀（`●` + 一个空格）占的宽度（英寸）：● 的 run 字号 = 0.7 × 正文 */
export function bulletPrefixIn(fontSize: number): number {
  return ((0.7 + SPACE_EM) * fontSize) / 72
}

/**
 * 一条要点占几行：**第一行**让开 `● ` 前缀，续行用整宽
 * （真实页图上续行就从文本框左内边距开始，没有再缩进）。
 */
export function bulletLineCount(text: string, widthIn: number, fontSize: number): number {
  const first = wrapText(text, widthIn - bulletPrefixIn(fontSize), fontSize)
  if (first.length <= 1) return 1
  return 1 + lineCount(first.slice(1).join(''), widthIn, fontSize)
}

/** 行高（英寸）：字号 × 1.2 × 行距倍数 */
export function lineHeightIn(fontSize: number, spacing = 1): number {
  return (fontSize * LINE_FACTOR * spacing) / 72
}

/** 段后距（pt）：随字号缩放（15pt → 10pt，与原来写死的那个值一致） */
export function paraSpaceAfterPt(fontSize: number): number {
  return Math.round(fontSize * 0.65)
}

export interface BlockMetrics {
  /** 总行数 */
  lines: number
  /** 文本总高（英寸）：Σ(行 × 行高) + 段数 × 段后距（PowerPoint 把末段的段后距也算进高度） */
  heightIn: number
  lineHeightIn: number
  spaceAfterPt: number
}

/** 一组段落的总高：给每段的行数、字号与行距 */
export function blockMetrics(
  lineCounts: readonly number[],
  fontSize: number,
  spacing = 1
): BlockMetrics {
  const lines = lineCounts.reduce((sum, count) => sum + count, 0)
  const height = lineHeightIn(fontSize, spacing)
  const after = paraSpaceAfterPt(fontSize)
  return {
    lines,
    heightIn: lines * height + lineCounts.length * (after / 72),
    lineHeightIn: height,
    spaceAfterPt: after
  }
}

/**
 * **各占一块**的几段文本里，最差的那一块有多高（数字卡的数值/标签、分栏小标题：
 * 每张卡 / 每一栏各一个盒子，不能按"堆在一起"求和 —— 求和会把 6 张短标签算成溢出）。
 */
function worstBlockIn(
  texts: readonly string[],
  widthIn: number,
  fontSize: number,
  spacing = 1,
  options: MeasureOptions = {}
): number {
  let worst = 0
  for (const text of texts) {
    const { heightIn } = blockMetrics(
      [lineCount(text, widthIn, fontSize, options)],
      fontSize,
      spacing
    )
    if (heightIn > worst) worst = heightIn
  }
  return worst
}

/** 字号阶梯：每档的**最后一格就是可读下限**（低于它宁可拒绝这一页）；固定框（封面 / 章节 / 结尾）不走阶梯 */
export const FIT_LADDER = {
  /** 页面标题（最多两行，见 MAX_TITLE_LINES） */
  title: [26, 23, 20],
  /** 正文要点 */
  content: [15, 14, 13, 12, 11],
  /** 分栏卡片里的要点 */
  'two-column': [13, 12, 11, 10],
  /** 分栏卡片的小标题（栏宽固定，长的缩字号；一行放不下两行也放不下就报） */
  'two-column-title': [15, 14, 13, 12],
  /** 表格正文 */
  table: [12, 11, 10],
  /** 数字卡的数值 / 标签 */
  statsValue: [30, 26, 22],
  statsLabel: [12, 11, 10],
  /** 引言正文 */
  quote: [24, 22, 20, 18, 16]
} as const

export type FitLadderKind = keyof typeof FIT_LADDER

/** 可读下限 = 该档阶梯的最后一格 */
export function ladderFloor(kind: FitLadderKind): number {
  const sizes = FIT_LADDER[kind]
  return sizes[sizes.length - 1]
}

/** 表格行高的设计值（内容更少时也不会比它矮 —— 与旧口径 0.4in 一致） */
export const MIN_TABLE_ROW_H = 0.4
/** 标题最多两行；超过就缩标题字号，仍超两行则报给调用方拒绝 */
export const MAX_TITLE_LINES = 2
/** 标题框与下方短线的间距（英寸） */
const TITLE_GAP_BELOW = 0.12
/** 短线之下，内容顶的**下限留白**（各版式还会与自己的设计位取 max，故单行标题时内容顶照旧） */
const TITLE_BREATH = 0.11

export type FitAction = 'ok' | 'shrunk' | 'report'

export interface FitVerdict {
  /** 这一页实际用的字号（`report` 时 = 下限字号） */
  fontSize: number
  /** 量测出的内容高（英寸） */
  measuredIn: number
  /** 这一页给内容留的高（英寸，已扣内边距） */
  availableIn: number
  /** 比可用区高多少（> 0 = 连下限字号都排不下） */
  overflowIn: number
  action: FitAction
}

/**
 * 逐档试字号：第一档排得下就用它（第一档 = `ok`，往后 = `shrunk`）；
 * 到下限仍排不下 → 用下限字号 + `action:'report'`（调用方据此拒绝这次输入）。
 * `measure(size)` 回这一档字号下内容要多高（英寸）。
 */
export function fitLadder(
  sizes: readonly number[],
  availableIn: number,
  measure: (fontSize: number) => number
): FitVerdict {
  for (let index = 0; index < sizes.length; index += 1) {
    const fontSize = sizes[index]
    const measuredIn = measure(fontSize)
    if (measuredIn <= availableIn) {
      return {
        fontSize,
        measuredIn,
        availableIn,
        overflowIn: 0,
        action: index === 0 ? 'ok' : 'shrunk'
      }
    }
  }
  const fontSize = sizes[sizes.length - 1]
  const measuredIn = measure(fontSize)
  return {
    fontSize,
    measuredIn,
    availableIn,
    overflowIn: measuredIn - availableIn,
    action: 'report'
  }
}

/** 标题块的排版结论：字号 / 行数 / 框高 / 短线 y / 短线之下内容的起步下限 */
export interface TitleLayout {
  hasTitle: boolean
  fontSize: number
  lines: number
  /** 标题框高（单行沿用 0.72；两行按实测行数给足） */
  boxH: number
  /** 标题短线的 y（单行 = FRAME.ruleY；两行及以上落在标题框之下） */
  ruleY: number
  /** 短线之下内容**至少要**从这里起步（各版式还会与自己的设计位取 max，见 contentTop） */
  contentStart: number
  action: FitAction
  /**
   * 标题这一项的量测：可用高 = 两行（`MAX_TITLE_LINES`）在该字号下的高度，
   * 故 `overflowIn > 0` 就是"排不进两行"；`report` 的判定与报错的字号都看它。
   */
  fit: FitVerdict
}

/**
 * 标题块：**最多两行**。26pt 一行放不下就试 23 / 20pt；两行以内取**最大**的那个字号，
 * 于是两行标题保持 26pt 的层级，而规则线与内容顶按**实际行数**整体下移（不再被线穿过）。
 * 连 20pt 都排不进两行 → `action:'report'`（调用方拒绝：标题该精简）。
 */
export function titleLayout(title: string | undefined): TitleLayout {
  const text = title?.trim() ?? ''
  if (text === '') {
    return {
      hasTitle: false,
      fontSize: FIT_LADDER.title[0],
      lines: 0,
      boxH: 0,
      ruleY: FRAME.ruleY,
      contentStart: FRAME.ruleY + FRAME.ruleH + TITLE_BREATH,
      action: 'ok',
      fit: {
        fontSize: FIT_LADDER.title[0],
        measuredIn: 0,
        availableIn: 0,
        overflowIn: 0,
        action: 'ok'
      }
    }
  }

  const width = FRAME.w - TEXT_INSET.x * 2
  const sizes = FIT_LADDER.title
  // 标题是**粗体**：拉丁字母/数字按粗体宽度量，否则两行标题会被算成一行（真实页 4/5/6 就是这样）
  const bold: MeasureOptions = { bold: true }
  let fontSize: number = sizes[0]
  let lines = lineCount(text, width, fontSize, bold)
  let action: FitAction = 'ok'
  if (lines > MAX_TITLE_LINES) {
    for (const size of sizes) {
      fontSize = size
      lines = lineCount(text, width, size, bold)
      if (lines <= MAX_TITLE_LINES) break
    }
    action = lines <= MAX_TITLE_LINES ? 'shrunk' : 'report'
  }

  const boxH = lines <= 1 ? FRAME.titleSingleH : lines * lineHeightIn(fontSize) + 0.14
  const ruleY = lines <= 1 ? FRAME.ruleY : FRAME.titleY + boxH + TITLE_GAP_BELOW
  const lineHeight = lineHeightIn(fontSize)
  return {
    hasTitle: true,
    fontSize,
    lines,
    boxH,
    ruleY,
    contentStart: ruleY + FRAME.ruleH + TITLE_BREATH,
    action,
    fit: {
      fontSize,
      measuredIn: lines * lineHeight,
      availableIn: MAX_TITLE_LINES * lineHeight,
      overflowIn: Math.max(0, lines - MAX_TITLE_LINES) * lineHeight,
      action
    }
  }
}

/** 设计给死的一块文本框（英寸 / pt）：封面标题与副标题、章节页的引导语与章标题、结尾页那句话 */
export interface BoxText {
  /** 文本框宽（英寸） */
  w: number
  /** 文本框高（英寸）—— 设计留给它的整块，文字不缩字号，放不下就报 */
  h: number
  /** 设计字号（pt） */
  size: number
}

/**
 * 量一段放在**固定框**里的文字：字高 = 行数 × 行高，可用高 = 框高（不扣上下内边距 ——
 * 这几个框的高就是设计给它的那一块，没有内容底那条线要留），宽度仍扣左右内边距（与渲染一致）。
 * **没有字号阶梯**：放不下就 `report`，由调用方拒绝（缩封面 / 章节字号会改掉整份的层级）。
 */
export function boxTextPlan(
  text: string | undefined,
  box: BoxText,
  options: MeasureOptions = {}
): FitVerdict & { lines: number } {
  const body = text?.trim() ?? ''
  const lines = body === '' ? 0 : lineCount(body, box.w - TEXT_INSET.x * 2, box.size, options)
  const lineHeight = lineHeightIn(box.size)
  const measuredIn = lines * lineHeight
  return {
    fontSize: box.size,
    measuredIn,
    availableIn: box.h,
    overflowIn: Math.max(0, measuredIn - box.h),
    action: measuredIn <= box.h ? 'ok' : 'report',
    lines
  }
}

/**
 * 章节页的固定几何（英寸 / pt）—— **画（ppt.ts 的 drawSection）与量共用这一份**。
 * 序号是自动生成的（最多两位数字），框宽 2.2in 一定放得下，故不量。
 */
export const SECTION_FRAME = {
  /** 可选的那句引导语（= 这一页的 `title`） */
  kicker: { x: 0.75, y: 0.72, w: 8.4, h: 0.4, size: 13 },
  /** 自动序号 */
  index: { x: 0.72, y: 1.15, w: 2.2, h: 1.3, size: 64 },
  /** 章标题（= `section`） */
  name: { x: 0.75, y: 2.5, w: 8.4, h: 0.85, size: 32 },
  rule: { x: 0.78, y: 3.55, w: 1.2 }
} as const

/** 结尾页的固定几何（画与量共用）：一句话 + 短线 */
export const CLOSING_FRAME = {
  text: { x: 1.2, y: 2.25, w: 7.6, h: 1.0, size: 36 },
  rule: { x: 4.5, y: 3.42, w: 1.0 }
} as const

/**
 * 封面那两个固定框（画与量共用）：`renderPptx` 按当前模板的 `coverPlan` 传进来
 * （十个模板里有两种构图，band 封面的标题块窄 0.8in —— 见 shared/ppt-templates）。
 */
export interface CoverFrame {
  title: BoxText
  subtitle: BoxText
}

/**
 * 默认的封面框 = `shared/ppt-templates` 里**居中封面**那份（宽 8.4in）。
 * `renderPptx` 一律显式传当前模板的框，这份只是给直接调 `fitPage` 的人一个不炸的默认值；
 * 两者是否还一致由 `ppt-fit.spec.ts` 钉着（拿真实的 coverPlan 比一遍）。
 */
export const CENTER_COVER_FRAME: CoverFrame = {
  title: { w: 8.4, h: 1.35, size: 40 },
  subtitle: { w: 8.4, h: 0.6, size: 18 }
}

/** 一页里被量测的那块内容（正文 / 分栏 / 表格 / 数字卡 / 引言）的落位与结论 */
export interface PlacedFit extends FitVerdict {
  /** 文本块顶（英寸） */
  y: number
  /** 文本块宽（英寸） */
  w: number
  /** 文本块高（英寸）：盒子底就是 FRAME.contentBottom */
  h: number
  lines: number
}

export interface FitStat {
  value: string
  label: string
}

export interface FitColumn {
  title?: string
  bullets?: readonly string[]
}

export interface FitTable {
  headers?: readonly string[]
  rows: readonly (readonly string[])[]
}

export interface FitQuote {
  text: string
  source?: string
}

/** 各版式**没有标题**时内容区顶（沿用原设计的偏移，与量测改字号无关） */
const NO_TITLE_TOP = {
  content: 1.25,
  'two-column': 1.3,
  stats: 1.3,
  table: 1.3,
  quote: 1.5
} as const

/** 各版式**有标题**时，内容区顶相对正文顶的再下移量（沿用原设计的偏移） */
const TITLE_TOP_GAP = {
  content: 0,
  'two-column': 0.2,
  stats: 0.35,
  table: 0.2,
  quote: 0.3
} as const

type GappedLayout = keyof typeof NO_TITLE_TOP

/**
 * 内容区顶（英寸）：**设计位**与**标题让位下限**取 max。
 *   - 设计位 = 单行标题时的偏移（`FRAME.bodyY + GAP`）—— 单行标题的框高 / 短线 / 正文顶 / 页脚
 *     仍是原设计那几处坐标（量测只决定**字号**，不动几何）；
 *   - 让位下限 = 标题短线之下再留 `TITLE_BREATH`（标题占两行时它才会超过设计位）。
 * 于是：单行标题的几何照旧；两行标题只有"正文要点页"被顶下来（表格 / 分栏 / 数字卡 / 引言的设计位
 * 本来就在短线之下，不会白白再让一截）。
 */
function contentTop(layout: GappedLayout, title: TitleLayout): number {
  if (!title.hasTitle) return NO_TITLE_TOP[layout]
  return Math.max(FRAME.bodyY + TITLE_TOP_GAP[layout], title.contentStart)
}

/**
 * 正文要点页：可用高 = contentBottom − 正文顶 − 上下内边距；
 * 逐档量"每条要点几行 × 行高 + 段后距"。量测宽度扣掉文本框左右内边距（与渲染一致）。
 */
export function contentPlan(bullets: readonly string[], title: TitleLayout): PlacedFit {
  const y = contentTop('content', title)
  const h = FRAME.contentBottom - y
  const availableIn = h - TEXT_INSET.y * 2
  const textW = FRAME.w - TEXT_INSET.x * 2
  const metricsAt = (fontSize: number): BlockMetrics =>
    blockMetrics(
      bullets.map((text) => bulletLineCount(text, textW, fontSize)),
      fontSize,
      1.25
    )

  let metrics = metricsAt(FIT_LADDER.content[0])
  const verdict = fitLadder(FIT_LADDER.content, availableIn, (size) => {
    metrics = metricsAt(size)
    return metrics.heightIn
  })
  return { ...verdict, y, w: FRAME.w, h, lines: metrics.lines }
}

export interface TwoColumnPlan {
  /** 栏内要点的字号结论 */
  verdict: FitVerdict
  /** 栏内小标题的字号结论 */
  heading: FitVerdict
  /** 卡片顶 / 卡片高（卡片底 = contentBottom） */
  top: number
  height: number
  colW: number
  gap: number
  /** 要点块（每一栏的 x 由调用方按 colW/gap 算） */
  bulletsY: number
  bulletsW: number
  /** 单栏可用高（已扣内边距） */
  availableIn: number
  lines: number
}

/** 分栏小标题的框高（英寸）：卡内标题那一行的设计值 */
export const TWO_COLUMN_HEADING_H = 0.5

/** 每一栏里要点框的左右缩进（英寸）：卡片内边距 0.25 + 竖条让位 0.2（渲染侧同一处算式） */
export const TWO_COLUMN_INSET = 0.45

/**
 * 左右分栏：**只取前两栏**（渲染侧就是 `slice(0, 2)`），每栏的要点先 trim / 去空，
 * 两栏各量一次取**最差**的那栏当结论（两栏都得排得下）。量测宽度 = 栏内文本框宽 − 左右内边距。
 */
export function twoColumnPlan(columns: readonly FitColumn[], title: TitleLayout): TwoColumnPlan {
  const gap = 0.5
  const colW = (FRAME.w - gap) / 2
  const top = contentTop('two-column', title)
  const height = FRAME.contentBottom - top
  const innerW = colW - TWO_COLUMN_INSET
  const textW = innerW - TEXT_INSET.x * 2
  const cols = columns.slice(0, 2).map((column) => ({
    title: column.title?.trim() ?? '',
    bullets: cleanList(column.bullets)
  }))
  const hasHeading = cols.some((column) => column.title !== '')
  const bulletsY = top + (hasHeading ? 0.75 : 0.2)
  const availableIn = FRAME.contentBottom - bulletsY - TEXT_INSET.y * 2

  const metricsAt = (fontSize: number): BlockMetrics => {
    const perColumn = cols.map((column) =>
      blockMetrics(
        column.bullets.map((text) => bulletLineCount(text, textW, fontSize)),
        fontSize,
        1.25
      )
    )
    return perColumn.reduce(
      (worstSoFar, current) => (current.heightIn > worstSoFar.heightIn ? current : worstSoFar),
      blockMetrics([], fontSize, 1.25)
    )
  }

  let metrics = metricsAt(FIT_LADDER['two-column'][0])
  const verdict = fitLadder(FIT_LADDER['two-column'], availableIn, (size) => {
    metrics = metricsAt(size)
    return metrics.heightIn
  })

  // 小标题：栏宽固定（colW − 0.45），框高 0.5；长的缩字号，两行也塞不下就由调用方拒绝
  const headings = cols.map((column) => column.title).filter((heading) => heading !== '')
  const headingW = innerW - TEXT_INSET.x * 2
  const headingTest = fitLadder(
    FIT_LADDER['two-column-title'],
    TWO_COLUMN_HEADING_H - TEXT_INSET.y * 2,
    (size) => worstBlockIn(headings, headingW, size, 1, { bold: true })
  )

  return {
    verdict,
    heading: headingTest,
    top,
    height,
    colW,
    gap,
    bulletsY,
    bulletsW: innerW,
    availableIn,
    lines: metrics.lines
  }
}

export interface TablePlan {
  /** 表格顶（英寸） */
  y: number
  /** 每一行的高度（英寸，≥ MIN_TABLE_ROW_H）——直接写进 `<a:tr h>`，声明即所得 */
  rowH: number[]
  /** 声明总高（Σ rowH）：同时用作表格框的 h，让 `graphicFrame` 的 ext 与真实几何一致 */
  height: number
  fontSize: number
  lines: number
  cols: number
  measuredIn: number
  availableIn: number
  overflowIn: number
  action: FitAction
}

/**
 * 表格：逐行量"这一行最高的那个单元格几行" → 行高 = max(0.4, 行数 × 行高 + 上下内边距)。
 * 行高**按行给**（pptxgenjs 支持 `rowH` 数组），于是声明出来的表高就是渲染出来的表高
 * （旧代码给死 0.4，PowerPoint 渲染时把放不下的行撑高，超出多少工具层完全不知情）。
 *
 * 表头只在**给了非空 `headers`** 时才算一行（渲染侧也是 `headers.length > 0` 才画它）：
 * 空数组既不多算一行、也不把第一条数据行当粗体表头量。
 */
export function tablePlan(table: FitTable, title: TitleLayout): TablePlan {
  const headers = table.headers ?? []
  const hasHeaders = headers.length > 0
  const rows: readonly (readonly string[])[] = hasHeaders ? [headers, ...table.rows] : table.rows
  const cols = Math.max(1, ...rows.map((row) => row.length))
  const colW = FRAME.w / cols
  const y = contentTop('table', title)
  const availableIn = FRAME.contentBottom - y

  const linesAt = (fontSize: number): number[] =>
    rows.map((row, index) =>
      Math.max(
        1,
        // 表头是粗体（其余行照正文量）；`rows[0]` 是表头当且仅当给了非空 headers
        ...row.map((cell) =>
          lineCount(cell.trim(), colW - CELL_INSET_X * 2, fontSize, {
            bold: hasHeaders && index === 0
          })
        )
      )
    )
  const rowHAt = (fontSize: number): number[] =>
    linesAt(fontSize).map((lines) =>
      Math.max(MIN_TABLE_ROW_H, lines * lineHeightIn(fontSize) + CELL_PAD_Y)
    )
  const sum = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0)

  const verdict = fitLadder(FIT_LADDER.table, availableIn, (size) => sum(rowHAt(size)))
  const rowH = rowHAt(verdict.fontSize)
  return {
    ...verdict,
    y,
    rowH,
    height: sum(rowH),
    lines: linesAt(verdict.fontSize).reduce((total, value) => total + value, 0),
    cols
  }
}

export interface StatsPlan {
  top: number
  cardH: number
  cardW: number
  gap: number
  /** 数值那一块的结论（字号与量测） */
  value: FitVerdict
  /** 标签那一块的结论 */
  label: FitVerdict
  /** 数值框 / 标签框的几何 */
  valueY: number
  valueH: number
  labelY: number
  labelH: number
}

/** 数字卡：卡片几何沿用原设计（高 2.2），只把**数值**与**标签**各自量一遍 */
export function statsPlan(stats: readonly FitStat[], title: TitleLayout): StatsPlan {
  const top = contentTop('stats', title)
  const gap = 0.25
  const cardW = (FRAME.w - gap * Math.max(0, stats.length - 1)) / Math.max(1, stats.length)
  const cardH = 2.2
  const valueY = top + 0.3
  const valueH = 1.0
  const labelY = top + 1.4
  const labelH = 0.7

  const values = stats.map((stat) => stat.value.trim())
  const labels = stats.map((stat) => stat.label.trim())
  // 数值是**粗体**大数字（拉丁/数字按粗体量）；标签是正文
  const valueTest = fitLadder(FIT_LADDER.statsValue, valueH - TEXT_INSET.y * 2, (size) =>
    worstBlockIn(values, cardW - TEXT_INSET.x * 2, size, 1, { bold: true })
  )
  const labelTest = fitLadder(FIT_LADDER.statsLabel, labelH - TEXT_INSET.y * 2, (size) =>
    worstBlockIn(labels, cardW - 0.16 - TEXT_INSET.x * 2, size)
  )
  return {
    top,
    cardH,
    cardW,
    gap,
    value: valueTest,
    label: labelTest,
    valueY,
    valueH,
    labelY,
    labelH
  }
}

export interface QuotePlan {
  verdict: FitVerdict
  /** 竖条与引言框：顶 / 高（高 = max(设计值 1.9, 实测行高 + 0.2)，封顶到可用区） */
  top: number
  textH: number
  /** 出处那一行（引言框之下 0.1in） */
  sourceY: number
  sourceH: number
}

/** 引言页：竖条与引言框同高；出处紧贴引言框之下（内容再长也不会压到页脚） */
export function quotePlan(quote: FitQuote, title: TitleLayout): QuotePlan {
  const top = contentTop('quote', title)
  const sourceH = 0.4
  const hasSource = (quote.source?.trim() ?? '') !== ''
  // 出处那一行占的高度（含间距）
  const reserved = hasSource ? sourceH + 0.1 : 0
  const maxTextH = FRAME.contentBottom - top - reserved
  const spacing = 1.25

  const measuredAt = (fontSize: number): number =>
    lineCount(quote.text.trim(), 7.7 - TEXT_INSET.x * 2, fontSize) * lineHeightIn(fontSize, spacing)

  let measured = measuredAt(FIT_LADDER.quote[0])
  const verdict = fitLadder(FIT_LADDER.quote, maxTextH - TEXT_INSET.y * 2, (size) => {
    measured = measuredAt(size)
    return measured
  })
  // 短引言保持原设计（框高 1.9、出处落在 1.9 之下）；长了才把框撑到实测高度（封顶到可用区）
  const textH = Math.min(maxTextH, Math.max(1.9, measured + 0.2))
  return {
    verdict,
    top,
    textH,
    sourceY: top + textH + 0.1,
    sourceH
  }
}

/** 一页的量测结论（回执与"拒绝输入"都用它） */
export interface PageFit {
  /** 物理页号（1 起、含封面；每一页都在量，故 `fits` 里的页号是连续的） */
  page: number
  layout: PptLayout
  /** 这一页**最糟**的那一项的名字（`标题` / `正文要点` / `封面副标题` …）：回执与报错都点名它 */
  target: string
  fontSize: number
  measuredIn: number
  availableIn: number
  overflowIn: number
  action: FitAction
  /**
   * 排不下的是哪一类：`title` = 标题（含封面 / 副标题、章节名 / 引导语、结尾语这些固定框里的字），
   * `content` = 这一页的正文块。**报错话术按它分，不要拿 `overflowIn <= 0` 猜标题**
   * （正文 round2 之后的小正值会把它骗过去）。
   */
  reason: 'title' | 'content'
  /**
   * 标题那一项**自己**缩过字号时的字号：这一页最糟的那项是正文（标题也缩了）时给出来，
   * 回执据此补一句"第 N 页（标题）缩到 Xpt" —— 否则标题缩了却只报正文那一句（漏报）。
   */
  titleShrink?: number
}

/** 各版式正文块在回执 / 报错里的名字 */
const TARGET_LABEL: Record<GappedLayout, string> = {
  content: '正文要点',
  'two-column': '左右分栏',
  stats: '数字卡',
  table: '表格',
  quote: '引言'
}

/** 一页要用哪些字段量（与 `pptSlideSchema` 同形的只读视图；pptx 渲染侧那份也兼容） */
export interface FitPageInput {
  layout: PptLayout
  title?: string
  /** 封面副标题（只有封面用它） */
  subtitle?: string
  /** 章节名（section 版式的主文本） */
  section?: string
  bullets?: readonly string[]
  columns?: readonly FitColumn[]
  table?: FitTable
  stats?: readonly FitStat[]
  quote?: FitQuote
}

/** 一页里被量测的一项：标题类（页面标题 / 封面两个框 / 章节名与引导语 / 结尾语）或正文块 */
interface FitItem {
  /** 报错与回执里怎么称呼它 */
  label: string
  verdict: FitVerdict
  /** 是不是"标题类"那一项（决定 `reason` 与报错话术） */
  title: boolean
}

/**
 * 量一页：**八种版式都量**，没有"静默跳过"的版式。
 *   - 正文类五页（content / two-column / table / stats / quote）量内容块，外加标题块（最多两行）；
 *   - 封面量标题与副标题、章节页量引导语与章标题、结尾页量那一句话 —— 它们各自占一块**固定框**
 *     （见 `SECTION_FRAME` / `CLOSING_FRAME` / `CoverFrame`），放不下就报（不缩字号）。
 * 一页里最糟的那项当这一页的结论（`target` / `fontSize` / `measuredIn` / `overflowIn` 都是它的）。
 */
export function fitPage(
  page: FitPageInput,
  pageNumber: number,
  cover: CoverFrame = CENTER_COVER_FRAME
): PageFit {
  if (page.layout === 'cover') {
    return toPageFit(pageNumber, 'cover', [
      {
        label: '封面标题',
        verdict: boxTextPlan(page.title, cover.title, { bold: true }),
        title: true
      },
      { label: '封面副标题', verdict: boxTextPlan(page.subtitle, cover.subtitle), title: true }
    ])
  }
  if (page.layout === 'section') {
    return toPageFit(pageNumber, 'section', [
      {
        label: '章节名',
        verdict: boxTextPlan(page.section, SECTION_FRAME.name, { bold: true }),
        title: true
      },
      { label: '章节引导语', verdict: boxTextPlan(page.title, SECTION_FRAME.kicker), title: true }
    ])
  }
  if (page.layout === 'closing') {
    return toPageFit(pageNumber, 'closing', [
      {
        label: '结尾语',
        verdict: boxTextPlan(page.title, CLOSING_FRAME.text, { bold: true }),
        title: true
      }
    ])
  }

  const title = titleLayout(page.title)
  const titleItem: FitItem = { label: '标题', verdict: title.fit, title: true }
  if (page.layout === 'content') {
    const plan = contentPlan(cleanList(page.bullets), title)
    return toPageFit(pageNumber, 'content', [bodyItem('content', plan), titleItem])
  }
  if (page.layout === 'two-column') {
    const plan = twoColumnPlan(page.columns ?? [], title)
    return toPageFit(pageNumber, 'two-column', [
      bodyItem('two-column', worst(plan.verdict, plan.heading)),
      titleItem
    ])
  }
  if (page.layout === 'table') {
    const plan = tablePlan(page.table ?? { rows: [] }, title)
    return toPageFit(pageNumber, 'table', [bodyItem('table', plan), titleItem])
  }
  if (page.layout === 'stats') {
    const plan = statsPlan(cleanStats(page.stats), title)
    return toPageFit(pageNumber, 'stats', [
      bodyItem('stats', worst(plan.value, plan.label)),
      titleItem
    ])
  }
  const plan = quotePlan(page.quote ?? { text: '' }, title)
  return toPageFit(pageNumber, 'quote', [bodyItem('quote', plan.verdict), titleItem])
}

function bodyItem(layout: GappedLayout, verdict: FitVerdict): FitItem {
  return { label: TARGET_LABEL[layout], verdict, title: false }
}

/** 标题是"最多两行"的那种框（正文类页面），还是固定物理框（封面 / 章节 / 结尾） */
function titleBoxIsFixed(layout: PptLayout): boolean {
  return layout === 'cover' || layout === 'section' || layout === 'closing'
}

function toPageFit(page: number, layout: PptLayout, items: readonly FitItem[]): PageFit {
  const top = items.reduce((worstSoFar, item) =>
    worseItem(item, worstSoFar) > 0 ? item : worstSoFar
  )
  const title = items.find((item) => item.title === true)
  return {
    page,
    layout,
    target: top.label,
    fontSize: top.verdict.fontSize,
    measuredIn: round2(top.verdict.measuredIn),
    availableIn: round2(top.verdict.availableIn),
    overflowIn: round2(top.verdict.overflowIn),
    action: top.verdict.action,
    reason: top.title ? 'title' : 'content',
    ...(title !== undefined && title !== top && title.verdict.action === 'shrunk'
      ? { titleShrink: title.verdict.fontSize }
      : {})
  }
}

/** 两项谁更糟：> 0 = **左边**更糟（先比等级，同级比超出量；一样就保持原样） */
function worseItem(left: FitItem, right: FitItem): number {
  const leftRank = rankOf(left.verdict)
  const rightRank = rankOf(right.verdict)
  if (leftRank !== rightRank) return leftRank - rightRank
  return left.verdict.overflowIn - right.verdict.overflowIn
}

function rankOf(verdict: FitVerdict): number {
  return verdict.action === 'report' ? 2 : verdict.action === 'shrunk' ? 1 : 0
}

function cleanList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((text) => text.trim()).filter((text) => text !== '')
}

function cleanStats(stats: readonly FitStat[] | undefined): FitStat[] {
  return (stats ?? []).filter((stat) => stat.value.trim() !== '')
}

/** 两个结论里更糟的那个（数字卡的数值与标签都得排得下） */
function worst(left: FitVerdict, right: FitVerdict): FitVerdict {
  const diff = rankOf(right) - rankOf(left)
  if (diff !== 0) return diff > 0 ? right : left
  return right.overflowIn > left.overflowIn ? right : left
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 有页排不下时的人话（**落盘前**由调用方 throw —— 这一版一个字节都不写）。
 * 点名第几页、哪一项、差多少、这一页该怎么改（拆页 / 减字），并说清"没有落盘"。
 * 标题类按 `reason` + 版式分两种话术（正文类页面是"排不进两行"，封面 / 章节 / 结尾是"超出固定框"）。
 */
export function overflowMessage(fits: readonly PageFit[]): string | null {
  const bad = fits.filter((fit) => fit.action === 'report')
  if (bad.length === 0) return null

  const detail = bad.map(describeOverflow).join('；')

  return (
    `这一版**没有落盘**：${detail}。正文类版式的字号已经缩到可读下限（正文 11pt / 分栏 10pt / ` +
    '表格 10pt / 引言 16pt / 标题两行内 20pt），封面与章节 / 结尾页的框是设计给死的、不缩字号。' +
    '请把这几页**拆成两页**或**减少文字**（要点每页 3-6 条、每条 25 字内；表格只留关键行；' +
    '标题与章节名一句话说完；来源类长链接单独成页），然后重发这几页。'
  )
}

/** 一页排不下的人话（标题类与正文块分开写：正文块按阶梯缩过字号，标题类有时是固定框） */
function describeOverflow(fit: PageFit): string {
  const where = `第 ${fit.page} 页（${fit.target}）`
  const over = fit.overflowIn.toFixed(2)
  if (fit.reason === 'title') {
    return titleBoxIsFixed(fit.layout)
      ? `${where}超出固定框约 ${over} 英寸（${fit.fontSize}pt 也放不下）`
      : `${where}连 ${fit.fontSize}pt 都排不进两行（超出约 ${over} 英寸）`
  }
  return `${where}超出可用区约 ${over} 英寸（下限 ${fit.fontSize}pt 仍差 ${over} 英寸）`
}

/**
 * 回执里那半句：报**真的缩过字号**的项（页面标题缩了也要报，否则漏报）。
 * 一项都没缩就给空串（短内容的回执一个字的排版话都不加）；排不下的页不会走到这里（调用方先拒了）。
 */
export function fitNote(fits: readonly PageFit[]): string {
  const detail: string[] = []
  for (const fit of fits) {
    if (fit.action === 'shrunk') {
      detail.push(`第 ${fit.page} 页（${fit.target}）缩到 ${fit.fontSize}pt`)
    }
    if (fit.titleShrink !== undefined) {
      detail.push(`第 ${fit.page} 页（标题）缩到 ${fit.titleShrink}pt`)
    }
  }
  if (detail.length === 0) return ''
  return `排版：${detail.join('、')} —— 原字号排不下，已按阶梯缩到可读下限之上`
}

/**
 * 回执里那半句的拼装：结构自检结论 + 排版结论（没缩过字号时**原样返回** ——
 * `create_ppt` / `edit_ppt` 共用这一处口径）。
 */
export function withFitNote(note: string, fits: readonly PageFit[]): string {
  const fit = fitNote(fits)
  return fit === '' ? note : `${note}；${fit}`
}
