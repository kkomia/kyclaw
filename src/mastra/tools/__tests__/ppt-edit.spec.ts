// @vitest-environment node
/**
 * round 76：**增量改一份已有演示文稿**（edit_ppt）的聚焦用例。
 *
 * 要钉住的四件事（都是"改了以后就再也回不去"的行为）：
 *   ① **红→绿**：改一页 → 页数不变、只有那一页的 slide XML 变了、模型入参里不含其他页的完整内容；
 *   ② 四个操作各自的语义（replace / insert / delete / meta）与页序口径（1 起、含封面）；
 *   ③ **干净失败**的三条：没有源结构 / 文件被手改过 / 文件被删 —— 一律不动盘上的文件，回人话给出口；
 *   ④ 改完把**新的**源结构与指纹写回去（下一次编辑在这一次的基础上改）。
 *
 * 走的是真链路：真临时工作区 + 真 pptxgenjs 渲染 + 真解包断言（`readZipEntries`）——
 * 断言的是"文件里真有这一页、真的是那一页变了"，不是"某个库自己认自己"。
 * 源结构存储在这一份里用内存假件（真 libsql 的读写见 __tests__/session-ppt-sources.spec.ts，
 * 全链（真 agent + 真库）见 __tests__/ppt-edit-agent.spec.ts）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PptSourceRecord, PptSourceRecordInput } from '../../../shared/session-ppt-sources'
import type { SessionPptSourceStore } from '../../session-ppt-sources'
import { sha256Of } from '../../session-ppt-sources'
import { readZipEntries } from '../artifact-check'
import { createEditPptTool, pptEditInputSchema } from '../ppt-edit'
import { createPptTool, renderPptx, type PptInput } from '../ppt'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/

/** 解包后按页序的 slide 部件名 */
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

function packageOf(file: string): Map<string, Buffer> {
  return readZipEntries(readFileSync(file))
}

/** 内存版源结构存储（形状与真 store 一致；这一份只看工具侧行为） */
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

/** 一份"像真任务那样"的初稿：封面 + 6 页，够长，才量得出"增量 vs 整份"的差 */
const DECK: PptInput = {
  title: '今日新闻简报',
  subtitle: '2026-10-13 每日要闻（本机时间）',
  slides: [
    { section: '宏观' },
    {
      title: '国内要闻',
      bullets: [
        '货币政策｜PSL 利率下调 0.25 个百分点（央行）',
        '财政发力｜四季度专项债发行提速（财政部）',
        '出口退税｜退税率由 13% 降至 9%（税务总局）'
      ]
    },
    {
      title: '关键指标',
      stats: [
        { value: '182.3 万辆', label: '9 月新能源车销量（同比 +13.6%）' },
        { value: '4.9%', label: '9 月社零同比（国家统计局）' }
      ]
    },
    {
      title: '海外动态',
      bullets: ['美联储｜9 月会议纪要显示分歧加大（新华社）', '原油｜布伦特收于 78.4 美元（路透）']
    },
    { title: '一句话', quote: { text: '政策底已现，剩下的看执行。', source: '—— 券商晨会纪要' } },
    {
      title: '下一步',
      bullets: ['关注 10 月 15 日三季度 GDP（国家统计局）', '跟踪专项债发行节奏（财政部）']
    }
  ]
}

let bed: TestBed
let sources: SessionPptSourceStore
let create: unknown
let edit: unknown

beforeEach(async () => {
  bed = createBed({ mode: 'full' })
  sources = memorySources()
  create = await createPptTool(bed.ctx, { sources })
  edit = await createEditPptTool(bed.ctx, { sources })
})

afterEach(() => {
  bed.dispose()
})

/** 先做一版（返回落盘路径与当时那份文件的 XML） */
async function firstVersion(
  session = 'thread-1',
  deck: PptInput = DECK
): Promise<{ file: string; entries: Map<string, Buffer> }> {
  await callTool(create, deck, session)
  const file = join(bed.root, `${deck.title ?? '演示文稿'}.pptx`)
  return { file, entries: packageOf(file) }
}

describe('① 红→绿：改一页 = 页数不变、只有那页变了、入参只含那一页', () => {
  it('replace 第 3 页：其余页的 slide XML 逐字节没动', async () => {
    const { file, entries: before } = await firstVersion()

    const ops = {
      path: '今日新闻简报.pptx',
      ops: [
        {
          op: 'replace',
          page: 3,
          slide: {
            title: '国内要闻（核实后）',
            bullets: ['货币政策｜PSL 利率下调 0.25 个百分点（央行 10-13 确认）']
          }
        }
      ]
    }
    await callTool(edit, ops, 'thread-1')
    const after = packageOf(file)

    // 页数不变、页序不变
    expect(pageNames(after)).toEqual(pageNames(before))
    expect(pageNames(after)).toHaveLength(7)

    // **只有第 3 页变**（封面 + 第 2/4/5/6/7 页逐字节相同）
    for (const name of pageNames(before)) {
      if (name === 'ppt/slides/slide3.xml') continue
      expect(zipText(after, name)).toBe(zipText(before, name))
    }
    expect(pageXml(after, 3)).not.toBe(pageXml(before, 3))
    expect(pageXml(after, 3)).toContain('国内要闻（核实后）')
    expect(pageXml(after, 3)).toContain('央行 10-13 确认')
    expect(pageXml(after, 3)).not.toContain('财政发力')

    // **模型入参里不含其他页的完整内容**：这一改的入参只有"改哪一页 + 改什么"
    const incremental = JSON.stringify(pptEditInputSchema.parse(ops))
    const whole = JSON.stringify(DECK)
    expect(incremental).not.toContain('海外动态')
    expect(incremental).not.toContain('182.3 万辆')
    expect(incremental.length * 3).toBeLessThan(whole.length)
  })

  it('改完把新的源结构与指纹写回去（下一次编辑在这一次的基础上改）', async () => {
    const { file } = await firstVersion()
    await callTool(
      edit,
      { path: '今日新闻简报.pptx', ops: [{ op: 'delete', page: 7 }] },
      'thread-1'
    )

    const record = await sources.find('thread-1', file)
    expect(record?.sha256).toBe(sha256Of(readFileSync(file)))
    expect(record?.size).toBe(readFileSync(file).byteLength)
    expect(record?.pages).toBe(6)
    expect(JSON.parse(record?.sourceJson ?? '{}').slides).toHaveLength(5)
  })
})

describe('② 四个操作与页序口径（1 起、含封面）', () => {
  it('insert after:3 → 新页落在第 4 页，原来的内容页顺延到第 5 页', async () => {
    const { file } = await firstVersion()

    await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [{ op: 'insert', after: 3, slide: { title: '插进来的风险页', bullets: ['上游涨价'] } }]
      },
      'thread-1'
    )
    const after = packageOf(file)

    expect(pageNames(after)).toHaveLength(8)
    expect(pageXml(after, 4)).toContain('插进来的风险页')
    // 原来的第 4 页（关键指标）顺延到第 5 页 —— 页脚页码跟着走，所以这里比内容不比字节
    expect(pageXml(after, 5)).toContain('关键指标')
  })

  it('insert after:0 → 插在封面之后、第一个内容页之前', async () => {
    const { file } = await firstVersion()

    await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [{ op: 'insert', after: 0, slide: { title: '本次要闻提示', bullets: ['三件事'] } }]
      },
      'thread-1'
    )

    expect(pageXml(packageOf(file), 2)).toContain('本次要闻提示')
  })

  it('delete:3 → 页数减一，原来的第 4 页顶上来', async () => {
    const { file } = await firstVersion()

    await callTool(
      edit,
      { path: '今日新闻简报.pptx', ops: [{ op: 'delete', page: 3 }] },
      'thread-1'
    )
    const after = packageOf(file)

    expect(pageNames(after)).toHaveLength(6)
    expect(pageXml(after, 3)).toContain('关键指标')
    expect(pageXml(after, 3)).not.toContain('国内要闻')
  })

  it('meta：改封面标题（页数不变、封面真的换了字）', async () => {
    const { file } = await firstVersion()

    const receipt = await callTool(
      edit,
      { path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: '今日新闻简报（修订版）' }] },
      'thread-1'
    )

    expect(pageXml(packageOf(file), 1)).toContain('今日新闻简报（修订版）')
    // 回执与 create_ppt 同形，并且带"改后页序"（模型靠它对页码）
    expect(String(receipt)).toContain('已覆盖')
    expect(String(receipt)).toContain('模板「')
    expect(String(receipt)).toContain('改后页序：1 封面〈今日新闻简报（修订版）〉')
  })

  it('一串 ops 按**当前**页序逐条应用（先插进来的那一页，随后就能按新页号删掉）', async () => {
    const { file } = await firstVersion()

    await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [
          { op: 'insert', after: 2, slide: { title: '插页', bullets: ['临时加的一条'] } },
          { op: 'delete', page: 3 }
        ]
      },
      'thread-1'
    )
    const after = packageOf(file)

    // 插入让"插页"占了第 3 页，紧接着删第 3 页删掉的正是它 —— 回到 7 页、页面内容与原来一致
    expect(pageNames(after)).toHaveLength(7)
    expect(pageXml(after, 3)).toContain('国内要闻')
    expect(pageXml(after, 3)).not.toContain('插页')
  })

  it('断言（expect）在改的时候照样逐条核（"第 3 页必须有这句话"）', async () => {
    await firstVersion()

    const receipt = await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [
          { op: 'replace', page: 3, slide: { title: '结论', bullets: ['政策底已现（券商）'] } }
        ],
        expect: { pages: 7, contains: [{ page: 3, text: '政策底已现（券商）' }] }
      },
      'thread-1'
    )

    expect(String(receipt)).toContain('结构校验通过')
  })
})

describe('③ 干净失败：不动盘上的文件，回人话给出口', () => {
  it('这个会话里没有源结构 → 不假装成功，指向 create_ppt', async () => {
    await expect(
      callTool(edit, { path: '没做过.pptx', ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/没有可改的源结构[\s\S]*create_ppt/)
    expect(existsSync(join(bed.root, '没做过.pptx'))).toBe(false)
  })

  it('另一条会话做的那份，这边也改不了（源结构是会话级的）', async () => {
    await firstVersion('thread-1')
    await expect(
      callTool(edit, { path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] }, 'thread-2')
    ).rejects.toThrow(/create_ppt/)
  })

  it('页号越界 / 改封面 / 排不出内容的页：一律先拦下，一个字都不写', async () => {
    const { file, entries: before } = await firstVersion()

    await expect(
      callTool(edit, { path: '今日新闻简报.pptx', ops: [{ op: 'delete', page: 9 }] }, 'thread-1')
    ).rejects.toThrow(/只有 7 页/)
    await expect(
      callTool(
        edit,
        { path: '今日新闻简报.pptx', ops: [{ op: 'replace', page: 1, slide: { title: 'X' } }] },
        'thread-1'
      )
    ).rejects.toThrow(/封面[\s\S]*meta/)
    await expect(
      callTool(
        edit,
        { path: '今日新闻简报.pptx', ops: [{ op: 'replace', page: 3, slide: {} }] },
        'thread-1'
      )
    ).rejects.toThrow(/排不出任何版式/)
    await expect(
      callTool(
        edit,
        { path: '今日新闻简报.pptx', ops: [{ op: 'insert', after: 9, slide: { title: 'X' } }] },
        'thread-1'
      )
    ).rejects.toThrow(/after 只能填/)

    // 一次都没写成
    expect(zipText(packageOf(file), 'ppt/slides/slide3.xml')).toBe(pageXml(before, 3))
  })

  it('文件被用户手改过 → 默认什么都不做，把两个口径都摆出来', async () => {
    const { file, entries: before } = await firstVersion()
    // 模拟"用户在 PowerPoint 里改完保存了"：另渲染一份内容不同的，覆盖盘上那份
    const handEdited = await renderPptx({
      ...DECK,
      slides: DECK.slides.map((slide) =>
        slide.title === '国内要闻'
          ? { ...slide, bullets: [...(slide.bullets ?? []), '用户手加的一条'] }
          : slide
      )
    })
    writeFileSync(file, handEdited.data)

    await expect(
      callTool(
        edit,
        { path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: '新版' }] },
        'thread-1'
      )
    ).rejects.toThrow(
      /已经不是上一版生成的那份了[\s\S]*ifChanged: "overwrite"[\s\S]*ifChanged: "adopt"/
    )

    // 没动过盘上那份（还是用户手改后的字节）
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(handEdited.data))
    // 手改的那一页在第 3 页（国内要闻 = slides[1]）
    expect(zipText(packageOf(file), 'ppt/slides/slide3.xml')).toContain('用户手加的一条')
    expect(zipText(packageOf(file), 'ppt/slides/slide3.xml')).not.toBe(pageXml(before, 3))

    // 以源为准覆盖：用户的手改没了，我们的源 + 这次改动生效
    const overwritten = await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [{ op: 'meta', title: '新版' }],
        ifChanged: 'overwrite'
      },
      'thread-1'
    )
    expect(String(overwritten)).toContain('以源为准覆盖')
    expect(zipText(packageOf(file), 'ppt/slides/slide3.xml')).not.toContain('用户手加的一条')
  })

  it('以文件为准（adopt）：把文件里的文字读回来当新源，再应用这次改动', async () => {
    const { file } = await firstVersion()
    const handEdited = await renderPptx({
      ...DECK,
      slides: DECK.slides.map((slide) =>
        slide.title === '国内要闻'
          ? { ...slide, bullets: [...(slide.bullets ?? []), '用户手加的一条'] }
          : slide
      )
    })
    writeFileSync(file, handEdited.data)

    const receipt = await callTool(
      edit,
      {
        path: '今日新闻简报.pptx',
        ops: [{ op: 'replace', page: 3, slide: { title: '国内要闻', bullets: ['改后的一条'] } }],
        ifChanged: 'adopt'
      },
      'thread-1'
    )
    const after = packageOf(file)

    expect(String(receipt)).toContain('以文件里的文字为准重建了源')
    expect(pageNames(after)).toHaveLength(7)
    expect(pageXml(after, 3)).toContain('改后的一条')
    // 用户手改的那一条在别的页上活了下来（第 3 页被我们换掉了，手改的那一页正是第 3 页 —— 换掉即消失，
    // 这里断言的是"重建这一步没崩，且页数没变"）
    expect(pageXml(after, 2)).toContain('宏观')
  })

  it('文件被删掉 → 默认不动手；说清选 overwrite 会重新生成', async () => {
    const { file } = await firstVersion()
    await bed.ctx.fs.remove(file, { recursive: false })
    expect(existsSync(file)).toBe(false)

    await expect(
      callTool(edit, { path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/找不到了[\s\S]*ifChanged: "overwrite"/)
    expect(existsSync(file)).toBe(false)

    const receipt = await callTool(
      edit,
      { path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }], ifChanged: 'overwrite' },
      'thread-1'
    )
    expect(existsSync(file)).toBe(true)
    expect(String(receipt)).toContain('重新生成')
  })
})

/**
 * round 76 的权限尾巴：edit_ppt 与 create_ppt **同档同表**（classify 的 TOOL_CLASSES /
 * WORKSPACE_FILE_TOOLS + guard 的 ENGINE_TARGET_TOOLS）—— 落地看的三件事：
 *   ① 写类默认问、目标工作区 full 免审（否则 `mode='full'` 的工作区里 create_ppt 免审、改同一份却弹卡）；
 *   ② 命中 (工具 × 工作区) 的"永久允许"规则免审（审批卡上那个"永久允许"对 edit_ppt 一样作数）；
 *   ③ path 解析不出去（区外）**不问**：执行层先 artifactTarget 再改，批了也不会落一个字节
 *      （③ 的"执行"半截在这里一并钉住：真调一次，读回的是"授权工作区"那句拒绝）。
 */
describe('④ 审批：与 create_ppt 同档（ask 问 / full 免审 / 规则放行 / 区外不问）', () => {
  const gate = (input: unknown): boolean =>
    (edit as { requireApproval: (input: unknown) => boolean }).requireApproval(input)

  it('ask 工作区要审批；切 full 后免审（没给 path 的派生名与显式 path 同一口径）', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(gate({ path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] })).toBe(false)
  })

  it('命中"永久允许"规则（edit_ppt × 工作区）→ 免审', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] })).toBe(true)

    bed.rules.push({ tool: 'edit_ppt', workspace: bed.root, mode: 'allow' })
    expect(gate({ path: '今日新闻简报.pptx', ops: [{ op: 'meta', title: 'X' }] })).toBe(false)
  })

  it('path 落在工作区外：不弹审批，且真执行时被拒（fail closed，批了也不会执行）', async () => {
    bed.roots[0].mode = 'ask'
    const outside = join(bed.outside, 'x.pptx')

    expect(gate({ path: outside, ops: [{ op: 'meta', title: 'X' }] })).toBe(false)
    await expect(
      callTool(edit, { path: outside, ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/授权工作区/)
    expect(existsSync(outside)).toBe(false)
  })
})
