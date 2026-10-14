// @vitest-environment node
/**
 * 增量改一份已有 Word 文档（edit_docx）的聚焦用例。
 *
 * 要钉住的五件事（都是"改了以后就再也回不去"的行为）：
 *   ① **红→绿**：改一块 → 块数不变、其余块文字逐行没动、模型入参里不含其他块的完整内容；
 *   ② 四个操作各自的语义（replace / insert / delete / meta）与**块号口径**（1 起、按 create_docx
 *      的 `blocks` 顺序、标题不算一块）；
 *   ③ **干净失败**的四条：没有源结构 / 文件被手改过 / 文件被删 / 路径越界 —— 一律不动盘上的文件，
 *      回人话给出口；`adopt` 在一开始就被明确拒绝（v1 不支持，不装作支持）；
 *   ④ 改完把**新的**源结构与指纹写回去（下一次编辑在这一次的基础上改）；
 *   ⑤ 源结构登记：create 记、edit 更新；**超 2MB 不记**且回执明确说"源结构未登记，edit_docx 不可用"。
 *
 * 走的是**真链路**：真临时工作区 + 真 docx 渲染 + 真落盘，再用 `extractDocx`（产品的读侧实现：
 * mammoth → markdown，与 read 工具同一个口）与 `readZipEntries`（真解包）双向验。断言的是
 * "文件里真是那段文字"，不是"某个库自己认自己"。
 * 源结构存储在这一份里用内存假件（真 libsql 的读写见 __tests__/session-docx-sources.spec.ts）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from '../../../shared/zod'
import { extractDocx } from '../../../main/workbench-office'
import type { DocxSourceRecord, DocxSourceRecordInput } from '../../../shared/session-docx-sources'
import { sha256Of, type SessionDocxSourceStore } from '../../session-docx-sources'
import { readZipEntries } from '../artifact-check'
import { createDocxTool, renderDocx, type DocxInput } from '../docx'
import { createEditDocxTool, docxEditInputSchema } from '../docx-edit'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

const FILE = '文档/设备采购管理办法.docx'

/** 内存版源结构存储（形状与真 store 一致；这一份只看工具侧行为） */
function memorySources(): SessionDocxSourceStore {
  const rows = new Map<string, DocxSourceRecord>()
  const key = (threadId: string, path: string): string => `${threadId}\u0000${path}`
  const mine = (threadId?: string): DocxSourceRecord[] =>
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
    async record(input: DocxSourceRecordInput) {
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

/** 一份"像真任务那样"的初稿：标题 + 6 个内容块（四种块都有） */
const DOC: DocxInput = {
  title: '设备采购管理办法',
  path: FILE,
  blocks: [
    { type: 'heading', text: '第一章 总则', level: 1 },
    { type: 'paragraph', text: '为规范采购流程，制定本办法。' },
    { type: 'bullets', items: ['预算内采购由部门审批', '超预算报总经理审批'] },
    {
      type: 'table',
      headers: ['金额区间', '审批人'],
      rows: [
        ['≤1 万', '部门经理'],
        ['＞1 万', '总经理']
      ]
    },
    { type: 'heading', text: '第二章 流程', level: 1 },
    { type: 'paragraph', text: '采购申请由使用部门提交。' }
  ]
}

/** 换掉的那一块（replace/insert 用；文字与初稿不重叠，便于断言） */
const REPLACEMENT = {
  type: 'paragraph',
  text: '为规范采购流程，制定本办法（2026 修订）。'
} as const

let bed: TestBed
let sources: SessionDocxSourceStore
let create: unknown
let edit: unknown
let file: string

beforeEach(async () => {
  bed = createBed({ mode: 'full' })
  sources = memorySources()
  create = await createDocxTool(bed.ctx, { sources })
  edit = await createEditDocxTool(bed.ctx, { sources })
  file = join(bed.root, '文档', '设备采购管理办法.docx')
})

afterEach(() => {
  bed.dispose()
})

/** 真落盘一份初稿（返回当时的 markdown） */
async function firstVersion(session = 'thread-1', doc: DocxInput = DOC): Promise<string> {
  await callTool(create, doc, session)
  return await markdownOf(file)
}

/** 产品的读侧口径：.docx → markdown（与 read 工具同一口，mammoth） */
async function markdownOf(path: string): Promise<string> {
  const { markdown } = await extractDocx(readFileSync(path))
  return markdown
}

/** 源结构里记的块（JSON 读回来） */
async function storedBlocks(session = 'thread-1'): Promise<string[]> {
  const record = await sources.find(session, file)
  const parsed = JSON.parse(record?.sourceJson ?? '{}') as { blocks?: Array<{ type: string }> }
  return (parsed.blocks ?? []).map((block) => JSON.stringify(block))
}

describe('① 红→绿：改一块 = 块数不变、其余块没动、入参只含那一块', () => {
  it('replace 第 2 块：其余块的文字逐行没动，改的那块换了字', async () => {
    const before = await firstVersion()

    const ops = {
      path: FILE,
      ops: [{ op: 'replace', block: 2, content: REPLACEMENT }]
    }
    await callTool(edit, ops, 'thread-1')
    const after = await markdownOf(file)

    expect(after).toContain('为规范采购流程，制定本办法（2026 修订）。')
    expect(after).not.toContain('为规范采购流程，制定本办法。')
    // 其余块逐行没动（标题、要点、表格、第二章都还在）
    const keep = (text: string): string[] =>
      text.split('\n').filter((line) => !line.includes('为规范采购流程'))
    expect(keep(after)).toEqual(keep(before))
    expect(after).toContain('第一章 总则')
    expect(after).toContain('超预算报总经理审批')
    expect(after).toContain('采购申请由使用部门提交。')

    // 源结构里块数不变、第 2 块真的换了
    expect(await storedBlocks()).toHaveLength(DOC.blocks.length)
    expect((await storedBlocks())[1]).toContain('2026 修订')

    // **模型入参里不含其他块的完整内容**：这一改的入参只有"改哪一块 + 改成什么"，
    // 整份 blocks 数组不出现
    const incremental = JSON.stringify(docxEditInputSchema.parse(ops))
    expect(incremental).toContain('2026 修订')
    expect(incremental).not.toContain('第二章 流程')
    expect(incremental).not.toContain('超预算报总经理审批')
    expect(incremental).not.toContain('"blocks"')
  })

  it('文档越长，增量入参省得越多（同一份 20 块的文档改一块）', async () => {
    const long: DocxInput = {
      title: '长文档',
      path: FILE,
      blocks: Array.from({ length: 20 }, (_, index) => ({
        type: 'paragraph' as const,
        text: `第 ${index + 1} 段正文：${'内容'.repeat(60)}`
      }))
    }
    await firstVersion('thread-1', long)

    const op = { path: FILE, ops: [{ op: 'replace', block: 7, content: REPLACEMENT }] }
    const incremental = JSON.stringify(docxEditInputSchema.parse(op))
    const whole = JSON.stringify({ title: long.title, blocks: long.blocks })

    expect(incremental.length * 10).toBeLessThan(whole.length)
  })

  it('**两次并发编辑**：串行执行、两次改动都在（同一个目标的队列，不丢更新）', async () => {
    await firstVersion()

    // 同时发两个改同一份文件的调用（没有队列时：两边读到同一份旧源，后写的把前一次覆盖掉）
    const first = callTool(
      edit,
      { path: FILE, ops: [{ op: 'replace', block: 2, content: REPLACEMENT }] },
      'thread-1'
    )
    const second = callTool(edit, { path: FILE, ops: [{ op: 'delete', block: 6 }] }, 'thread-1')
    await Promise.all([first, second])

    const after = await markdownOf(file)
    expect(after).toContain('为规范采购流程，制定本办法（2026 修订）。')
    expect(after).not.toContain('采购申请由使用部门提交。')
    expect(await storedBlocks()).toHaveLength(5)
  })

  it('回执带"改后块序"（1 起、不含标题）+ 与 create_docx 同形的落盘回执', async () => {
    await firstVersion()

    const receipt = String(
      await callTool(edit, { path: FILE, ops: [{ op: 'delete', block: 6 }] }, 'thread-1')
    )

    expect(receipt).toContain('已覆盖')
    expect(receipt).toContain('5 个内容块')
    expect(receipt).toContain('结构校验通过')
    expect(receipt).toContain('标题〈设备采购管理办法〉')
    expect(receipt).toContain('块序（1 起，不含标题）：1 小节〈第一章 总则〉')
    expect(receipt).toContain('4 表格〈2 列 × 3 行〉')
  })

  it('改完把新的源结构与指纹写回去（下一次编辑在这一次的基础上改）', async () => {
    await firstVersion()
    await callTool(edit, { path: FILE, ops: [{ op: 'delete', block: 6 }] }, 'thread-1')

    const record = await sources.find('thread-1', file)
    expect(record?.sha256).toBe(sha256Of(readFileSync(file)))
    expect(record?.size).toBe(readFileSync(file).byteLength)
    expect(record?.blocks).toBe(5)
    expect(JSON.parse(record?.sourceJson ?? '{}').blocks).toHaveLength(5)
  })
})

describe('② 四个操作与块号口径（1 起、按 create_docx 的 blocks 顺序）', () => {
  it('insert after:2 → 新块落在第 3 块，原来的第 3 块顺延到第 4 块', async () => {
    await firstVersion()

    const receipt = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [
            { op: 'insert', after: 2, content: { type: 'paragraph', text: '插入的一段说明。' } }
          ]
        },
        'thread-1'
      )
    )
    const after = await markdownOf(file)

    expect(after).toContain('插入的一段说明。')
    expect(after.indexOf('插入的一段说明。')).toBeLessThan(after.indexOf('预算内采购由部门审批'))
    expect(receipt).toContain('3 段落〈插入的一段说明。〉')
    expect(await storedBlocks()).toHaveLength(7)
    expect((await storedBlocks())[2]).toContain('插入的一段说明。')
    expect(receipt).toContain('7 个内容块')
  })

  it('insert after:0 → 插在第一个内容块之前（标题之后）', async () => {
    await firstVersion()

    await callTool(
      edit,
      {
        path: FILE,
        ops: [
          { op: 'insert', after: 0, content: { type: 'heading', text: '修订单说明', level: 2 } }
        ]
      },
      'thread-1'
    )
    const after = await markdownOf(file)

    expect((await storedBlocks())[0]).toContain('修订单说明')
    expect(after.indexOf('修订单说明')).toBeLessThan(after.indexOf('第一章 总则'))
    // 标题还是标题（Title 段），仍在最前
    expect(after.indexOf('设备采购管理办法')).toBeLessThan(after.indexOf('修订单说明'))
  })

  it('delete block:3 → 块数减一（那一个 bullets 块的两条一起走），别的块还在', async () => {
    await firstVersion()

    await callTool(edit, { path: FILE, ops: [{ op: 'delete', block: 3 }] }, 'thread-1')
    const after = await markdownOf(file)

    // 块号是**块**不是行：bullets 那两条属于同一个块，删块 = 两条一起没
    expect(after).not.toContain('预算内采购由部门审批')
    expect(after).not.toContain('超预算报总经理审批')
    expect(after).toContain('第一章 总则')
    expect(after).toContain('第二章 流程')
    expect(after).toContain('＞1 万')
    expect(await storedBlocks()).toHaveLength(5)
  })

  it('meta：改标题（块数不变、Title 段真的换了字、空串去掉标题）', async () => {
    await firstVersion()

    await callTool(
      edit,
      { path: FILE, ops: [{ op: 'meta', title: '设备采购管理办法（修订版）' }] },
      'thread-1'
    )
    let after = await markdownOf(file)
    expect(after).toContain('设备采购管理办法（修订版）')
    expect(after).not.toContain('# 设备采购管理办法\n')
    expect(await storedBlocks()).toHaveLength(DOC.blocks.length)

    await callTool(edit, { path: FILE, ops: [{ op: 'meta', title: '' }] }, 'thread-1')
    after = await markdownOf(file)
    expect(after).not.toContain('设备采购管理办法')
    expect(after).toContain('第一章 总则')
  })

  it('一串 ops 按**当前**块序逐条应用（先插进来的那一块，随后就能按新块号删掉）', async () => {
    await firstVersion()

    await callTool(
      edit,
      {
        path: FILE,
        ops: [
          { op: 'insert', after: 1, content: { type: 'paragraph', text: '临时加的一段。' } },
          { op: 'delete', block: 2 }
        ]
      },
      'thread-1'
    )
    const after = await markdownOf(file)

    // 插入让"临时加的一段"占了第 2 块，紧接着删第 2 块删掉的正是它
    expect(after).not.toContain('临时加的一段。')
    expect(after).toContain('为规范采购流程，制定本办法。')
    expect(await storedBlocks()).toHaveLength(DOC.blocks.length)
  })

  it('删光所有内容块：块数 0（源结构能记下来），占位语义与 create 渲染器一致', async () => {
    await firstVersion()

    await callTool(
      edit,
      {
        path: FILE,
        // 每次都删"当前的第 1 块"：块号是**当前**块序，不是固定编号
        ops: Array.from({ length: 6 }, () => ({ op: 'delete' as const, block: 1 }))
      },
      'thread-1'
    )

    expect(await storedBlocks()).toHaveLength(0)
    // 只剩标题（渲染器的占位段只在"标题与正文都没有"时才补）
    expect(await markdownOf(file)).toBe('# 设备采购管理办法')

    await callTool(edit, { path: FILE, ops: [{ op: 'meta', title: '' }] }, 'thread-1')
    expect(await markdownOf(file)).toBe('（这份文档没有内容）')
  })

  it('断言（expect）在改的时候照样逐条核（"正文里必须有这句话"）', async () => {
    await firstVersion()

    const receipt = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [{ op: 'replace', block: 2, content: REPLACEMENT }],
          expect: { contains: [{ text: '（2026 修订）' }] }
        },
        'thread-1'
      )
    )
    expect(receipt).toContain('结构校验通过')

    const missed = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [{ op: 'meta', title: '换标题' }],
          expect: { contains: [{ text: '这句不在文档里' }] }
        },
        'thread-1'
      )
    )
    expect(missed).toContain('断言：正文必须含「这句不在文档里」')
    expect(missed).toContain('word/document.xml')
  })
})

describe('③ 干净失败：不动盘上的文件，回人话给出口', () => {
  it('这个会话里没有源结构 → 不假装成功，指向 create_docx（并列出会话里有的那几份）', async () => {
    await expect(
      callTool(edit, { path: '没做过.docx', ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/没有可改的源结构[\s\S]*create_docx/)
    expect(existsSync(join(bed.root, '没做过.docx'))).toBe(false)

    // 这条会话里做过另一份时，失败回执把它列出来（模型多半只是文件名写歪了）
    await firstVersion()
    await expect(
      callTool(edit, { path: '别的.docx', ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/记着源结构的是：[\s\S]*设备采购管理办法\.docx/)
  })

  it('另一条会话做的那份，这边也改不了（源结构是会话级的）', async () => {
    await firstVersion('thread-1')
    await expect(
      callTool(edit, { path: FILE, ops: [{ op: 'meta', title: 'X' }] }, 'thread-2')
    ).rejects.toThrow(/create_docx/)
  })

  it('块号越界 / after 越界：一律先拦下，一个字都不写', async () => {
    await firstVersion()
    const before = readFileSync(file)

    await expect(
      callTool(
        edit,
        { path: FILE, ops: [{ op: 'replace', block: 7, content: REPLACEMENT }] },
        'thread-1'
      )
    ).rejects.toThrow(/只有 6 个内容块/)
    await expect(
      callTool(
        edit,
        {
          path: FILE,
          ops: [{ op: 'insert', after: 7, content: { type: 'paragraph', text: '越界' } }]
        },
        'thread-1'
      )
    ).rejects.toThrow(/after 只能填 0（插到第一个内容块之前）到 6/)

    // 块号 0 / 负数在 **schema 层**就挡下了（执行体根本不跑）
    expect(
      docxEditInputSchema.safeParse({ path: FILE, ops: [{ op: 'delete', block: 0 }] }).success
    ).toBe(false)
    const rejected = (await callTool(
      edit,
      { path: FILE, ops: [{ op: 'delete', block: 0 }] },
      'thread-1'
    )) as { error?: unknown }
    expect(rejected.error).toBe(true)

    // 一次都没写成（盘上那份的字节一个没变，源结构也没动）
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(before))
    expect(await storedBlocks()).toHaveLength(DOC.blocks.length)
  })

  it('after 的边界值合法：after:6（最后一块之后）能追加', async () => {
    await firstVersion()

    await callTool(
      edit,
      {
        path: FILE,
        ops: [{ op: 'insert', after: 6, content: { type: 'paragraph', text: '追加的收尾段。' } }]
      },
      'thread-1'
    )

    expect(await storedBlocks()).toHaveLength(7)
    expect((await storedBlocks())[6]).toContain('追加的收尾段。')
  })

  it('文件被用户手改过 → 默认什么都不做，把出口摆出来（adopt 明说不支持）', async () => {
    await firstVersion()
    // 模拟"用户在 Word 里改完保存了"：另渲染一份内容不同的，覆盖盘上那份
    const handEdited = await renderDocx({
      title: DOC.title,
      blocks: [...DOC.blocks, { type: 'paragraph', text: '用户手加的一段。' }]
    })
    writeFileSync(file, handEdited)

    await expect(
      callTool(edit, { path: FILE, ops: [{ op: 'meta', title: '新版' }] }, 'thread-1')
    ).rejects.toThrow(/已经不是上一版生成的那份了[\s\S]*ifChanged: "overwrite"/)

    // 没动过盘上那份（还是用户手改后的字节）
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(handEdited))
    expect(await markdownOf(file)).toContain('用户手加的一段。')

    // 以源为准覆盖：用户的手改没了，我们的源 + 这次改动生效
    const overwritten = String(
      await callTool(
        edit,
        { path: FILE, ops: [{ op: 'meta', title: '新版' }], ifChanged: 'overwrite' },
        'thread-1'
      )
    )
    expect(overwritten).toContain('以源为准覆盖')
    const after = await markdownOf(file)
    expect(after).toContain('新版')
    expect(after).not.toContain('用户手加的一段。')
  })

  it('指纹按 sha256 + 字节数一起判：**同大小不同内容**也算被改过', async () => {
    await firstVersion()
    const record = await sources.find('thread-1', file)
    const bytes = readFileSync(file)
    // 造一份"长度一样、内容不同"的文件（改了 sha256 但没改 size）
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 5] = tampered[tampered.length - 5] === 0x20 ? 0x21 : 0x20
    writeFileSync(file, tampered)
    expect(tampered.byteLength).toBe(record?.size)

    await expect(
      callTool(edit, { path: FILE, ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/已经不是上一版生成的那份了/)
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(tampered))
  })

  it('adopt 明确拒绝（文件没被改过也拒：不装作这一档可用）', async () => {
    await firstVersion()
    const before = readFileSync(file)

    await expect(
      callTool(
        edit,
        { path: FILE, ops: [{ op: 'meta', title: 'X' }], ifChanged: 'adopt' },
        'thread-1'
      )
    ).rejects.toThrow(/不支持 ifChanged: "adopt"[\s\S]*overwrite[\s\S]*create_docx/)

    // 一字未改
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(before))
    expect(await markdownOf(file)).toContain('第一章 总则')
  })

  it('文件被删掉 → 默认不动手；选 overwrite 才按记的源重新生成', async () => {
    await firstVersion()
    await bed.ctx.fs.remove(file, { recursive: false })
    expect(existsSync(file)).toBe(false)

    await expect(
      callTool(edit, { path: FILE, ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/找不到了[\s\S]*ifChanged: "overwrite"/)
    expect(existsSync(file)).toBe(false)

    const receipt = String(
      await callTool(
        edit,
        { path: FILE, ops: [{ op: 'meta', title: 'X' }], ifChanged: 'overwrite' },
        'thread-1'
      )
    )
    expect(existsSync(file)).toBe(true)
    expect(receipt).toContain('重新生成')
    expect(receipt).toContain('已创建')
    expect(await markdownOf(file)).toContain('第一章 总则')
  })

  it('路径落在工作区外：执行前就被拒（fail closed，一个字节都不写）', async () => {
    await firstVersion()
    const outside = join(bed.outside, 'x.docx')

    await expect(
      callTool(edit, { path: outside, ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/授权工作区/)
    expect(existsSync(outside)).toBe(false)
  })

  it('本部署没挂源结构存储 → 回人话（不是"工具不存在"）', async () => {
    const bare = await createEditDocxTool(bed.ctx)
    await expect(
      callTool(bare, { path: FILE, ops: [{ op: 'meta', title: 'X' }] }, 'thread-1')
    ).rejects.toThrow(/没有挂 Word 源结构存储[\s\S]*create_docx/)
  })
})

describe('④ 源结构登记：create 记、edit 更新、超限不记且回执如实说', () => {
  it('create_docx 记下源结构与指纹（源结构能 JSON parse，指纹与盘上那份一致）', async () => {
    await firstVersion()
    const record = await sources.find('thread-1', file)

    expect(record).not.toBeNull()
    expect(record?.blocks).toBe(DOC.blocks.length)
    expect(record?.sha256).toBe(sha256Of(readFileSync(file)))
    expect(record?.size).toBe(readFileSync(file).byteLength)
    // 源结构里**没有** path / expect（那两项是"这一次调用"的事，不是文档本身）
    const source = JSON.parse(record?.sourceJson ?? '{}') as Record<string, unknown>
    expect(Object.keys(source).sort()).toEqual(['blocks', 'title'])
    expect(source.title).toBe(DOC.title)
  })

  it('源结构超过 2MB：不记录，create 回执明确说"源结构未登记，edit_docx 不可用"', async () => {
    const huge: DocxInput = {
      title: '超长文档',
      path: '文档/超长.docx',
      // 40 块 × 2 万字中文 ≈ 2.4MB（UTF-8 下每字 3 字节）→ 超过 2MB 上限
      blocks: Array.from({ length: 40 }, () => ({
        type: 'paragraph' as const,
        text: '测'.repeat(20_000)
      }))
    }
    const receipt = String(await callTool(create, huge, 'thread-1'))

    expect(receipt).toContain('40 个内容块')
    expect(receipt).toContain('源结构未登记（超过 2MB 记不下），edit_docx 不可用')
    expect(await sources.find('thread-1', join(bed.root, '文档', '超长.docx'))).toBeNull()
    // 文档本身照常落盘（记不上不影响这次产出）
    expect(existsSync(join(bed.root, '文档', '超长.docx'))).toBe(true)
  })

  it('写库失败：不撤销已落盘的文档，但回执如实说 edit_docx 不可用', async () => {
    const broken = await createDocxTool(bed.ctx, {
      sources: {
        record: async () => {
          throw new Error('libsql 挂了')
        }
      }
    })
    const receipt = String(await callTool(broken, DOC, 'thread-1'))

    expect(receipt).toContain('已创建')
    expect(receipt).toContain('源结构未登记（本地库写入失败），edit_docx 不可用')
    expect(existsSync(file)).toBe(true)
  })
})

/**
 * 权限尾巴：edit_docx 与 create_docx **同档同表**（classify 的 TOOL_CLASSES /
 * WORKSPACE_FILE_TOOLS + guard 的 ENGINE_TARGET_TOOLS）—— 落地看的三件事：
 *   ① 写类默认问、目标工作区 full 免审；
 *   ② 命中 (工具 × 工作区) 的"永久允许"规则免审；
 *   ③ path 解析不出去（区外）**不问**：执行层先 artifactTarget 再改，批了也不会落一个字节。
 */
describe('⑤ 审批：与 create_docx 同档（ask 问 / full 免审 / 规则放行 / 区外不问）', () => {
  const gate = (input: unknown): boolean =>
    (edit as { requireApproval: (input: unknown) => boolean }).requireApproval(input)

  it('ask 工作区要审批；切 full 后免审', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: FILE, ops: [{ op: 'meta', title: 'X' }] })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(gate({ path: FILE, ops: [{ op: 'meta', title: 'X' }] })).toBe(false)
  })

  it('命中"永久允许"规则（edit_docx × 工作区）→ 免审', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: FILE, ops: [{ op: 'meta', title: 'X' }] })).toBe(true)

    bed.rules.push({ tool: 'edit_docx', workspace: bed.root, mode: 'allow' })
    expect(gate({ path: FILE, ops: [{ op: 'meta', title: 'X' }] })).toBe(false)
  })

  it('path 落在工作区外：不弹审批（执行会 fail closed）', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: join(bed.outside, 'x.docx'), ops: [{ op: 'meta', title: 'X' }] })).toBe(
      false
    )
  })
})

describe('⑥ 真解包看一眼：容器结构仍是规矩的 docx（不是"库自己认自己"）', () => {
  it('改完之后 word/document.xml 里是新内容，包结构自检通过', async () => {
    await firstVersion()
    await callTool(
      edit,
      { path: FILE, ops: [{ op: 'replace', block: 2, content: REPLACEMENT }] },
      'thread-1'
    )

    const entries = readZipEntries(readFileSync(file))
    const document = zipText(entries, 'word/document.xml')
    expect(document).toContain('2026 修订')
    expect(document).not.toContain('制定本办法。')
    expect(entries.has('[Content_Types].xml')).toBe(true)
    expect(entries.has('_rels/.rels')).toBe(true)
  })
})

/**
 * 入参形状是**接线的一部分**：模型要按 schema 生成 JSON，顶层是 `oneOf` / 顶层是数组这类形状
 * 会让结构化输出直接失败（工具压根不会被调）。所以这里把"顶层 object + ops 是数组"钉住 ——
 * 将来谁把顶层改成 `z.union` 或把 ops 展开成顶层字段，这一条会红。
 */
describe('⑦ 入参形状：顶层 object + ops 数组（模型按它生成 JSON）', () => {
  it('json schema 顶层是 object，path/ops 必填，ops 是数组（每个元素是一个 op 对象）', () => {
    const json = z.toJSONSchema(docxEditInputSchema) as {
      type?: string
      required?: string[]
      properties?: Record<string, { type?: string; items?: { oneOf?: unknown[] } }>
    }

    expect(json.type).toBe('object')
    expect(json.required).toEqual(expect.arrayContaining(['path', 'ops']))
    expect(json.properties?.ops?.type).toBe('array')
    expect(json.properties?.ops?.items?.oneOf?.length).toBe(4)
  })
})
