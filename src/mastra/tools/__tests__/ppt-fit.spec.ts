// @vitest-environment node
/**
 * 排版预算引擎（`ppt-fit.ts`）的聚焦用例（round 77）。
 *
 * 全是**纯函数**断言：不渲染、不落盘、不起 Mastra。要钉住的是五件事：
 *   ① 量测模型（行高 = 字号 × 1.2；CJK/ASCII 宽度；长 ASCII 串不被劈开、不加零宽断点；
 *      **量测宽度 = 文本框宽 − 左右内边距**）；
 *   ② 字号阶梯：逐档试、第一档排得下就用它、到下限仍排不下 → `report`（调用方据此拒绝落盘）；
 *   ③ 标题最多两行：两行时短线/内容顶整体下移；连下限字号都排不进两行 → 报给调用方；
 *   ④ **固定框**（封面标题与副标题、章节页的引导语与章标题、结尾页那句话）：没有阶梯，
 *      放不下就 report；且封面那两个框与 `shared/ppt-templates` 的居中封面一致（漂了就红）；
 *   ⑤ 页脚安全区是**常量**（`contentBottom` 在细线之上留出 `FOOTER_CLEARANCE`），回执/报错是人话
 *      （标题报错看 `reason` 而不是 `overflowIn`；标题缩了字号也要在回执里报出来）。
 *
 * 常数来自真实页图的标定（见 `.superpowers/ppt-layout-fix/` 与 `ppt-fit.ts` 头注）：
 * 15pt @1.25 倍行距的实测行距就是 0.3125in —— 这里把它钉成断言，改常数时会**红**。
 */
import { describe, expect, it } from 'vitest'
import { coverPlan } from '../../../shared/ppt-templates'
import { lookupTheme } from '../ppt-themes'
import {
  ASCII_BOLD_EM,
  ASCII_EM,
  CENTER_COVER_FRAME,
  CLOSING_FRAME,
  FIT_LADDER,
  FOOTER_CLEARANCE,
  FRAME,
  MAX_TITLE_LINES,
  SECTION_FRAME,
  SPACE_EM,
  TEXT_INSET,
  blockMetrics,
  boxTextPlan,
  bulletLineCount,
  contentPlan,
  fitLadder,
  fitNote,
  fitPage,
  ladderFloor,
  lineCount,
  lineHeightIn,
  overflowMessage,
  paraSpaceAfterPt,
  quotePlan,
  statsPlan,
  tablePlan,
  textWidthEm,
  titleLayout,
  twoColumnPlan,
  wrapText,
  type FitVerdict,
  type PageFit,
  type TitleLayout
} from '../ppt-fit'

/** 真实页 4 的那条长 URL（101 字符，标定断行的样本） */
const LONG_URL =
  'https://www.justice.gov/opa/pr/saudi-national-arrested-installing-surreptitious-audio-recording-device-openai'

const pageFit = (over: Partial<PageFit>): PageFit => ({
  page: 3,
  layout: 'content',
  target: '正文要点',
  fontSize: 15,
  measuredIn: 2,
  availableIn: 3,
  overflowIn: 0,
  action: 'ok',
  reason: 'content',
  ...over
})

const verdict = (over: Partial<FitVerdict>): FitVerdict => ({
  fontSize: 15,
  measuredIn: 2,
  availableIn: 3,
  overflowIn: 0,
  action: 'ok',
  ...over
})

/** 标题块（"有标题、单行、26pt"）—— 各版式量测都要它 */
const singleTitle: TitleLayout = titleLayout('结论')

describe('量测模型：字符宽度 / 行高 / 段后距（常数来自真实页图标定）', () => {
  it('字符宽度：CJK 与全角 1em、ASCII 0.54em、粗体 ASCII 0.6em、空格 0.4em', () => {
    expect(textWidthEm('汉字')).toBe(2)
    expect(textWidthEm('，。')).toBe(2) // 全角标点也是 1em
    expect(textWidthEm('ab')).toBeCloseTo(ASCII_EM * 2, 10)
    expect(textWidthEm('ab', { bold: true })).toBeCloseTo(ASCII_BOLD_EM * 2, 10)
    expect(textWidthEm(' ')).toBeCloseTo(SPACE_EM, 10)
    // 粗体只影响拉丁/数字（CJK 粗体字宽不变）
    expect(textWidthEm('汉字', { bold: true })).toBe(2)
  })

  it('行高：15pt @1.25 倍 = 0.3125in（真实页图上量到的行距逐位一致）', () => {
    expect(lineHeightIn(15, 1.25)).toBeCloseTo(0.3125, 10)
    expect(lineHeightIn(26)).toBeCloseTo(0.433333, 5)
  })

  it('段后距随字号缩放：15pt → 10pt、11pt → 7pt', () => {
    expect(paraSpaceAfterPt(15)).toBe(10)
    expect(paraSpaceAfterPt(11)).toBe(7)
  })

  it('段落总高 = Σ(行 × 行高) + 段数 × 段后距（末段的段后距也算进去）', () => {
    const block = blockMetrics([1, 2], 15, 1.25)
    expect(block.lines).toBe(3)
    expect(block.heightIn).toBeCloseTo(3 * 0.3125 + 2 * (10 / 72), 10)
  })

  it('宽 8.6in 的正文区：41 个汉字一行放得下、42 个就换行（8.6×72÷15 = 41.28）', () => {
    const width = FRAME.w - TEXT_INSET.x * 2
    expect(lineCount('汉'.repeat(41), width, 15)).toBe(1)
    expect(lineCount('汉'.repeat(42), width, 15)).toBe(2)
  })

  it('长 URL：只在连字符后断，且**一个字符都不改**（不插零宽断点、不截断）', () => {
    const lines = wrapText(LONG_URL, FRAME.w - TEXT_INSET.x * 2, 15)
    expect(lines.length).toBe(2)
    expect(lines[0].endsWith('-')).toBe(true)
    // 拼回去必须与原串逐字节相同 —— 这就是"不为了布局改内容"的可断言形式
    expect(lines.join('')).toBe(LONG_URL)
    expect(lines.join('')).not.toContain('\u200b')
  })

  it('同一输入两次结果相同（纯函数，无隐藏状态）', () => {
    const once = wrapText('混合 Latin 与汉字 123 的文本，长度刚好跨行', 3, 15)
    const twice = wrapText('混合 Latin 与汉字 123 的文本，长度刚好跨行', 3, 15)
    expect(twice).toEqual(once)
  })

  it('单调性：字越小行数不多、文本越长行数不少', () => {
    const text = '一条要点讲清楚一件事，长了就换行。'.repeat(3)
    expect(lineCount(text, 8.6, 11)).toBeLessThanOrEqual(lineCount(text, 8.6, 15))
    expect(lineCount(text.repeat(2), 8.6, 15)).toBeGreaterThanOrEqual(lineCount(text, 8.6, 15))
  })

  it('要点首行让开「● 」前缀：首行容量比续行小', () => {
    const text = '汉'.repeat(40)
    expect(bulletLineCount(text, FRAME.w, 15)).toBeGreaterThanOrEqual(lineCount(text, FRAME.w, 15))
  })

  it('量测宽度要扣左右内边距（0.1in × 2）：不扣就会把两行算成两行、三行的算成两行', () => {
    // 82 个字：按整框宽 8.8in 算正好两行（首行 41 + 续行 41），按真实文本框宽 8.6in 算是三行
    const text = '汉'.repeat(82)
    expect(bulletLineCount(text, FRAME.w, 15)).toBe(2)
    expect(bulletLineCount(text, FRAME.w - TEXT_INSET.x * 2, 15)).toBe(3)
    // 版式的量测走的是扣过内边距的那一档
    expect(contentPlan([text], singleTitle).lines).toBe(3)
  })
})

describe('字号阶梯：逐档试、有下限、到下限就 report', () => {
  it('每档阶梯都从大到小，且末端就是可读下限', () => {
    for (const sizes of Object.values(FIT_LADDER)) {
      for (let index = 1; index < sizes.length; index += 1) {
        expect(sizes[index]).toBeLessThan(sizes[index - 1])
      }
    }
    expect(ladderFloor('content')).toBe(11)
    expect(ladderFloor('two-column')).toBe(10)
    expect(ladderFloor('table')).toBe(10)
    expect(ladderFloor('quote')).toBe(16)
    expect(ladderFloor('title')).toBe(20)
  })

  it('第一档排得下 → ok 且用第一档字号（内容不紧的页字号照旧）', () => {
    const result = fitLadder([15, 14, 13], 3.26, () => 2)
    expect(result).toEqual(
      verdict({ fontSize: 15, measuredIn: 2, availableIn: 3.26, action: 'ok' })
    )
  })

  it('第一档排不下、后面某档排得下 → shrunk 且报出实际字号', () => {
    const result = fitLadder([15, 14, 13, 12, 11], 3.26, (size) => (size >= 13 ? 4 : 3))
    expect(result.action).toBe('shrunk')
    expect(result.fontSize).toBe(12)
    expect(result.overflowIn).toBe(0)
  })

  it('到下限仍排不下 → report（不继续缩、不静默落盘）+ 报出差多少', () => {
    const result = fitLadder([15, 14, 13, 12, 11], 3, () => 3.5)
    expect(result.action).toBe('report')
    expect(result.fontSize).toBe(11)
    expect(result.overflowIn).toBeCloseTo(0.5, 10)
  })
})

describe('页脚安全区：常量、且真的在细线之上', () => {
  it('contentBottom 在页脚细线之上留出安全距离（0.16in ≈ 11.5pt）', () => {
    expect(FRAME.contentBottom).toBeLessThan(FRAME.hairlineY)
    expect(FOOTER_CLEARANCE).toBeCloseTo(0.16, 10)
    expect(FOOTER_CLEARANCE).toBeGreaterThan(0.12)
  })

  it('正文区在画布内（x + w ≤ 10in），页脚在画布内', () => {
    expect(FRAME.x + FRAME.w).toBeLessThanOrEqual(10)
    expect(FRAME.footerY + FRAME.footerH).toBeLessThanOrEqual(5.625)
  })
})

describe('标题块：最多两行；两行时短线与内容顶整体下移', () => {
  it('单行标题：字号 26pt、框高 0.72、短线仍在 1.18（单行标题的几何沿用原设计）', () => {
    expect(singleTitle).toMatchObject({
      hasTitle: true,
      fontSize: 26,
      lines: 1,
      boxH: FRAME.titleSingleH,
      ruleY: FRAME.ruleY,
      action: 'ok'
    })
    expect(singleTitle.contentStart).toBeCloseTo(1.35, 10)
    // 单行标题不让位：正文顶仍取设计位（contentStart 只是"至少从这里起步"的下限）
    expect(singleTitle.contentStart).toBeLessThan(FRAME.bodyY)
    expect(contentPlan(['一条'], singleTitle).y).toBe(FRAME.bodyY)
  })

  it('两行标题：保持 26pt，但**短线落在标题框之下**、（内容顶随之让位）', () => {
    const two = titleLayout('要闻二｜OpenAI 工程师涉在会议室装窃听设备被起诉')
    expect(two.lines).toBe(MAX_TITLE_LINES)
    expect(two.fontSize).toBe(26)
    expect(two.ruleY).toBeGreaterThan(FRAME.ruleY)
    // 关键不变量：短线不被第二行文字穿过
    expect(two.ruleY).toBeGreaterThanOrEqual(FRAME.titleY + two.boxH)
    expect(two.contentStart).toBeGreaterThan(FRAME.bodyY)
  })

  it('连下限字号都排不进两行 → report（标题该精简，由调用方拒绝）', () => {
    const long = titleLayout('极'.repeat(80))
    expect(long.action).toBe('report')
    expect(long.fontSize).toBe(ladderFloor('title'))
    // 标题自己那一项的结论：可用高 = 两行，超出量 = 多出来的那几行的高度
    expect(long.fit.action).toBe('report')
    expect(long.fit.fontSize).toBe(ladderFloor('title'))
    expect(long.fit.overflowIn).toBeGreaterThan(0)
  })

  it('缩字号才排进两行的标题：fit.action = shrunk（回执据此报"标题"）', () => {
    const shrunk = titleLayout('极'.repeat(60))
    expect(shrunk.action).toBe('shrunk')
    expect(shrunk.fit.action).toBe('shrunk')
    expect(shrunk.fit.overflowIn).toBe(0)
    expect(singleTitle.fit.action).toBe('ok')
  })

  it('没有标题：不算标题块（各版式回到"无标题"的内容顶）', () => {
    const none = titleLayout(undefined)
    expect(none.hasTitle).toBe(false)
    expect(none.lines).toBe(0)
  })
})

describe('固定框的量测：可用高就是框高、宽度扣内边距、没有字号阶梯', () => {
  const cover = CENTER_COVER_FRAME.title // 8.4 × 1.35in @ 40pt

  it('空文本 = 不占高（那一页没给这个字段）', () => {
    const none = boxTextPlan(undefined, cover, { bold: true })
    expect(none).toMatchObject({ lines: 0, measuredIn: 0, overflowIn: 0, action: 'ok' })
  })

  it('可用高 = 框高（不扣上下内边距）：一行 0.667in 在 0.68in 的框里放得下、0.6in 的框放不下', () => {
    const text = '季度业务复盘'
    expect(boxTextPlan(text, { w: 8.4, h: 0.68, size: 40 }, { bold: true }).action).toBe('ok')
    expect(boxTextPlan(text, { w: 8.4, h: 0.6, size: 40 }, { bold: true }).action).toBe('report')
  })

  it('宽度扣左右内边距：15 个汉字在 8.4in 的框里要换行（不扣就是一行）', () => {
    const text = '汉'.repeat(15)
    const box = { h: 0.7, size: 40 }
    // 8.4in 的框扣掉 0.1×2 → 正文宽 8.2in = 590.4pt < 15 × 40pt → 两行
    expect(boxTextPlan(text, { ...box, w: 8.4 }, { bold: true }).lines).toBe(2)
    // 8.6in 的框扣掉后是 8.4in = 604.8pt ≥ 600pt → 一行
    expect(boxTextPlan(text, { ...box, w: 8.6 }, { bold: true }).lines).toBe(1)
  })

  it('没有阶梯：字号永远是设计值（超了就是 report，不缩）', () => {
    const long = boxTextPlan('汉'.repeat(30), cover, { bold: true })
    expect(long.fontSize).toBe(cover.size)
    expect(long.action).toBe('report')
    expect(long.overflowIn).toBeGreaterThan(0)
  })
})

describe('各版式的量测：框底一律止于 contentBottom', () => {
  it('正文要点页：框底 = contentBottom，可用高扣掉上下内边距', () => {
    const plan = contentPlan(['一条短要点'], singleTitle)
    expect(plan.action).toBe('ok')
    expect(plan.fontSize).toBe(15)
    expect(plan.y).toBe(FRAME.bodyY)
    expect(plan.y + plan.h).toBeCloseTo(FRAME.contentBottom, 10)
    expect(plan.availableIn).toBeCloseTo(FRAME.contentBottom - plan.y - 2 * TEXT_INSET.y, 10)
  })

  it('正文要点页：两行标题把正文顶顶下来（可用高变小）', () => {
    const two = titleLayout('要闻二｜OpenAI 工程师涉在会议室装窃听设备被起诉')
    const plan = contentPlan(['一条短要点'], two)
    expect(plan.y).toBeGreaterThan(FRAME.bodyY)
    expect(plan.availableIn).toBeLessThan(contentPlan(['一条短要点'], singleTitle).availableIn)
  })

  it('正文要点页：30 条 × 100 字排不下 → report（给调用方拒绝的理由）', () => {
    const bullets = Array.from({ length: 30 }, () => '长'.repeat(100))
    const plan = contentPlan(bullets, singleTitle)
    expect(plan.action).toBe('report')
    expect(plan.overflowIn).toBeGreaterThan(0)
  })

  it('表格：行高按行给（≥0.4in）、总高 = Σ行高；20 行 × 长单元格排不下 → report', () => {
    const small = tablePlan({ headers: ['甲', '乙'], rows: [['1', '2']] }, singleTitle)
    expect(small.action).toBe('ok')
    expect(small.rowH).toEqual([0.4, 0.4])
    expect(small.height).toBeCloseTo(0.8, 10)
    expect(small.y + small.height).toBeLessThanOrEqual(FRAME.contentBottom)

    const big = tablePlan(
      {
        headers: ['A', 'B', 'C'],
        rows: Array.from({ length: 20 }, (_, index) => [
          `${index}`,
          '长文本长文本长文本',
          '更长的说明文字更长的说明文字更长的说明文字'
        ])
      },
      singleTitle
    )
    expect(big.action).toBe('report')
    expect(big.overflowIn).toBeGreaterThan(0)
  })

  it('表格：空 headers 不算一行（渲染侧也是 headers.length > 0 才画它）', () => {
    const withoutHeader = tablePlan({ headers: [], rows: [['1', '2']] }, singleTitle)
    expect(withoutHeader.rowH).toHaveLength(1)
    expect(withoutHeader.height).toBeCloseTo(0.4, 10)

    const withHeader = tablePlan({ headers: ['甲', '乙'], rows: [['1', '2']] }, singleTitle)
    expect(withHeader.rowH).toHaveLength(2)
  })

  it('分栏：只取前两栏、要点先 trim 去空（与渲染侧 slice(0,2) + cleanBullets 一致）', () => {
    const plan = twoColumnPlan(
      [
        { title: ' 甲 ', bullets: ['一条', '   ', '两条'] },
        { title: '乙', bullets: ['三条'] },
        // 第三栏内容再狠也不该参与量测（schema 只让给两栏，但预算不能靠它把关）
        { title: '丙', bullets: Array.from({ length: 12 }, () => '长'.repeat(60)) }
      ],
      singleTitle
    )
    expect(plan.verdict.action).toBe('ok')
    expect(plan.verdict.fontSize).toBe(13)
    expect(plan.lines).toBe(2)
  })

  it('数字卡：数值 30pt、标签 12pt（字号照原设计）；60 字标签排不下 → report', () => {
    const ok = statsPlan(
      [
        { value: '12%', label: '营收增长' },
        { value: '3.2 亿', label: '营收规模' }
      ],
      singleTitle
    )
    expect(ok.value.action).toBe('ok')
    expect(ok.value.fontSize).toBe(30)
    expect(ok.label.action).toBe('ok')
    expect(ok.label.fontSize).toBe(12)
    // 卡片几何沿用原设计：底 4.05 < 内容底
    expect(ok.top + ok.cardH).toBeLessThan(FRAME.contentBottom)

    const crowded = statsPlan(
      Array.from({ length: 6 }, () => ({ value: '1', label: '长'.repeat(60) })),
      singleTitle
    )
    expect(crowded.label.action).toBe('report')
  })

  it('分栏：两栏取最差的那栏；短内容用 13pt，长内容到下限仍排不下 → report', () => {
    const ok = twoColumnPlan(
      [
        { title: '要做', bullets: ['交付快'] },
        { title: '不做', bullets: ['多端'] }
      ],
      singleTitle
    )
    expect(ok.verdict.action).toBe('ok')
    expect(ok.verdict.fontSize).toBe(13)
    expect(ok.heading.action).toBe('ok')
    expect(ok.top + ok.height).toBeCloseTo(FRAME.contentBottom, 10)

    const crowded = twoColumnPlan(
      [
        { title: '要做', bullets: Array.from({ length: 12 }, () => '长'.repeat(60)) },
        { title: '不做', bullets: Array.from({ length: 12 }, () => '长'.repeat(60)) }
      ],
      singleTitle
    )
    expect(crowded.verdict.action).toBe('report')
  })

  it('引言：短引言保持原设计（框高 1.9、出处在其下）；300 字排不下 → report', () => {
    const ok = quotePlan({ text: '少即是多', source: '密斯' }, singleTitle)
    expect(ok.verdict.action).toBe('ok')
    expect(ok.verdict.fontSize).toBe(24)
    expect(ok.textH).toBeCloseTo(1.9, 10)
    expect(ok.sourceY + ok.sourceH).toBeLessThanOrEqual(FRAME.contentBottom)

    const long = quotePlan({ text: '长'.repeat(300), source: '出处' }, singleTitle)
    expect(long.verdict.action).toBe('report')
    expect(long.sourceY + long.sourceH).toBeLessThanOrEqual(FRAME.contentBottom)
  })
})

describe('fitPage / 人话：点名第几页、差多少、怎么改', () => {
  it('封面 / 章节页 / 结尾页也量：量的是各自的固定框，不是"跳过"', () => {
    const cover = fitPage({ layout: 'cover', title: '季度汇报', subtitle: '2026 Q3' }, 1)
    expect(cover).toMatchObject({ page: 1, layout: 'cover', action: 'ok', target: '封面标题' })
    expect(cover.reason).toBe('title')

    const section = fitPage({ layout: 'section', section: '业务概览' }, 2)
    expect(section).toMatchObject({ layout: 'section', action: 'ok', target: '章节名' })

    const closing = fitPage({ layout: 'closing', title: '讨论与答疑' }, 9)
    expect(closing).toMatchObject({ layout: 'closing', action: 'ok', target: '结尾语' })
  })

  it('封面标题 / 副标题 / 章节名 / 结尾语超出固定框 → report（量的是那一项，字号是它的）', () => {
    const cover = fitPage({ layout: 'cover', title: '汉'.repeat(30) }, 1)
    expect(cover).toMatchObject({
      action: 'report',
      reason: 'title',
      target: '封面标题',
      fontSize: CENTER_COVER_FRAME.title.size
    })
    expect(cover.overflowIn).toBeGreaterThan(0)

    const subtitle = fitPage({ layout: 'cover', title: '短', subtitle: '汉'.repeat(70) }, 1)
    expect(subtitle).toMatchObject({ action: 'report', target: '封面副标题' })

    const section = fitPage({ layout: 'section', section: '汉'.repeat(19) }, 2)
    expect(section).toMatchObject({ action: 'report', reason: 'title', target: '章节名' })
    expect(section.fontSize).toBe(SECTION_FRAME.name.size)

    const closing = fitPage({ layout: 'closing', title: '汉'.repeat(15) }, 9)
    expect(closing).toMatchObject({ action: 'report', reason: 'title', target: '结尾语' })
    expect(closing.fontSize).toBe(CLOSING_FRAME.text.size)
  })

  it('固定框的框与字号与 shared/ppt-templates 的居中封面一致（漂了这个用例会红）', () => {
    const plan = coverPlan(lookupTheme('商务蓝')!)
    expect(plan.align).toBe('center')
    expect({ w: plan.title.w, h: plan.title.h, size: plan.titleSize }).toEqual(
      CENTER_COVER_FRAME.title
    )
    expect({
      w: plan.subtitle.w,
      h: plan.subtitle.h,
      size: plan.subtitleSize
    }).toEqual(CENTER_COVER_FRAME.subtitle)

    // band 封面（学术紫 / 湖蓝）的标题块窄 0.8in —— 所以 renderPptx 一律把当前模板的框传进 fitPage
    const band = coverPlan(lookupTheme('学术紫')!)
    expect(band.align).toBe('left')
    expect(band.title.w).toBeLessThan(CENTER_COVER_FRAME.title.w)
  })

  it('正文页：报出页号、版式与结论；标题排不下时点名"标题"且字号取标题那一项', () => {
    const fit = fitPage({ layout: 'content', title: '结论', bullets: ['一条'] }, 3)
    expect(fit).toMatchObject({ page: 3, layout: 'content', target: '正文要点', action: 'ok' })

    const bad = fitPage({ layout: 'content', title: '极'.repeat(80), bullets: ['一条'] }, 4)
    expect(bad).toMatchObject({ action: 'report', reason: 'title', target: '标题' })
    // 字号必须是**标题**的量测值（20pt），不是正文那一档
    expect(bad.fontSize).toBe(ladderFloor('title'))
    expect(bad.fontSize).not.toBe(FIT_LADDER.content[0])
    expect(bad.overflowIn).toBeGreaterThan(0)
  })

  it('标题缩了字号、正文没缩：回执要报标题那一句（否则就是漏报）', () => {
    const fit = fitPage({ layout: 'content', title: '极'.repeat(60), bullets: ['一条'] }, 3)
    expect(fit.action).toBe('shrunk')
    expect(fit.target).toBe('标题')
    expect(fit.fontSize).toBe(ladderFloor('title'))
    expect(fitNote([fit])).toMatch(/第 3 页（标题）缩到 20pt/)
  })

  it('标题与正文都缩了字号：回执两句都报，一句都不漏', () => {
    const fits = [pageFit({ page: 4, action: 'shrunk', fontSize: 13, titleShrink: 20 })]
    const note = fitNote(fits)
    expect(note).toContain('第 4 页（正文要点）缩到 13pt')
    expect(note).toContain('第 4 页（标题）缩到 20pt')
  })

  it('全都排得下：overflowMessage 给 null，fitNote 给空串（短内容的回执没有排版那半句）', () => {
    const fits = [pageFit({ page: 2 }), pageFit({ page: 3 })]
    expect(overflowMessage(fits)).toBeNull()
    expect(fitNote(fits)).toBe('')
  })

  it('缩过字号：fitNote 报出页号与字号（不拦落盘，只让模型知道"填得太满"）', () => {
    const fits = [pageFit({ page: 3, action: 'shrunk', fontSize: 13 })]
    expect(fitNote(fits)).toContain('第 3 页')
    expect(fitNote(fits)).toContain('13pt')
    expect(overflowMessage(fits)).toBeNull()
  })

  it('排不下：overflowMessage 点名页与差多少、给拆页/减字的出口、并说清没有落盘', () => {
    const fits = [
      pageFit({ page: 3 }),
      pageFit({ page: 8, layout: 'content', action: 'report', fontSize: 11, overflowIn: 0.42 })
    ]
    const message = overflowMessage(fits)
    expect(message).not.toBeNull()
    expect(message).toContain('第 8 页')
    expect(message).toContain('0.42')
    expect(message).toContain('没有落盘')
    expect(message).toMatch(/拆成两页|减少文字/)
  })

  it('报错按 reason 分话术：正文的四舍五入小值不会被当成标题错误', () => {
    // 正文 round2 后可能是 0.00，按老口径（overflowIn <= 0）会被误报成"标题排不进两行"
    const body = pageFit({
      page: 8,
      target: '正文要点',
      action: 'report',
      reason: 'content',
      overflowIn: 0
    })
    const message = overflowMessage([body])
    expect(message).toContain('第 8 页（正文要点）')
    expect(message).not.toContain('排不进两行')

    const title = pageFit({
      page: 4,
      target: '标题',
      action: 'report',
      reason: 'title',
      layout: 'content',
      overflowIn: 0.33
    })
    expect(overflowMessage([title])).toContain('第 4 页（标题）连 15pt 都排不进两行')

    const fixed = pageFit({
      page: 2,
      layout: 'section',
      target: '章节名',
      action: 'report',
      reason: 'title',
      fontSize: 32,
      overflowIn: 0.22
    })
    expect(overflowMessage([fixed])).toContain('第 2 页（章节名）超出固定框约 0.22 英寸')
  })
})
