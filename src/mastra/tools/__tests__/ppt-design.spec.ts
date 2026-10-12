// @vitest-environment node
/**
 * create_ppt 的**设计系统**用例（round 62）：内置主题、版式自动挑选、新字段上限、旧形状兼容。
 *
 * 生成物一律**真解包**（`../artifact-check` 的 `readZipEntries`）断言 XML 里的结构证据 ——
 * 断言的是"主题色 / 微软雅黑 / 页脚 / 页码 / 字号 / 表格底纹真的落进了 slideN.xml"，
 * 而不是"某个库自己认自己"。
 */
import { describe, expect, it } from 'vitest'
import { readZipEntries } from '../artifact-check'
import { PPT_LAYOUTS, pptInputSchema, renderPptx, resolveLayout } from '../ppt'
import { PPT_FONT, PPT_THEMES, PPT_THEME_NAMES, resolveTheme } from '../ppt-themes'
import { zipText } from './zip'

/** 一页一条 slide 部件（与产出侧同一个正则） */
const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/

/** 解包后按**页序**取 slide 部件名（中央目录顺序即书写顺序，这里按页号排序防意外） */
function pageNames(entries: Map<string, Buffer>): string[] {
  return [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort((left, right) => pageNumber(left) - pageNumber(right))
}

function pageNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)
}

/** 第 index 页（1 起）的 XML */
function pageXml(entries: Map<string, Buffer>, index: number): string {
  return zipText(entries, `ppt/slides/slide${index}.xml`)
}

/** 出现次数（结构证据里常用） */
function count(xml: string, pattern: RegExp): number {
  return (xml.match(pattern) ?? []).length
}

/** 英寸 → EMU（pptxgenjs 写进 XML 的位置单位） */
const EMU_PER_INCH = 914_400

/** 页脚文字盒的并集（左「文档标题」+ 右「页码」，见 ppt.ts 的 FRAME）：装饰色块不许压到它 */
const FOOTER_ZONE = { left: 0.6, right: 9.4, top: 5.08, bottom: 5.38 }

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** slide XML 里**没有文本框的形状**（= 装饰色块 / 短线 / 卡片）的包围盒，单位英寸 */
function solidShapes(xml: string): Box[] {
  const boxes: Box[] = []
  for (const shape of xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? []) {
    if (shape.includes('<p:txBody>')) continue
    const transform = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
    if (transform === null) continue
    boxes.push({
      x: Number(transform[1]) / EMU_PER_INCH,
      y: Number(transform[2]) / EMU_PER_INCH,
      w: Number(transform[3]) / EMU_PER_INCH,
      h: Number(transform[4]) / EMU_PER_INCH
    })
  }
  return boxes
}

function overlapsFooter(box: Box): boolean {
  return (
    box.x < FOOTER_ZONE.right &&
    box.x + box.w > FOOTER_ZONE.left &&
    box.y < FOOTER_ZONE.bottom &&
    box.y + box.h > FOOTER_ZONE.top
  )
}

/** 解析失败的原因（要能告诉模型"怎么改"） */
function issuesOf(result: {
  success: boolean
  error?: { issues: Array<{ message: string }> }
}): string {
  return result.error?.issues.map((issue) => issue.message).join('；') ?? ''
}

describe('内置主题：六套齐全、配色合法、显式优先、自动挑选确定性', () => {
  it('六套主题名与顺序固定，每套的七个颜色都是 6 位大写 hex，强调形状风格在册', () => {
    expect(PPT_THEME_NAMES).toEqual(['极简黑白', '商务蓝', '科技暗', '暖橙', '墨绿', '紫罗兰'])
    expect(PPT_FONT).toBe('微软雅黑')

    for (const name of PPT_THEME_NAMES) {
      const theme = PPT_THEMES[name]
      expect(theme.name).toBe(name)
      const colors = [
        theme.bg,
        theme.canvas,
        theme.title,
        theme.body,
        theme.accent,
        theme.muted,
        theme.onAccent
      ]
      for (const color of colors) {
        expect(color, `${name} 的 ${color} 应是 6 位大写 hex`).toMatch(/^[0-9A-F]{6}$/)
      }
      expect(['bar', 'block', 'corner']).toContain(theme.motif)
    }

    // 六套要真的分得开：强调色两两不同（不然"选主题"等于没选）
    expect(new Set(PPT_THEME_NAMES.map((name) => PPT_THEMES[name].accent)).size).toBe(6)
  })

  it('给了 theme 就用它；给了不认识的名字退到自动挑（不抛错、不落成"没有主题"）', () => {
    expect(resolveTheme({ theme: '墨绿', title: '任何标题', slides: [] }).name).toBe('墨绿')
    const auto = resolveTheme({ title: '任何标题', slides: [] }).name
    expect(resolveTheme({ theme: '彩虹色', title: '任何标题', slides: [] }).name).toBe(auto)
  })

  it('自动挑是确定性的：同一输入两次同主题，一批输入会分散到多套主题', () => {
    const input = { title: '季度汇报', slides: [{ title: '结论' }, { title: '下一步' }] }
    expect(resolveTheme(input).name).toBe(resolveTheme(input).name)

    const titles = [
      '季度汇报',
      '产品发布',
      '年度总结',
      '教学课件',
      '商业提案',
      '财务报表',
      '个人小结'
    ]
    const picked = new Set(
      titles.map((title) => resolveTheme({ title, slides: [{ title: '要点' }] }).name)
    )
    expect(picked.size).toBeGreaterThanOrEqual(3)
    for (const name of picked) expect([...PPT_THEME_NAMES]).toContain(name)
  })

  it('渲染入口同样确定：同一 deck 两次生成，主题与页数一致', async () => {
    const deck = { title: '季度汇报', slides: [{ title: '结论', bullets: ['稳中向好'] }] }
    const first = await renderPptx(deck)
    const second = await renderPptx({ ...deck, slides: [{ title: '结论', bullets: ['稳中向好'] }] })
    expect(first.theme).toBe(second.theme)
    expect(first.slides).toBe(second.slides)
  })
})

describe('resolveLayout：显式优先、缺数据退自动、按内容自动挑', () => {
  it('没给 layout 就按数据挑（stats → quote → table → two-column → section → content）', () => {
    expect(resolveLayout({ stats: [{ value: '12%', label: '营收' }] })).toBe('stats')
    expect(resolveLayout({ quote: { text: '少即是多' } })).toBe('quote')
    expect(resolveLayout({ table: { rows: [['甲']] } })).toBe('table')
    expect(resolveLayout({ columns: [{}, {}] })).toBe('two-column')
    expect(resolveLayout({ section: '第一章' })).toBe('section')
    expect(resolveLayout({ title: '结论' })).toBe('content')
    expect(resolveLayout({ bullets: ['一条要点'] })).toBe('content')
  })

  it('什么都挑不出来给 null（空对象 / 全空白要点都跳过）', () => {
    expect(resolveLayout({})).toBeNull()
    expect(resolveLayout({ bullets: ['  ', ''] })).toBeNull()
    expect(resolveLayout({ title: '   ' })).toBeNull()
  })

  it('多个字段同时在时按固定优先级挑（同一输入两次同结果）', () => {
    const slide = {
      title: '结论',
      bullets: ['a'],
      section: '第一章',
      stats: [{ value: '1', label: 'x' }]
    }
    expect(resolveLayout(slide)).toBe('stats')
    expect(resolveLayout(slide)).toBe('stats')
  })

  it('显式 layout 优先；数据撑不起来时退到自动（不硬排一张半空的页）', () => {
    expect(
      resolveLayout({
        layout: 'table',
        stats: [{ value: '1', label: 'x' }],
        table: { rows: [['甲']] }
      })
    ).toBe('table')
    expect(resolveLayout({ layout: 'stats', title: '结论' })).toBe('content')
    expect(resolveLayout({ layout: 'closing' })).toBe('closing')
    expect(resolveLayout({ layout: 'stats', bullets: ['a'] })).toBe('content')
  })
})

describe('schema：新字段的上限都被拒，提示告诉模型怎么改', () => {
  const stats = (length: number, label = 'x'): Array<{ value: string; label: string }> =>
    Array.from({ length }, (_, index) => ({ value: `${index}`, label }))

  const cases: Array<[string, unknown, string]> = [
    ['副标题', { slides: [{ title: 'T' }], subtitle: 'x'.repeat(121) }, '副标题最长 120 字'],
    ['数字卡张数', { slides: [{ stats: stats(7) }] }, '一页最多 6 张数字卡'],
    [
      '数字卡数值',
      { slides: [{ stats: [{ value: 'x'.repeat(25), label: 'x' }] }] },
      '数字卡的数值最长 24 字'
    ],
    [
      '数字卡标签',
      { slides: [{ stats: [{ value: '1', label: 'x'.repeat(61) }] }] },
      '数字卡的标签最长 60 字'
    ],
    [
      '表格行数',
      { slides: [{ table: { rows: Array.from({ length: 21 }, () => ['a']) } }] },
      '表格最多 20 行'
    ],
    [
      '表格列数',
      { slides: [{ table: { rows: [Array.from({ length: 9 }, () => 'a')] } }] },
      '表格最多 8 列'
    ],
    ['单元格长度', { slides: [{ table: { rows: [['x'.repeat(201)]] } }] }, '单元格最长 200 字'],
    ['空表格', { slides: [{ table: { rows: [] } }] }, '至少要有一行数据'],
    ['引言长度', { slides: [{ quote: { text: 'x'.repeat(301) } }] }, '引言最长 300 字'],
    [
      '引言出处',
      { slides: [{ quote: { text: 'x', source: 'y'.repeat(121) } }] },
      '出处最长 120 字'
    ],
    ['章节名', { slides: [{ section: 'x'.repeat(81) }] }, '章节名最长 80 字'],
    ['分栏数量', { slides: [{ columns: [{}, {}, {}] }] }, '正好两栏'],
    [
      '单栏要点数',
      {
        slides: [
          { columns: [{ bullets: ['a'] }, { bullets: Array.from({ length: 13 }, () => 'b') }] }
        ]
      },
      '一栏最多 12 条要点'
    ]
  ]

  for (const [kind, input, message] of cases) {
    it(`${kind}：${message}`, () => {
      const parsed = pptInputSchema.safeParse(input)
      expect(parsed.success).toBe(false)
      expect(issuesOf(parsed)).toContain(message)
    })
  }

  it('theme / layout 只认在册取值；给了主题与版式的输入照常通过', () => {
    expect(pptInputSchema.safeParse({ theme: '彩虹色', slides: [{ title: 'T' }] }).success).toBe(
      false
    )
    expect(pptInputSchema.safeParse({ slides: [{ layout: 'grid', title: 'T' }] }).success).toBe(
      false
    )

    const parsed = pptInputSchema.safeParse({
      title: '季度复盘',
      subtitle: '战略与运营部',
      theme: '科技暗',
      slides: [
        { section: '业务概览' },
        { layout: 'content', title: '结论', bullets: ['稳中向好'] },
        { quote: { text: '少即是多', source: '密斯' } },
        { columns: [{ title: '优势', bullets: ['交付快'] }, { title: '待改进' }] }
      ]
    })
    expect(parsed.success).toBe(true)
    expect([...PPT_LAYOUTS]).toHaveLength(8)
  })
})

describe('向后兼容：老形状照旧（cover → content → closing）', () => {
  it('title + slides[{title,bullets}] 仍是封面 + 正文页 + 自动结尾页', async () => {
    const { data, slides, theme } = await renderPptx({
      title: '季度汇报',
      slides: [
        { title: '结论', bullets: ['营收增长 12%', '成本持平'] },
        {},
        { bullets: ['下一步：扩产'] }
      ]
    })

    // 封面 + 两页有内容的（空对象那页跳过）+ 自动结尾页
    expect(slides).toBe(4)
    const entries = readZipEntries(data)
    expect(pageNames(entries)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide4.xml'
    ])
    expect(pageXml(entries, 1)).toContain('季度汇报')
    expect(pageXml(entries, 2)).toContain('营收增长 12%')
    expect(pageXml(entries, 3)).toContain('下一步：扩产')
    expect(pageXml(entries, 4)).toContain('谢谢观看')
    expect([...PPT_THEME_NAMES]).toContain(theme)
  })

  it('自己给了 closing 页就不补自动结尾页；没有文档标题（不出封面）也不补', async () => {
    const explicit = await renderPptx({
      title: '季度汇报',
      slides: [{ title: '结论' }, { layout: 'closing' as const, title: '讨论与答疑' }]
    })
    expect(explicit.slides).toBe(3)
    const explicitEntries = readZipEntries(explicit.data)
    expect(pageXml(explicitEntries, 3)).toContain('讨论与答疑')
    expect(pageXml(explicitEntries, 3)).not.toContain('谢谢观看')

    const noCover = await renderPptx({ slides: [{ title: '只有一页' }] })
    expect(noCover.slides).toBe(1)
    expect(pageXml(readZipEntries(noCover.data), 1)).toContain('只有一页')
  })

  it('内容全空仍产出一页占位（不能是零页演示文稿）', async () => {
    const { data, slides } = await renderPptx({ slides: [{}] })
    expect(slides).toBe(1)
    expect(pageXml(readZipEntries(data), 1)).toContain('没有内容')
  })
})

describe('结构证据：八种版式 + 统一点缀系统（真解包断言 XML）', () => {
  /** 固定用 商务蓝：accent/canvas/muted 都是可断言的确定值（自动挑的主题随输入变，不适合钉 hex） */
  const BLUE = PPT_THEMES['商务蓝']

  const DECK = {
    title: '季度业务复盘',
    subtitle: '2026 Q3 · 战略与运营部',
    theme: '商务蓝',
    slides: [
      { section: '业务概览' },
      { title: '核心结论', bullets: ['营收同比增长 12%', '毛利率稳定在 41%'] },
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

  /** 一次渲染、多组断言共用（渲染一次比每次重渲快得多） */
  async function renderDeck(): Promise<Map<string, Buffer>> {
    const rendered = await renderPptx(DECK)
    expect(rendered.theme).toBe('商务蓝')
    expect(rendered.slides).toBe(8)
    return readZipEntries(rendered.data)
  }

  it('封面 + 七种内容版式各一页（含章节页序号、结尾页走显式文字）', async () => {
    const entries = await renderDeck()

    expect(pageXml(entries, 1)).toContain('季度业务复盘')
    expect(pageXml(entries, 1)).toContain('2026 Q3 · 战略与运营部')
    // 章节页：大号序号 1 + 章节名
    expect(pageXml(entries, 2)).toContain('<a:t>1</a:t>')
    expect(pageXml(entries, 2)).toContain('业务概览')
    expect(pageXml(entries, 3)).toContain('核心结论')
    expect(pageXml(entries, 4)).toContain('关键指标')
    expect(pageXml(entries, 5)).toContain('分区表现')
    expect(pageXml(entries, 6)).toContain('优劣势')
    expect(pageXml(entries, 7)).toContain('迈克尔·波特')
    expect(pageXml(entries, 8)).toContain('讨论与答疑')
    expect(pageXml(entries, 8)).not.toContain('谢谢观看')
  })

  it('每页都落进主题强调色与「微软雅黑」（配色/字体不是渲染端的幻觉）', async () => {
    const entries = await renderDeck()

    for (let index = 1; index <= 8; index++) {
      const xml = pageXml(entries, index)
      expect(xml, `第 ${index} 页应带主题强调色 ${BLUE.accent}`).toContain(`val="${BLUE.accent}"`)
      expect(xml, `第 ${index} 页应带字体「微软雅黑」`).toContain('微软雅黑')
      expect(xml, `第 ${index} 页应铺主题底色 ${BLUE.bg}`).toContain(`val="${BLUE.bg}"`)
    }
  })

  it('页脚：除封面外每页左=文档标题、右=页码；封面不出页脚（页码从 2 起）', async () => {
    const entries = await renderDeck()

    expect(pageXml(entries, 1)).not.toContain('<a:t>1</a:t>')
    for (let index = 2; index <= 8; index++) {
      const xml = pageXml(entries, index)
      expect(xml, `第 ${index} 页页脚应有文档标题`).toContain('<a:t>季度业务复盘</a:t>')
      expect(xml, `第 ${index} 页页脚应有页码 ${index}`).toContain(`<a:t>${index}</a:t>`)
    }
  })

  it('统一点缀：正文页标题下一条 accent 短线；要点每条一个 accent 圆点（1.25 倍行距）', async () => {
    const entries = await renderDeck()
    const content = pageXml(entries, 3)

    // 标题块 + 短线：titleY 下方那条 accent 色块（0.06in 高）
    expect(content).toContain(`<a:ext cx="914400" cy="54864"/>`)
    expect(content).toContain(`<a:srgbClr val="${BLUE.accent}"/>`)
    // 每条要点 = 一个 accent 色的 ● run + 正文 run
    expect(count(content, /<a:t>●<\/a:t>/g)).toBe(2)
    expect(content).toContain('营收同比增长 12%')
    expect(content).toContain('毛利率稳定在 41%')
    expect(content).toContain('<a:spcPct val="125000"/>')
  })

  it('KPI 数字卡片：浅底圆角卡 + accent 大数字（30pt）', async () => {
    const entries = await renderDeck()
    const stats = pageXml(entries, 4)

    expect(count(stats, /prst="roundRect"/g)).toBe(2)
    expect(count(stats, new RegExp(`val="${BLUE.canvas}"`, 'g'))).toBeGreaterThanOrEqual(2)
    expect(stats).toContain('营收增长')
    expect(stats).toContain('<a:t>12%</a:t>')
    expect(stats).toContain('sz="3000"')
  })

  it('表格：主题色表头（含压色字）+ 隔行浅底 + 主题色描边', async () => {
    const entries = await renderDeck()
    const table = pageXml(entries, 5)

    expect(table).toContain('<a:tbl>')
    expect(table).toContain('<a:t>区域</a:t>')
    expect(table).toContain('<a:t>华南</a:t>')
    // 表头底色 = accent、表头字色 = onAccent；数据行隔行 canvas
    expect(count(table, new RegExp(`val="${BLUE.accent}"`, 'g'))).toBeGreaterThanOrEqual(4)
    expect(table).toContain(`val="${BLUE.onAccent}"`)
    expect(count(table, new RegExp(`val="${BLUE.canvas}"`, 'g'))).toBeGreaterThanOrEqual(3)
  })

  it('左右分栏：两张浅底卡 + 双栏小标题与要点', async () => {
    const entries = await renderDeck()
    const columns = pageXml(entries, 6)

    expect(count(columns, /prst="roundRect"/g)).toBe(2)
    expect(columns).toContain('优势')
    expect(columns).toContain('待改进')
    expect(count(columns, /<a:t>●<\/a:t>/g)).toBe(2)
  })

  it('引言页：大号引号（66pt）+ 24pt 引言 + 右下角出处', async () => {
    const entries = await renderDeck()
    const quote = pageXml(entries, 7)

    expect(quote).toContain('sz="6600"')
    expect(quote).toContain('sz="2400"')
    expect(quote).toContain('战略不是选择做什么，而是选择不做什么。')
    expect(quote).toContain('—— 迈克尔·波特')
  })

  it('封面大字号（40pt）与结尾页字号都按模板落进 XML', async () => {
    const entries = await renderDeck()

    expect(pageXml(entries, 1)).toContain('sz="4000"')
    expect(pageXml(entries, 8)).toContain('sz="3600"')
  })

  it('三种装饰风格都不压页脚区（章节页/结尾页也带页脚，装饰色块必须让开）', async () => {
    // 极简黑白 / 墨绿 = bar，商务蓝 / 暖橙 = block，科技暗 / 紫罗兰 = corner：每种风格各取一套
    for (const theme of ['极简黑白', '商务蓝', '科技暗'] as const) {
      const rendered = await renderPptx({
        title: '季度复盘',
        theme,
        slides: [{ section: '业务概览' }, { layout: 'closing' as const, title: '讨论与答疑' }]
      })
      const entries = readZipEntries(rendered.data)

      for (const index of [2, 3]) {
        const shapes = solidShapes(pageXml(entries, index))
        // 页脚细线在页脚区上方一条（不算压住），故这里至少要有装饰块
        expect(shapes.length, `${theme} 第 ${index} 页应有装饰色块`).toBeGreaterThan(1)
        for (const shape of shapes) {
          expect(
            overlapsFooter(shape),
            `${theme} 第 ${index} 页的色块 ${JSON.stringify(shape)} 压住了页脚区`
          ).toBe(false)
        }
      }
    }
  })
})
