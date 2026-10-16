// @vitest-environment node
/**
 * **真实集成（0.1.2）**：read 工具 → **默认转换器**（随包 LibreOffice，不是注入假件）→ 真旧格式夹具，
 * 外加现代 5 个格式的真件走同一个工具（合起来覆盖 read 的**全 8 格式**：
 * doc / docx / xls / xlsx / ppt / pptx / pdf / csv）。
 *
 * 与 `read-formats.spec.ts` 的分工：那个文件把转换器**注入**掉，钉的是"分派 + 文案 + 形状"；
 * 这个文件**真起引擎**，只回答四件事：
 *   ① 真文件读出来的**正文/中文/页序**对不对（不是"没报错"就算过）；
 *   ② 原件（工作区里那份 + 夹具本体）**一个字节都没动**（SHA-256 逐前逐后比）；
 *   ③ 转换用的**自建临时目录收干净了**（`kyclaw-legacy-office-*` 前后无新增残留）；
 *   ④ 旧版档的回执**明说走了转换**（"经随包 LibreOffice 转换后抽出来的内容"），不假装直读。
 *
 * 现代格式那几条是**同一工具的真件回归**（PDF 用 `main/__tests__/pdf-fixture` 的真 PDF、
 * DOCX/XLSX/PPTX 用产出侧自己的生成器、CSV 写真文件），**永远跑**（不碰引擎/夹具）；等价证据另见
 * `read.spec.ts`（PDF/Word/图片真件）与 `read-formats.spec.ts`（xlsx/pptx/csv 真件 + 旧版分派）。
 *
 * 跑法（门 = 环境变量，只卡**旧版**那条 describe；**门开着但夹具/引擎缺 → 直接失败**，不许静默 skip）：
 *   KYCLAW_LEGACY_READ_REAL=1 \
 *   KYCLAW_OFFICE_FIXTURES="E:/gitlab/kyclaw/.superpowers/office-legacy-fixtures" \
 *     pnpm exec vitest run src/mastra/tools/__tests__/read-legacy-real.spec.ts
 *
 * **不涉及真模型**：read 的文本/抽取档全在本机（只有图片档才把字节发给端点，这里一条都不读图）。
 * **宏**：本文件只断言"回执里说了宏不在转换结果里"（read.ts 的既有口径），**这不是宏执行安全的
 * 运行时证据** —— 那条证据仍缺（需要一个 AutoOpen 且副作用可观测的真文件，见夹具目录 SOURCES.md）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf } from '../../../main/__tests__/pdf-fixture'
import { renderDocx } from '../docx'
import { renderXlsx } from '../excel'
import { LEGACY_TEMP_PREFIX, legacyConverterAvailable } from '../office-legacy'
import { renderPptx } from '../ppt'
import { createReadTool } from '../read'
import { callTool, createBed, type TestBed } from './helpers'

/** 夹具目录（与 office-legacy.spec.ts 同一个约定） */
const FIXTURE_DIR =
  process.env.KYCLAW_OFFICE_FIXTURES ??
  join(resolve(__dirname, '..', '..', '..', '..'), '.superpowers', 'office-legacy-fixtures')

interface LegacyCase {
  file: string
  kind: 'doc' | 'xls' | 'ppt'
  /**
   * 断言用：这些字符串**必须按这个先后顺序**出现在回执里（页序 / 表序就靠它钉住）。
   * 全部取自夹具**正文**里的真实字符串（元数据里的 Title 之类不算正文；见 SOURCES.md 的标记表）。
   */
  ordered: readonly string[]
  /** 这一条额外的定点断言（工作表名 / 公式结果这种"顺带要看到"的东西） */
  extras?: readonly string[]
}

/** 6 个真夹具（Apache POI test-data，全部无宏；来源与哈希见 SOURCES.md） */
const CASES: readonly LegacyCase[] = [
  {
    file: 'simple.doc',
    kind: 'doc',
    // 正文就一句（`97-SR2.` 在 markdown 里会被转义成 `97\-SR2\.`，断言前先 `plain()` 还原）
    ordered: ['This is a simple file created with Word 97-SR2.']
  },
  {
    file: 'SampleDoc.doc',
    kind: 'doc',
    // 两页文档的**正文**：第 2 页那句必须排在第 1 页之后（顺序错就说明抽取把页序搞丢了）
    ordered: ['I am a test document', 'This is page 1', 'This is page two']
  },
  {
    file: 'SampleSS.xls',
    kind: 'xls',
    // 多表：第 1 张表的正文 → 第 2 张表的开头（表序）；公式那行另钉（extras）
    ordered: ['Test spreadsheet', 'This one is red', 'Start of 2nd sheet', 'Sheet 2 row 2'],
    // 表名要报出来；第 7 行的公式要写成"=公式 → 结果"（转换后仍保留公式语义）
    extras: ['工作表「First Sheet」', '工作表「Sheet Number 2」', '=SUM(A7:C7) → 13']
  },
  {
    file: 'chinese-provinces.xls',
    kind: 'xls',
    // 中文落点：整条链（BIFF → LibreOffice → OOXML → 抽取）不许掉字；顺序 = 夹具里的行序
    ordered: ['Provinces in China', '安徽省', '北京市', '重庆市'],
    extras: ['工作表「provinces」']
  },
  {
    file: 'basic_test_ppt_file.ppt',
    kind: 'ppt',
    // 页序：第 1 页标题/副题 → 第 2 页页头 → 第 2 页标题（错序就说明页被拼错了）
    ordered: [
      '第 1 页',
      'This is a test title',
      'This is a test subtitle',
      '第 2 页',
      'This is the title on page 2'
    ]
  },
  {
    file: 'next_test_ppt_file.ppt',
    kind: 'ppt',
    ordered: ['第 1 页', 'This is a test title', '第 2 页', 'This is the title on page 2']
  }
]

const ENABLED = process.env.KYCLAW_LEGACY_READ_REAL === '1'
const missingFixtures = CASES.filter((item) => !existsSync(join(FIXTURE_DIR, item.file))).map(
  (item) => item.file
)
const kitReady = legacyConverterAvailable()
const canRun = ENABLED && missingFixtures.length === 0 && kitReady

// 门开着却跑不了 → **失败**，不静默跳过（静默跳过就会被读成"验过了"）
if (ENABLED && !canRun) {
  throw new Error(
    '[read-legacy-real] 门开着但前置不满足：' +
      (missingFixtures.length > 0
        ? `缺夹具 ${missingFixtures.join('、')}（找 ${FIXTURE_DIR}）`
        : '') +
      (kitReady ? '' : ' 本机没有随包的 LibreOffice（resources/libreoffice-kit）')
  )
}

/** 工作区里那份文件的 SHA-256（读前读后各算一次） */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 引擎自建临时目录的当前残留（转换收尾该把它们清掉） */
function legacyTempLeftovers(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(LEGACY_TEMP_PREFIX))
}

/**
 * 等"本用例新增的残留"消失（最多 15 秒），返回仍残留的那些。
 *
 * 为什么要等而不是当场比：转换目录是**全局**共享的 tmpdir 前缀，同一台机器上别的 worker 文件
 * （`office-legacy.spec.ts` 的真夹具段）可能正在转换——当场比会把**别人的在途目录**算到本用例头上。
 * 真泄漏是**永久**的（收尾 `rm` 没做就是没做），所以"等到没有新增"既不会掩盖泄漏，也不受并发干扰。
 */
async function waitNoNewLeftovers(
  before: readonly string[],
  timeoutMs = 15_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const fresh = legacyTempLeftovers().filter((name) => !before.includes(name))
    if (fresh.length === 0 || Date.now() > deadline) return fresh
    await delay(200)
  }
}

/**
 * 把 markdown 的转义还原成原字面（mammoth 会把 `-` / `.` / `(` / `)` 写成 `\-` / `\.` / `\(` / `\)`）。
 * **不是**放宽断言：正文本身与夹具里逐字相同，这里去掉的只是 docx→markdown 那条路加的反斜杠。
 */
function plain(text: string): string {
  return text.replace(/\\([^A-Za-z0-9\s])/g, '$1')
}

/** 回执里是否按给定顺序出现这些字符串（顺序断言；缺一个或顺序错都返回失败说明） */
function orderedProblem(text: string, ordered: readonly string[]): string | null {
  let cursor = 0
  for (let index = 0; index < ordered.length; index += 1) {
    const marker = ordered[index]
    const at = text.indexOf(marker, cursor)
    if (at < 0) {
      return text.includes(marker)
        ? `「${marker}」出现了，但**顺序不对**（应在「${ordered[index - 1] ?? ''}」之后）`
        : `回执里找不到「${marker}」`
    }
    cursor = at + marker.length
  }
  return null
}

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe.skipIf(!canRun)('真实集成：read 工具（默认转换器）读旧版 Office 真件', () => {
  for (const item of CASES) {
    it(
      `${item.file}（${item.kind}）：正文/顺序对、原件 hash 不变、临时目录收干净`,
      { timeout: 120_000 },
      async () => {
        const fixture = join(FIXTURE_DIR, item.file)
        const fixtureHashBefore = sha256(fixture)
        // 读的是**工作区里**的副本（read 的边界仍在工作区内，与真实用法一致）
        const inside = join(bed.root, basename(item.file))
        writeFileSync(inside, readFileSync(fixture))
        const hashBefore = sha256(inside)
        const leftoversBefore = legacyTempLeftovers()

        const tool = await createReadTool(bed.ctx)
        const out = plain(String(await callTool(tool, { path: basename(item.file) })))

        // ① 正文与顺序（不是"没报错"就算过）
        const problem = orderedProblem(out, item.ordered)
        expect(problem, problem ?? '').toBeNull()
        for (const extra of item.extras ?? []) expect(out).toContain(extra)
        // 走了转换这条路（read.ts 的旧版档口径），不是假装直读
        expect(out).toContain('经随包 LibreOffice 转换后抽出来的内容')
        // ② 原件没被动过（工作区副本 + 夹具本体，两边都逐字节比）
        expect(sha256(inside)).toBe(hashBefore)
        expect(sha256(fixture)).toBe(fixtureHashBefore)
        // ③ 自建临时目录收干净了（等到"本用例新增的残留"消失；真泄漏等多久都在）
        expect(await waitNoNewLeftovers(leftoversBefore)).toEqual([])
      }
    )
  }
})

// 现代 5 格式只靠产出侧生成器（不碰引擎、不碰夹具），所以**永远跑**：它们是"全 8 格式"的另一半，
// 也是旧版链路回退时的对照。
describe('真实集成：同一工具读现代 5 格式真件（合起来 = read 全 8 格式）', () => {
  it('docx：真 Word 文件（产出侧生成器）读出 markdown 正文', { timeout: 60_000 }, async () => {
    writeFileSync(
      join(bed.root, 'modern.docx'),
      await renderDocx({
        title: '现代文档标题',
        blocks: [{ type: 'paragraph', text: '现代 Word 的正文段落' }]
      })
    )
    const tool = await createReadTool(bed.ctx)

    const out = String(await callTool(tool, { path: 'modern.docx' }))

    expect(out).toContain('现代文档标题')
    expect(out).toContain('现代 Word 的正文段落')
    expect(out).not.toContain('\uFFFD')
  })

  it('xlsx：真工作簿读出工作表内容（带表名与行号）', { timeout: 60_000 }, async () => {
    writeFileSync(
      join(bed.root, 'modern.xlsx'),
      await renderXlsx([
        {
          name: '汇总',
          rows: [
            ['月份', '金额'],
            ['1 月', 100]
          ]
        },
        { name: '明细', rows: [['第二张表的文字']] }
      ])
    )
    const tool = await createReadTool(bed.ctx)

    const out = String(await callTool(tool, { path: 'modern.xlsx' }))

    expect(out).toContain('汇总')
    expect(out).toContain('行 1: 月份 | 金额')
    expect(out).toContain('行 2: 1 月 | 100')
    expect(out).toContain('明细')
    expect(out).toContain('第二张表的文字')
    expect(out).not.toContain('\uFFFD')
  })

  it('pptx：真演示文稿逐页读（封面 + 内容页）', { timeout: 60_000 }, async () => {
    const { data } = await renderPptx({
      title: '现代演示',
      slides: [{ title: '第一页标题', bullets: ['第一条'] }, { title: '第二页标题' }]
    })
    writeFileSync(join(bed.root, 'modern.pptx'), data)
    const tool = await createReadTool(bed.ctx)

    const out = String(await callTool(tool, { path: 'modern.pptx' }))

    expect(out).toContain('第 1 页')
    expect(out).toContain('第 2 页')
    expect(out).toContain('第一页标题')
    expect(out).toContain('第二页标题')
    expect(out).not.toContain('\uFFFD')
  })

  it('pdf：真 PDF（有文字层）读出文字；扫描版如实说抽不到', { timeout: 60_000 }, async () => {
    // 夹具正文**必须是 ASCII**：`buildPdf` 的 xref 偏移按 .length 算，非 ASCII 会让偏移对不上
    // （该文件的头注写明了这条）。所以"中文 PDF"这条链**不在本文件覆盖**：中文落点由
    // 旧版 xls 那条（chinese-provinces.xls）钉住。
    writeFileSync(
      join(bed.root, 'modern.pdf'),
      buildPdf([['Modern PDF page one', 'Second line'], ['PDF page two text']])
    )
    writeFileSync(join(bed.root, 'scan.pdf'), buildPdf([[], []]))
    const tool = await createReadTool(bed.ctx)

    const out = String(await callTool(tool, { path: 'modern.pdf' }))
    expect(out).toContain('Modern PDF page one')
    expect(out).toContain('PDF page two text')
    expect(out).toContain('第 1 页')
    expect(out).toContain('第 2 页')

    const scanned = String(await callTool(tool, { path: 'scan.pdf' }))
    expect(scanned).toMatch(/文字层|抽不出/)
  })

  it('csv：真文件按表格读（行号 + 分隔），中文不掉字', { timeout: 60_000 }, async () => {
    writeFileSync(join(bed.root, 'modern.csv'), '省份,代码\n北京市,110000\n重庆市,500000\n')
    const tool = await createReadTool(bed.ctx)

    const out = String(await callTool(tool, { path: 'modern.csv' }))

    expect(out).toContain('行 1: 省份 | 代码')
    expect(out).toContain('行 2: 北京市 | 110000')
    expect(out).toContain('行 3: 重庆市 | 500000')
    expect(out).not.toContain('\uFFFD')
  })
})
