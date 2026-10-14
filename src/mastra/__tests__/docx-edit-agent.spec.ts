// @vitest-environment node
/**
 * **增量改 Word 文档**这条链在真 agent 上跑通（真 agent 服务 + 真 chatRoute + 真 docx 渲染 +
 * 真 libsql 源结构表），模型是脚本化的（这一份不花钱、只钉装配与行为）。
 *
 * 要证明的三件事 —— 每一件都只有在"装配真接上了"时才会绿（缺哪一段接线这里就红哪一条）：
 *   ① 第一轮 `create_docx` 落盘后，**这份文档的源结构真的进了库**（换一个 store 实例从同一个库文件
 *      里读得回来 = 重启后也认得它）；
 *   ② 第二轮 `edit_docx` 只发改动就改对了：块数不变、改的那块换了字、别的块没动；
 *   ③ 改完**源结构跟着更新**（块数、指纹都换成新版），第三轮还能在这个基础上继续改。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { extractDocx } from '../../main/workbench-office'
import { settingsPath, updateSettings } from '../../main/settings'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { createSessionDocxSourceStore, sha256Of } from '../session-docx-sources'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

function toolCallScript(id: string, name: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName: name },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: name, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

function toolOutputText(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === 'tool-output-available')
    .map((part) => (typeof part.output === 'string' ? part.output : JSON.stringify(part.output)))
    .join('\n')
}

function mockModel(scripts: Array<() => StreamPart[]>, id: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: id,
    modelId: id,
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })
}

/** 第一轮的整份初稿（标题 + 6 块）—— 编辑时只发改动 */
const DOC = {
  title: '设备采购管理办法',
  path: '设备采购管理办法.docx',
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

/** 第二轮的改动：只有第 2 块 + 一次标题（回执要能对块号） */
const EDIT = {
  path: '设备采购管理办法.docx',
  ops: [
    {
      op: 'replace',
      block: 2,
      content: { type: 'paragraph', text: '为规范采购流程，制定本办法（2026 修订）。' }
    },
    { op: 'meta', title: '设备采购管理办法（修订版）' }
  ]
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
let readerStorage: LibSQLStore | undefined

/** 另一个只在测试里用的读连接（**只读**，不 clear）：换一个 store 实例从同一个库文件读，
 *  就等于"应用重启后再认一次这份文档的源结构"。 */
function readStore(): ReturnType<typeof createSessionDocxSourceStore> {
  readerStorage ??= new LibSQLStore({
    id: 'kyclaw-docx-edit-agent-read',
    url: `file:${join(dir, 'kyclaw.db').split('\\').join('/')}`
  })
  return createSessionDocxSourceStore(readerStorage)
}

function user(id: string, text: string): Record<string, unknown> {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

async function runTurn(
  threadId: string,
  call: { id: string; name: string; input: unknown }
): Promise<Array<Record<string, unknown>>> {
  scripts.push(() => toolCallScript(call.id, call.name, call.input))
  scripts.push(() => textScript('好，处理完了。'))
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [user(`u-${call.id}`, '写一份采购管理办法')],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

async function markdownOf(file: string): Promise<string> {
  const { markdown } = await extractDocx(readFileSync(file))
  return markdown
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-docx-edit-agent-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  // full 档：产出物免审，一轮就能跑到落盘（本 spec 不看审批，只看"改一块"这条链）
  updateSettings(settingsPath(dir), { workspaces: [{ path: workspace, mode: 'full' }] })

  server = await startAgentServer({
    dataDir: dir,
    model: mockModel(scripts, 'kyclaw-docx-edit-mock')
  })
}, 60_000)

afterAll(async () => {
  await readerStorage?.close().catch(() => {})
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('create_docx 记源结构 → edit_docx 只发改动改一块', () => {
  const threadId = 'thread-docx-edit-agent'
  const file = (): string => join(workspace, '设备采购管理办法.docx')

  it('第一轮：create_docx 落盘，并把源结构写进会话级表', async () => {
    scripts.length = 0
    const parts = await runTurn(threadId, { id: 'c-1', name: 'create_docx', input: DOC })
    const output = toolOutputText(parts)

    expect(output).toContain('已创建')
    expect(output).toContain('6 个内容块')
    expect(await markdownOf(file())).toContain('为规范采购流程，制定本办法。')

    // 库里的源结构：换一个 store 实例从同一个库文件读（= 应用重启后仍然认得这一份）
    const record = await readStore().find(threadId, file())
    expect(record).not.toBeNull()
    expect(record?.sha256).toBe(sha256Of(readFileSync(file())))
    expect(record?.blocks).toBe(6)
    const source = JSON.parse(record?.sourceJson ?? '{}') as Record<string, unknown>
    expect(Object.keys(source).sort()).toEqual(['blocks', 'title'])
    expect((source.blocks as unknown[]).length).toBe(6)
  }, 60_000)

  it('第二轮：edit_docx 改第 2 块 + 标题 —— 块数不变、只有那两块变了、回执带改后块序', async () => {
    const before = await markdownOf(file())
    scripts.length = 0
    const parts = await runTurn(threadId, { id: 'c-2', name: 'edit_docx', input: EDIT })
    const output = toolOutputText(parts)
    const after = await markdownOf(file())

    expect(after).toContain('为规范采购流程，制定本办法（2026 修订）。')
    expect(after).toContain('设备采购管理办法（修订版）')
    expect(after).not.toContain('为规范采购流程，制定本办法。')
    // 别的块逐行没动（改的是第 2 块，标题也换了 → 这两处不参与比较）
    const keep = (text: string): string[] =>
      text
        .split('\n')
        .filter((line) => !line.includes('为规范采购流程') && !line.includes('设备采购管理办法'))
    expect(keep(after)).toEqual(keep(before))

    // 回执：与 create_docx 同形 + 改后块序（模型靠它确认"第 2 块"是哪一块）
    expect(output).toContain('已覆盖')
    expect(output).toContain('6 个内容块')
    expect(output).toContain('标题〈设备采购管理办法（修订版）〉')
    expect(output).toContain('块序（1 起，不含标题）：1 小节〈第一章 总则〉')
    expect(output).toContain('2 段落〈为规范采购流程，制定本办法（20')
    expect(output).toContain('结构校验通过')

    // 模型这一轮的入参**只有改的那一块**，别的块一个字都没发
    const incremental = JSON.stringify(EDIT)
    expect(incremental).not.toContain('超预算报总经理审批')
    expect(incremental).not.toContain('第二章 流程')
  }, 60_000)

  it('第三轮：上一版改完的源结构已经在库里（块数/指纹都更新了），接着删一块', async () => {
    const record = await readStore().find(threadId, file())
    expect(record?.sha256).toBe(sha256Of(readFileSync(file())))
    expect(record?.blocks).toBe(6)

    scripts.length = 0
    await runTurn(threadId, {
      id: 'c-3',
      name: 'edit_docx',
      input: { path: '设备采购管理办法.docx', ops: [{ op: 'delete', block: 3 }] }
    })

    const after = await markdownOf(file())
    expect(after).not.toContain('预算内采购由部门审批')
    expect(after).toContain('第二章 流程')
    expect((await readStore().find(threadId, file()))?.blocks).toBe(5)
  }, 60_000)
})
