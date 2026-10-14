// @vitest-environment node
/**
 * R79 探针：**增量改 Word 文档**的真产物（真渲染、真落盘、真读回）。
 *
 * 聚焦用例（docx-edit.spec.ts / docx-edit-agent.spec.ts）钉的是行为；这一份生成**看得见的证据**：
 * 一条真实的编辑链走完，每一版的 .docx 都留在
 * `.superpowers/office-incremental/docx/`（本地，不入库），并用产品自己的读侧两条路验一遍：
 *   - `extractDocx`（read 工具/预览用的 mammoth → markdown）：**人读得出来的内容对不对**；
 *   - `readZipEntries`（自研解包 + CRC）：**容器本身是不是规矩的 OOXML**。
 *
 * 用法（约 2 秒，不花钱、不联网）：
 *   KYCLAW_R79_DOCX_PROBE=1 pnpm exec vitest run src/mastra/tools/__tests__/_r79-docx-edit-real.spec.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractDocx } from '../../../main/workbench-office'
import { sha256Of, type SessionDocxSourceStore } from '../../session-docx-sources'
import { createDocxTool, renderDocx, type DocxInput } from '../docx'
import { createEditDocxTool } from '../docx-edit'
import { readZipEntries } from '../artifact-check'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

const enabled = process.env.KYCLAW_R79_DOCX_PROBE === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'office-incremental', 'docx')

/** 内存版源结构存储（真 libsql 那一版由 session-docx-sources.spec.ts 钉；这里只看产物） */
function memorySources(): SessionDocxSourceStore {
  const rows = new Map<
    string,
    {
      threadId: string
      path: string
      sourceJson: string
      blocks: number
      sha256: string
      size: number
      updatedAt: string
    }
  >()
  const key = (threadId: string, path: string): string => `${threadId}\u0000${path}`
  return {
    async ensureTable() {
      // 内存假件：没有表要建
    },
    async find(threadId, path) {
      return rows.get(key(threadId, path)) ?? null
    },
    async record(input) {
      rows.set(key(input.threadId, input.path), { ...input, updatedAt: new Date().toISOString() })
    },
    async clear(threadId, path) {
      for (const row of [...rows.values()]) {
        if (row.threadId !== threadId) continue
        if (path !== undefined && row.path !== path) continue
        rows.delete(key(row.threadId, row.path))
      }
    },
    async list(threadId) {
      return [...rows.values()].filter((row) => threadId === undefined || row.threadId === threadId)
    }
  }
}

let bed: TestBed
let create: unknown
let edit: unknown
let file: string
let sources: SessionDocxSourceStore

const FILE = '文档/设备采购管理办法.docx'

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

async function markdownOf(path: string): Promise<string> {
  const { markdown } = await extractDocx(readFileSync(path))
  return markdown
}

/** 每一版都留一份到证据目录（文件名带序号，便于人工按顺序打开看） */
function keep(name: string): string {
  const target = join(evidenceDir, name)
  copyFileSync(file, target)
  console.log(`[r79] 留档 ${target}`)
  return target
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true })
  bed = createBed({ mode: 'full' })
  sources = memorySources()
  create = await createDocxTool(bed.ctx, { sources })
  edit = await createEditDocxTool(bed.ctx, { sources })
  file = join(bed.root, '文档', '设备采购管理办法.docx')
})

afterAll(() => {
  bed.dispose()
})

describe.skipIf(!enabled)('R79：增量改 Word 的真实产物', () => {
  it('初稿 → replace → insert/delete → meta → ifChanged:overwrite 全链留档并逐版验内容', async () => {
    // ① 初稿（create_docx）
    const first = String(await callTool(create, DOC, 'probe'))
    expect(first).toContain('已创建')
    const v1 = keep('01-初稿.docx')
    expect(await markdownOf(v1)).toContain('为规范采购流程，制定本办法。')
    // 源结构登记了（指纹与盘上那份一致）
    expect((await sources.find('probe', file))?.sha256).toBe(sha256Of(readFileSync(file)))

    // ② replace：第 2 块换成修订后的说法
    const replaced = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [
            {
              op: 'replace',
              block: 2,
              content: { type: 'paragraph', text: '为规范采购流程，制定本办法（2026 修订）。' }
            }
          ],
          expect: { contains: [{ text: '（2026 修订）' }] }
        },
        'probe'
      )
    )
    expect(replaced).toContain('结构校验通过')
    const v2 = keep('02-replace-第2块.docx')
    const v2text = await markdownOf(v2)
    expect(v2text).toContain('为规范采购流程，制定本办法（2026 修订）。')
    expect(v2text).not.toContain('为规范采购流程，制定本办法。')

    // ③ insert（第 2 块之后插一节）+ delete（删掉要点那一块）
    await callTool(
      edit,
      {
        path: FILE,
        ops: [
          { op: 'insert', after: 2, content: { type: 'heading', text: '第三章 验收', level: 1 } },
          {
            op: 'insert',
            after: 3,
            content: { type: 'paragraph', text: '验收由使用部门与资产管理部共同签字。' }
          },
          // 块号按**当前**块序算：插完这两块之后，第 5 块才是原来那组要点
          { op: 'delete', block: 5 }
        ]
      },
      'probe'
    )
    const v3 = keep('03-insert-delete.docx')
    const v3text = await markdownOf(v3)
    expect(v3text).toContain('第三章 验收')
    expect(v3text).toContain('验收由使用部门与资产管理部共同签字。')
    expect(v3text).not.toContain('预算内采购由部门审批')

    // ④ meta：改标题
    await callTool(
      edit,
      { path: FILE, ops: [{ op: 'meta', title: '设备采购管理办法（修订版）' }] },
      'probe'
    )
    const v4 = keep('04-meta-标题.docx')
    const v4text = await markdownOf(v4)
    expect(v4text).toContain('# 设备采购管理办法（修订版）')
    expect(v4text).toContain('第三章 验收')

    // ⑤ 手改（模拟用户在 Word 里另存了一份）→ 默认 stop 不动盘，overwrite 以源为准覆盖
    const handEdited = await renderDocx({
      title: '设备采购管理办法（修订版）',
      blocks: [...DOC.blocks, { type: 'paragraph', text: '用户手加的一段（会被覆盖掉）。' }]
    })
    writeFileSync(file, handEdited)
    await expect(
      callTool(edit, { path: FILE, ops: [{ op: 'meta', title: 'X' }] }, 'probe')
    ).rejects.toThrow(/已经不是上一版生成的那份了/)
    expect(sha256Of(readFileSync(file))).toBe(sha256Of(handEdited))

    await callTool(
      edit,
      {
        path: FILE,
        ops: [{ op: 'meta', title: '设备采购管理办法（2027 版）' }],
        ifChanged: 'overwrite'
      },
      'probe'
    )
    const v5 = keep('05-手改后覆盖.docx')
    const v5text = await markdownOf(v5)
    expect(v5text).toContain('# 设备采购管理办法（2027 版）')
    expect(v5text).not.toContain('用户手加的一段')

    // ⑥ 容器本身：真解包看要害部件与正文
    const entries = readZipEntries(readFileSync(file))
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      expect(entries.has(name), `包里缺 ${name}`).toBe(true)
    }
    const document = zipText(entries, 'word/document.xml')
    expect(document).toContain('第三章 验收')
    expect(document).toContain('2027 版')

    console.log(`[r79] 每一版都留了档：${evidenceDir}`)
    console.log(`[r79] 最后一份的指纹 sha256=${sha256Of(readFileSync(file)).slice(0, 12)}…`)
    console.log(`[r79] 源结构里的块数=${(await sources.find('probe', file))?.blocks}`)
  }, 60_000)
})
