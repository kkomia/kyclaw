// @vitest-environment node
/**
 * 产出物工具的**真服务链路**用例（模块 4）：真 mastra server + 真工具 + stub 模型 + 真 SSE。
 *
 * 工具单测（tools/__tests__/artifacts-tools.spec.ts）钉的是"工具自己"；这里钉的是**装配**：
 *   ① 五个工具真被注册进 agent（AI SDK/Mastra 能把它们的 zod schema 转成工具描述——尤其是
 *      create_docx 的 discriminatedUnion 与 create_excel 的联合单元格）；
 *   ② 审批档位经真链路生效（ask 工作区 → SSE 里出 `tool-approval-request` 且不落盘；
 *      切 full 后免审 → 直接 `tool-output-available` 且文件真在）;
 *   ③ PDF 的注入钩子真走到（本 spec 注入 stub，等价于 main 侧注入 Electron printToPDF 的位置）。
 *
 * 工作区设置走**落盘的 settings.json**（与设置页同一份），不靠测试注入 —— 与 approval-policy.spec.ts 同口径。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { readSettings, settingsPath, updateSettings } from '../../main/settings'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import type { PdfPrinter } from '../tools/artifacts'
import { readZipEntries, zipText } from '../tools/__tests__/zip'
import { threadMemoryBody } from '../../shared/threads'

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

function toolCallScript(calls: Array<{ id: string; name: string; input: unknown }>): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const call of calls) {
    parts.push({ type: 'tool-input-start', id: call.id, toolName: call.name })
    parts.push({ type: 'tool-input-delta', id: call.id, delta: JSON.stringify(call.input) })
    parts.push({ type: 'tool-input-end', id: call.id })
  }
  for (const call of calls) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input)
    })
  }
  parts.push({ type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE })
  return parts
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

/** 工具回执（输出被包成 part.output；拿不到就原样 JSON，断言只找路径子串） */
function toolOutputText(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === 'tool-output-available')
    .map((part) => (typeof part.output === 'string' ? part.output : JSON.stringify(part.output)))
    .join('\n')
}

function toolError(parts: Array<Record<string, unknown>>): string {
  const error = parts.find((part) => part.type === 'tool-output-error')
  return String(error?.errorText ?? '')
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
/** PDF stub 收到的 HTML（等价于 main 侧 Electron printToPDF 的入参） */
const printed: string[] = []

const stubPrintPdf: PdfPrinter = async (html) => {
  printed.push(html)
  return Buffer.from('%PDF-1.4\nserver-level stub\n%%EOF\n', 'utf8')
}

function user(id: string, text: string): Record<string, unknown> {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

async function chat(
  messages: unknown[],
  threadId: string
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

/** 跑一轮：先给工具脚本，再给收尾文本 */
async function runTurn(
  threadId: string,
  calls: Array<{ id: string; name: string; input: unknown }>
): Promise<Array<Record<string, unknown>>> {
  scripts.push(() => toolCallScript(calls))
  scripts.push(() => textScript('好，处理完了。'))
  return await chat([user(`u-${threadId}`, '产出一下')], threadId)
}

function setMode(mode: 'ask' | 'full'): void {
  updateSettings(settingsPath(dir), { workspaces: [{ path: workspace, mode }] })
  expect(readSettings(settingsPath(dir)).workspaces[0]?.mode).toBe(mode)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-artifacts-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  updateSettings(settingsPath(dir), { workspaces: [] })

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-artifacts-mock',
    modelId: 'kyclaw-artifacts-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  server = await startAgentServer({ dataDir: dir, model, printPdf: stubPrintPdf })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('ask 工作区：产出物要审批', () => {
  it('create_report 挂起：SSE 出 tool-approval-request，工作区里没有文件', async () => {
    setMode('ask')
    scripts.length = 0
    const parts = await runTurn('thread-ask', [
      { id: 'r1', name: 'create_report', input: { title: '季度复盘', html: '<h2>稳</h2>' } }
    ])

    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(workspace, '季度复盘.html'))).toBe(false)
  }, 60_000)
})

describe('full 工作区：产出物免审并真落盘', () => {
  it('五件产出物经真链路产出：回执带路径，文件真在、真能读回', async () => {
    setMode('full')
    scripts.length = 0
    printed.length = 0

    const parts = await runTurn('thread-full', [
      {
        id: 'c-report',
        name: 'create_report',
        input: { title: '季度复盘', html: '<h2>结论</h2><p>稳中向好。</p>' }
      },
      { id: 'c-pdf', name: 'create_pdf', input: { title: '季度复盘', html: '<h2>结论</h2>' } },
      {
        id: 'c-excel',
        name: 'create_excel',
        input: {
          sheets: [
            {
              name: '营收',
              rows: [
                ['季度', '金额'],
                ['Q3', 1234.5]
              ]
            }
          ]
        }
      },
      {
        id: 'c-ppt',
        name: 'create_ppt',
        input: { title: '季度复盘', slides: [{ title: '结论', bullets: ['稳中向好'] }] }
      },
      {
        id: 'c-docx',
        name: 'create_docx',
        input: {
          title: '季度复盘',
          blocks: [
            { type: 'heading', text: '目标' },
            { type: 'paragraph', text: '稳中向好。' }
          ]
        }
      }
    ])

    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(toolError(parts)).toBe('')

    const receipts = toolOutputText(parts)
    const files = {
      report: join(workspace, '季度复盘.html'),
      pdf: join(workspace, '季度复盘.pdf'),
      excel: join(workspace, '营收.xlsx'),
      ppt: join(workspace, '季度复盘.pptx'),
      docx: join(workspace, '季度复盘.docx')
    }
    for (const [kind, file] of Object.entries(files)) {
      expect(existsSync(file), `${kind} 应该落盘`).toBe(true)
      expect(receipts, `${kind} 的回执应带路径`).toContain(file)
    }

    // 读回：HTML 文本、PDF 断头、xlsx 解包、pptx/docx 解包读到正文
    expect(readFileSync(files.report, 'utf8')).toContain('<p>稳中向好。</p>')
    expect(readFileSync(files.pdf).subarray(0, 5).toString('utf8')).toBe('%PDF-')
    expect(zipText(readZipEntries(readFileSync(files.excel)), 'xl/workbook.xml')).toContain('营收')
    expect(zipText(readZipEntries(readFileSync(files.docx)), 'word/document.xml')).toContain(
      '稳中向好。'
    )
    expect(zipText(readZipEntries(readFileSync(files.ppt)), 'ppt/slides/slide2.xml')).toContain(
      '稳中向好'
    )

    // PDF 钩子拿到的是渲染好的报告 HTML（注入点真的被走到）
    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain('<title>季度复盘</title>')
    expect(printed[0]).toContain('<style>')
  }, 60_000)

  it('回到 ask：又开始弹审批（模式现读，不重启服务）', async () => {
    setMode('ask')
    scripts.length = 0
    const parts = await runTurn('thread-ask2', [
      {
        id: 'd2',
        name: 'create_docx',
        input: { title: '又一份', blocks: [{ type: 'paragraph', text: 'x' }] }
      }
    ])

    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(workspace, '又一份.docx'))).toBe(false)
  }, 60_000)
})
