// @vitest-environment node
/**
 * 版面几何 + 真实产物 + 负向拒绝的聚焦用例（round 77）。
 *
 * 三组要钉住的东西：
 *   ① **几何不变量**（真解包断言 XML）：文本框一律止于 `FRAME.contentBottom`（页脚细线之上），
 *      两行标题的 accent 短线落在标题框**之下**（不再被第二行穿过），表格声明行高之和也在内容底之内；
 *   ② **真实 8 页输入**（`fixtures/news-ppt-pages.ts`，从轨迹导出的原样入参）：页数不变、长链接**原样**
 *      在包里（不插零宽断点、不截断）；第 1 页封面与第 2~7 页缩字号后放得下，
 *      **第 8 页（真实长来源）排不下 → report**；
 *   ③ **负向**：排不下时 `create_ppt` / `edit_ppt` **整次拒绝** —— 盘上那份的原字节与库里的源结构
 *      一个都不动（"失败文件不变"），报错点名第几页、差多少、怎么改。
 *
 * 不走 COM、不看页图：这里断言的是**几何与策略**；"看起来对不对"由 render_ppt 的页图复核。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PptSourceRecord, PptSourceRecordInput } from '../../../shared/session-ppt-sources'
import type { SessionPptSourceStore } from '../../session-ppt-sources'
import { readZipEntries } from '../artifact-check'
import { createEditPptTool } from '../ppt-edit'
import { createPptTool, FRAME, pptInputSchema, renderPptx, type PptInput } from '../ppt'
import { overflowMessage } from '../ppt-fit'
import { NEWS_PPT_DECK, NEWS_PPT_FINAL, NEWS_PPT_PAGE3 } from './fixtures/news-ppt-pages'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/
const EMU_PER_INCH = 914_400
/** 浮点余量（pptxgenjs 把英寸四舍五入到 EMU） */
const EPS = 1e-3

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function pageNames(entries: Map<string, Buffer>): string[] {
  return [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort(
      (left, right) => Number(/slide(\d+)/.exec(left)?.[1]) - Number(/slide(\d+)/.exec(right)?.[1])
    )
}

function pageXml(entries: Map<string, Buffer>, index: number): string {
  return zipText(entries, `ppt/slides/slide${index}.xml`)
}

/** 一页里所有形状的包围盒（带 `txBody` 的就是文本框） */
function shapesOf(xml: string): Array<Box & { text: boolean }> {
  const found: Array<Box & { text: boolean }> = []
  for (const shape of xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? []) {
    const transform = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
    if (transform === null) continue
    found.push({
      x: Number(transform[1]) / EMU_PER_INCH,
      y: Number(transform[2]) / EMU_PER_INCH,
      w: Number(transform[3]) / EMU_PER_INCH,
      h: Number(transform[4]) / EMU_PER_INCH,
      text: shape.includes('<p:txBody>')
    })
  }
  return found
}

const textBoxes = (xml: string): Box[] => shapesOf(xml).filter((shape) => shape.text)

/** 标题下那条 accent 短线（1in × 0.06in 的色块） */
function titleRule(xml: string): Box | undefined {
  return shapesOf(xml).find(
    (shape) => !shape.text && Math.abs(shape.w - 1) < EPS && Math.abs(shape.h - 0.06) < EPS
  )
}

/** 表格框与它**声明**的每一行高度（`<a:tr h="...">`，单位英寸） */
function tablesOf(xml: string): Array<{ frame: Box; rows: number[] }> {
  const found: Array<{ frame: Box; rows: number[] }> = []
  for (const frame of xml.match(/<p:graphicFrame>.*?<\/p:graphicFrame>/gs) ?? []) {
    const transform = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(frame)
    const rows = [...frame.matchAll(/<a:tr h="(\d+)"/g)].map(
      (match) => Number(match[1]) / EMU_PER_INCH
    )
    if (transform === null) continue
    found.push({
      frame: {
        x: Number(transform[1]) / EMU_PER_INCH,
        y: Number(transform[2]) / EMU_PER_INCH,
        w: Number(transform[3]) / EMU_PER_INCH,
        h: Number(transform[4]) / EMU_PER_INCH
      },
      rows
    })
  }
  return found
}

/** 文本框要么在内容区之内，要么就是页脚那一格（y ≥ 细线）—— 不允许"压着细线" */
function expectBoxesInsideContent(boxes: Box[], where: string): void {
  for (const box of boxes) {
    const inside = box.y + box.h <= FRAME.contentBottom + EPS
    const footer = box.y >= FRAME.hairlineY - EPS
    expect(
      inside || footer,
      `${where} 的文本框 ${JSON.stringify(box)} 既不在内容区（底 ${FRAME.contentBottom}）也不在页脚区`
    ).toBe(true)
  }
}

/** 内存版源结构存储（形状与真 store 一致；只验工具侧行为） */
function memorySources(): SessionPptSourceStore {
  const rows = new Map<string, PptSourceRecord>()
  const key = (threadId: string, path: string): string => `${threadId}\u0000${path}`
  const mine = (threadId?: string): PptSourceRecord[] =>
    [...rows.values()]
      .filter((row) => threadId === undefined || row.threadId === threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return {
    async ensureTable() {
      // 内存假件：没有表要建
    },
    async find(threadId, path) {
      return rows.get(key(threadId, path)) ?? null
    },
    async latest(threadId) {
      return mine(threadId)[0] ?? null
    },
    async record(input: PptSourceRecordInput) {
      rows.set(key(input.threadId, input.path), { ...input, updatedAt: new Date().toISOString() })
    },
    async clear(threadId, path) {
      if (path === undefined) {
        for (const row of mine(threadId)) rows.delete(key(threadId, row.path))
        return
      }
      rows.delete(key(threadId, path))
    },
    async list(threadId) {
      return mine(threadId)
    }
  }
}

/** 一份"每条版式各一页"的合成 deck：内容都排得下（用来验几何，不验拒绝） */
const ALL_LAYOUTS: PptInput = {
  title: '季度业务复盘',
  subtitle: '2026 Q3 · 战略与运营部',
  theme: '商务蓝',
  slides: [
    { section: '业务概览' },
    { title: '核心结论', bullets: ['营收同比增长 12%', '毛利率稳定在 41%'] },
    {
      // 两行标题（25 个汉字 @26pt）：规则线与正文顶必须随之让位
      title: '这是一条会被排成两行的页面标题用于验证规则线让位',
      bullets: ['第一条要点写得短一点', '第二条要点也短', '第三条同样短']
    },
    {
      title: '关键指标',
      stats: [
        { value: '12%', label: '营收增长' },
        { value: '3.2 亿', label: '营收规模' }
      ]
    },
    {
      title: '分区表现',
      table: {
        headers: ['区域', '营收', '同比'],
        rows: [
          ['华东', '1.2 亿', '+14%'],
          ['华南', '0.8 亿', '+9%']
        ]
      }
    },
    {
      title: '优劣势',
      columns: [
        { title: '优势', bullets: ['交付快'] },
        { title: '待改进', bullets: ['毛利偏低'] }
      ]
    },
    { quote: { text: '战略不是选择做什么，而是选择不做什么。', source: '迈克尔·波特' } },
    { layout: 'closing' as const, title: '讨论与答疑' }
  ]
}

/** 真实 8 页里**去掉长来源那一页**的版本（7 页，排得下）：给"失败文件原字节不变"当基线 */
const SEVEN_PAGES: PptInput = {
  ...NEWS_PPT_DECK,
  slides: NEWS_PPT_FINAL.slides.slice(0, 6),
  expect: undefined
}

/** 排不下的一页（30 条 × 100 字，任何字号都放不进正文区） */
const OVERFLOWING_PAGE = {
  title: '塞爆的一页',
  bullets: Array.from({ length: 30 }, () => '长'.repeat(100))
}

let bed: TestBed

beforeEach(() => {
  bed = createBed({ mode: 'full' })
})

afterEach(() => {
  bed.dispose()
})

describe('几何不变量：文本框止于内容底、短线不被标题穿过', () => {
  it('八种版式各一页：每个文本框要么在内容区、要么是页脚；没有一页 report', async () => {
    const rendered = await renderPptx(ALL_LAYOUTS)
    expect(rendered.slides).toBe(9)
    expect(rendered.fits.map((fit) => fit.action)).not.toContain('report')
    // 封面也在量测范围内（量的是它那两个固定框），故 `fits` 与 PowerPoint 的页序一一对应
    expect(rendered.fits.map((fit) => fit.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])

    const entries = readZipEntries(rendered.data)
    for (let page = 1; page <= 9; page += 1) {
      expectBoxesInsideContent(textBoxes(pageXml(entries, page)), `第 ${page} 页`)
    }
  })

  it('两行标题：短文线落在标题框之下（不再被第二行穿过），正文顶也被顶下来', async () => {
    const rendered = await renderPptx(ALL_LAYOUTS)
    // 封面=1、章节=2、正文=3、两行标题=4
    const xml = pageXml(readZipEntries(rendered.data), 4)
    const rule = titleRule(xml)
    expect(rule).toBeDefined()
    const title = textBoxes(xml).find((box) => Math.abs(box.y - FRAME.titleY) < EPS)
    expect(title).toBeDefined()
    expect(rule?.y).toBeGreaterThanOrEqual((title?.y ?? 0) + (title?.h ?? 0) - EPS)

    // 同一页的正文框顶也在标题块之下（1.5in 是单行标题的位置）
    const body = textBoxes(xml).find((box) => box.y > 1.6 && box.h > 2)
    expect(body).toBeDefined()
    expect(body?.y).toBeGreaterThan(FRAME.bodyY)
  })

  it('表格：声明行高之和 + 表顶 ≤ 内容底（声明即所得，不靠 PowerPoint 事后撑高）', async () => {
    const rendered = await renderPptx(ALL_LAYOUTS)
    const xml = pageXml(readZipEntries(rendered.data), 6) // 表格页
    const tables = tablesOf(xml)
    expect(tables).toHaveLength(1)
    const table = tables[0]
    expect(table.rows).toHaveLength(3) // 表头 + 2 行
    expect(table.frame.y + table.rows.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(
      FRAME.contentBottom + EPS
    )
    expect(table.rows.every((height) => height >= 0.4 - EPS)).toBe(true)
  })
})

describe('真实 8 页输入：页数与长链接不变；排不下的页照实报出来', () => {
  it('页数仍是 8；两条长链接原样落进 XML（不截断、不插零宽断点）', async () => {
    const rendered = await renderPptx(NEWS_PPT_FINAL)
    expect(rendered.slides).toBe(8)

    const entries = readZipEntries(rendered.data)
    expect(pageNames(entries)).toHaveLength(8)
    expect(pageXml(entries, 3)).toContain(
      'https://china.googleblog.com/2026/10/gemini-4-argon_0397895399.html'
    )
    expect(pageXml(entries, 4)).toContain(
      'https://www.justice.gov/opa/pr/saudi-national-arrested-installing-surreptitious-audio-recording-device-openai'
    )
    for (const name of pageNames(entries)) {
      expect(zipText(entries, name), `${name} 不该出现零宽断点`).not.toContain('\u200b')
    }
  })

  it('逐页结论：第 2~7 页缩字号后排得下；第 8 页（真实长来源）排不下 → report', async () => {
    const rendered = await renderPptx(NEWS_PPT_FINAL)
    // 封面（第 1 页）也在量测范围内，故页号与 PowerPoint 的页序一致、从 1 起
    expect(rendered.fits.map((fit) => fit.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rendered.fits[0]).toMatchObject({ layout: 'cover', action: 'ok', target: '封面标题' })

    const byPage = new Map(rendered.fits.map((fit) => [fit.page, fit]))
    for (const page of [2, 3, 4, 5, 6, 7]) {
      expect(byPage.get(page)?.action, `第 ${page} 页`).not.toBe('report')
      expect(byPage.get(page)?.fontSize).toBeGreaterThanOrEqual(11)
    }
    // 第 8 页是"4 条长链接 + 3 条说明"的来源页：11pt 也放不下 —— 工具层据此拒绝整份
    const last = byPage.get(8)
    expect(last?.action).toBe('report')
    expect(last?.overflowIn).toBeGreaterThan(0)

    const message = overflowMessage(rendered.fits)
    expect(message).toContain('第 8 页')
    expect(message).toMatch(/拆成两页|减少文字/)

    // 排得下的那几页：文本框全在内容底之内（这才是"没静默落溢出稿"的可断言形式）
    const entries = readZipEntries(rendered.data)
    for (const page of [2, 3, 4, 5, 6, 7]) {
      expectBoxesInsideContent(textBoxes(pageXml(entries, page)), `第 ${page} 页`)
    }
    // 两行标题的三页（4/5/6）：短线在标题框之下
    for (const page of [4, 5, 6]) {
      const xml = pageXml(entries, page)
      const rule = titleRule(xml)
      const title = textBoxes(xml).find((box) => Math.abs(box.y - FRAME.titleY) < EPS)
      expect(title, `第 ${page} 页应有标题框`).toBeDefined()
      expect(rule?.y, `第 ${page} 页的短线该在标题框之下`).toBeGreaterThanOrEqual(
        (title?.y ?? 0) + (title?.h ?? 0) - EPS
      )
    }
  })
})

describe('负向：排不下就整次拒绝，一个字节都不写', () => {
  it('真实 8 页（第 8 页排不下）：create_ppt 拒绝且不落文件', async () => {
    const tool = await createPptTool(bed.ctx)
    await expect(callTool(tool, NEWS_PPT_FINAL)).rejects.toThrow(
      /没有落盘[\s\S]*第 8 页|第 8 页[\s\S]*拆成两页/
    )
    expect(existsSync(join(bed.root, 'AI新闻日报.pptx'))).toBe(false)
  })

  it('盘上已有一版时，排不下**不会**覆盖它：原文件逐字节不变', async () => {
    const tool = await createPptTool(bed.ctx)
    await callTool(tool, SEVEN_PAGES)
    const file = join(bed.root, 'AI新闻日报.pptx')
    const before = readFileSync(file)

    await expect(callTool(tool, NEWS_PPT_FINAL)).rejects.toThrow(/没有落盘/)
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('30 条 × 100 字的正文页：拒绝并点名页与改法', async () => {
    const tool = await createPptTool(bed.ctx)
    await expect(
      callTool(tool, { title: '演示', path: 'x.pptx', slides: [OVERFLOWING_PAGE] })
    ).rejects.toThrow(/第 2 页（正文要点）[\s\S]*拆成两页/)
    expect(existsSync(join(bed.root, 'x.pptx'))).toBe(false)
  })

  it('表格行数超一页容量（6 行数据 + 表头 = 7 行也放不下长单元格）：拒绝并点名表格', async () => {
    const tool = await createPptTool(bed.ctx)
    const table = {
      title: '超容量表',
      table: {
        headers: ['A', 'B', 'C'],
        // 行数在 schema 上限之内（6 行数据），但每格三行字 → 表高 4.2in 远超内容区 3.16in
        rows: Array.from({ length: 6 }, (_, index) => [
          `${index + 1}`,
          '长文本'.repeat(15),
          '更长的说明文字'.repeat(6)
        ])
      }
    }
    await expect(
      callTool(tool, { title: '演示', path: 'table.pptx', slides: [table] })
    ).rejects.toThrow(/第 2 页（表格）/)
    expect(existsSync(join(bed.root, 'table.pptx'))).toBe(false)
  })

  it('超出行数上限的表格（7 行数据 + 表头）在 schema 那一关就被拒（不靠运行时报错）', async () => {
    const parsed = pptInputSchema.safeParse({
      slides: [{ table: { rows: Array.from({ length: 7 }, () => ['a']) } }]
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message).join('；')).toContain(
      '表格最多 6 行数据'
    )
  })

  it('封面标题 / 副标题超出固定框：同样拒绝并点名那一项（封面不再是"不量的版式"）', async () => {
    const tool = await createPptTool(bed.ctx)
    await expect(
      callTool(tool, {
        title: '汉'.repeat(30),
        path: 'cover.pptx',
        slides: [{ title: '结论', bullets: ['一条要点'] }]
      })
    ).rejects.toThrow(/第 1 页（封面标题）超出固定框/)
    expect(existsSync(join(bed.root, 'cover.pptx'))).toBe(false)

    await expect(
      callTool(tool, {
        title: '季度汇报',
        subtitle: '汉'.repeat(70),
        path: 'cover2.pptx',
        slides: [{ title: '结论', bullets: ['一条要点'] }]
      })
    ).rejects.toThrow(/第 1 页（封面副标题）超出固定框/)
    expect(existsSync(join(bed.root, 'cover2.pptx'))).toBe(false)
  })

  it('80 个字的标题（连 20pt 都排不进两行）：拒绝并点名"标题"', async () => {
    const tool = await createPptTool(bed.ctx)
    await expect(
      callTool(tool, {
        title: '演示',
        path: 'title.pptx',
        slides: [{ title: '极'.repeat(80), bullets: ['一条要点'] }]
      })
    ).rejects.toThrow(/第 2 页（标题）[\s\S]*两行/)
    expect(existsSync(join(bed.root, 'title.pptx'))).toBe(false)
  })

  it('edit_ppt：改出来的页排不下 → 整次拒绝，盘上那份与库里的源都不动', async () => {
    const sources = memorySources()
    const create = await createPptTool(bed.ctx, { sources })
    const edit = await createEditPptTool(bed.ctx, { sources })

    await callTool(create, SEVEN_PAGES, 'thread-1')
    const file = join(bed.root, 'AI新闻日报.pptx')
    const before = readFileSync(file)
    const record = await sources.find('thread-1', file)
    expect(record).not.toBeNull()

    await expect(
      callTool(
        edit,
        { path: 'AI新闻日报.pptx', ops: [{ op: 'replace', page: 2, slide: OVERFLOWING_PAGE }] },
        'thread-1'
      )
    ).rejects.toThrow(/没有落盘/)

    expect(readFileSync(file).equals(before)).toBe(true)
    expect((await sources.find('thread-1', file))?.sha256).toBe(record?.sha256)
  })
})

describe('回执：缩过字号报出来；没缩就一字不加', () => {
  it('缩过字号的页在回执里点名（排版：第 N 页…缩到 Xpt）', async () => {
    const tool = await createPptTool(bed.ctx)
    const receipt = String(
      await callTool(tool, {
        title: 'AI 新闻日报',
        path: 'one.pptx',
        slides: [NEWS_PPT_PAGE3]
      })
    )
    expect(receipt).toContain('结构校验通过')
    expect(receipt).toMatch(/排版：第 2 页（正文要点）缩到 \d+pt/)
  })

  it('短内容（字号不用缩）：回执与老口径逐字一致，没有"排版："那半句', async () => {
    const tool = await createPptTool(bed.ctx)
    const receipt = String(
      await callTool(tool, {
        title: '季度汇报',
        path: 'plain.pptx',
        slides: [{ title: '结论', bullets: ['稳中向好'] }]
      })
    )
    expect(receipt).toContain('；结构校验通过')
    expect(receipt).not.toContain('排版：')
  })
})
