// @vitest-environment node
/**
 * round 76：**增量改产出物**这条链在真 agent 上跑通（真 agent 服务 + 真 chatRoute + 真 pptx 渲染 +
 * 真 libsql 源结构表），模型是脚本化的（这一份不花钱、只钉装配与行为）。
 *
 * 要证明的是三件事 —— 每一件都只有在"装配真接上了"时才会绿：
 *   ① 第一轮 `create_ppt` 落盘后，**这份 deck 的源结构真的进了库**（换一个 store 实例从同一个库文件里
 *      读得回来 = 重启后也认得它）；
 *   ② 第二轮 `edit_ppt` 只发改动就改对了：页数不变、**只有第 3 页的 slide XML 变了**；
 *   ③ 改完**源结构跟着更新**（页数、指纹都换成新版），第三轮还能在这个基础上继续改。
 *
 * 真模型下的 token/成本 before/after 见 `src/main/agent/__tests__/_r76-real.spec.ts`（那是花钱的探针）。
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { settingsPath, updateSettings } from '../../main/settings'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { createSessionPptSourceStore, sha256Of } from '../session-ppt-sources'
import { readZipEntries } from '../tools/artifact-check'
import { zipText } from '../tools/__tests__/zip'

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

/** 第一轮的整份初稿（7 页：封面 + 6 页）—— 编辑时只发改动 */
const DECK = {
  title: '今日新闻简报',
  subtitle: '2026-10-13 每日要闻',
  slides: [
    { section: '宏观' },
    {
      title: '国内要闻',
      bullets: ['PSL 利率下调 0.25 个百分点（央行）', '专项债发行提速（财政部）']
    },
    {
      title: '关键指标',
      stats: [{ value: '182.3 万辆', label: '9 月新能源车销量（同比 +13.6%）' }]
    },
    { title: '海外动态', bullets: ['美联储会议纪要显示分歧（新华社）'] },
    { title: '一句话', quote: { text: '政策底已现，剩下的看执行。', source: '—— 券商晨会纪要' } },
    { title: '下一步', bullets: ['关注 10 月 15 日三季度 GDP（国家统计局）'] }
  ]
}

/** 第二轮的改动：只有第 3 页 + 一次封面标题（回执要能对页码） */
const EDIT = {
  path: '今日新闻简报.pptx',
  ops: [
    {
      op: 'replace',
      page: 3,
      slide: {
        title: '国内要闻（核实后）',
        bullets: ['PSL 利率下调 0.25 个百分点（央行 10-13 确认）']
      }
    }
  ]
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

/**
 * 另一个只在测试里用的读连接（**只读**，不 clear）：换一个 store 实例从同一个库文件读，
 * 就等于"应用重启后再认一次这份 deck 的源结构"。
 */
let readerStorage: LibSQLStore | undefined

function readStore(): ReturnType<typeof createSessionPptSourceStore> {
  readerStorage ??= new LibSQLStore({
    id: 'kyclaw-ppt-edit-agent-read',
    url: `file:${join(dir, 'kyclaw.db').split('\\').join('/')}`
  })
  return createSessionPptSourceStore(readerStorage)
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
      messages: [user(`u-${call.id}`, '做一份简报 PPT')],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/

function packageOf(file: string): Map<string, Buffer> {
  return readZipEntries(readFileSync(file))
}

function pageNames(entries: Map<string, Buffer>): string[] {
  return [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort(
      (left, right) =>
        Number(/slide(\d+)\.xml$/.exec(left)?.[1]) - Number(/slide(\d+)\.xml$/.exec(right)?.[1])
    )
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-ppt-edit-agent-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  // full 档：产出物免审，一轮就能跑到落盘（本 spec 不看审批，只看"改一页"这条链）
  updateSettings(settingsPath(dir), { workspaces: [{ path: workspace, mode: 'full' }] })

  server = await startAgentServer({
    dataDir: dir,
    model: mockModel(scripts, 'kyclaw-ppt-edit-mock')
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

describe('create_ppt 记源结构 → edit_ppt 只发改动改一页', () => {
  const threadId = 'thread-edit-agent'
  const file = (): string => join(workspace, '今日新闻简报.pptx')

  it('第一轮：create_ppt 落盘，并把源结构写进会话级表', async () => {
    scripts.length = 0
    await runTurn(threadId, { id: 'c-1', name: 'create_ppt', input: DECK })

    const before = packageOf(file())
    expect(pageNames(before)).toHaveLength(7)

    // 库里的源结构：换一个 store 实例从同一个库文件读（= 应用重启后仍然认得这一份）
    const record = await readStore().find(threadId, file())
    expect(record).not.toBeNull()
    expect(record?.sha256).toBe(sha256Of(readFileSync(file())))
    expect(record?.pages).toBe(7)
    expect(JSON.parse(record?.sourceJson ?? '{}').slides).toHaveLength(6)
  }, 60_000)

  it('第二轮：edit_ppt 替换第 3 页 —— 页数不变、只有第 3 页变了、回执带改后页序', async () => {
    const before = packageOf(file())
    scripts.length = 0
    const parts = await runTurn(threadId, { id: 'c-2', name: 'edit_ppt', input: EDIT })
    const after = packageOf(file())
    const output = toolOutputText(parts)

    expect(pageNames(after)).toEqual(pageNames(before))
    for (const name of pageNames(before)) {
      if (name === 'ppt/slides/slide3.xml') continue
      expect(zipText(after, name)).toBe(zipText(before, name))
    }
    expect(zipText(after, 'ppt/slides/slide3.xml')).toContain('国内要闻（核实后）')
    expect(zipText(after, 'ppt/slides/slide3.xml')).not.toBe(
      zipText(before, 'ppt/slides/slide3.xml')
    )

    // 回执：与 create_ppt 同形 + 改后页序（模型靠它确认"第 3 页"是哪一页）
    expect(output).toContain('已覆盖')
    expect(output).toContain('7 页演示文稿')
    expect(output).toContain(
      '改后页序：1 封面〈今日新闻简报〉｜2 章节〈宏观〉｜3 要点〈国内要闻（核实后）〉'
    )
    expect(output).toContain('结构校验通过')

    // 模型这一轮的入参**只有那一页**，整份 deck 的别页内容一個字都没发
    const incremental = JSON.stringify(EDIT)
    expect(incremental).not.toContain('海外动态')
    expect(incremental.length * 3).toBeLessThan(JSON.stringify(DECK).length)
  }, 60_000)

  it('第三轮：上一版改完的源结构已经在库里（页数/指纹都更新了），接着改第 4 页', async () => {
    const record = await readStore().find(threadId, file())
    expect(record?.sha256).toBe(sha256Of(readFileSync(file())))
    expect(record?.pages).toBe(7)

    scripts.length = 0
    await runTurn(threadId, {
      id: 'c-3',
      name: 'edit_ppt',
      input: {
        path: '今日新闻简报.pptx',
        ops: [{ op: 'delete', page: 4 }]
      }
    })

    const after = packageOf(file())
    expect(pageNames(after)).toHaveLength(6)
    // 删掉的是原来的"关键指标"那一页
    expect(zipText(after, 'ppt/slides/slide4.xml')).toContain('海外动态')
  }, 60_000)
})
