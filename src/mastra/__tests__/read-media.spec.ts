// @vitest-environment node
/**
 * read 把**图片**交到模型手上这条链路（round 71；round 75 加"读不了图就不发"）：
 * 真 agent server + 真 read 工具 + stub 模型，断言**第二轮生成的 prompt 里到底有什么** ——
 * 这是"图有没有真的到模型手上"唯一的直接判据。
 *
 * 为什么值得一份单独的 spec（而不是只看工具级断言）：工具级只能证明"toModelOutput 返回了正确的
 * 形状"，证明不了"这个形状真的会被拼进下一次请求"。这里把三件事一次钉住：
 *   1. 图片档：工具结果里带的是**图片字节**（base64 一字不差），不是抽出来的文字；
 *   2. 文本档：**没有** toModelOutput 包装也照旧是文本（读文件这条主路不能因为这次改动变样）；
 *   3. round 75：模型读不了图（本部署事实 `vision === false`）时**一个字节都不发** ——
 *      第二轮 prompt 里查不到 base64，只有那回一句人话（用户口径：看不了就别发）。
 *
 * 形状与 render_ppt 的页图是同一条（`{type:'file', mediaType, data:{type:'data', data:<base64>}}`，
 * 见 tools/render-ppt.ts 头注）；"它到了真端点会变成 image_url" 由
 * `__tests__/model-tool-media.spec.ts`（真 provider + 假端点）钉住，这里不重复。
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import { resetSkillRuntimeFactsSource, setSkillRuntimeFactsSource } from '../skills/runtime'
import type { Workspace } from '../../shared/settings'

/** 真 PNG 32×24（与 tools/__tests__/read.spec.ts 同一张：Pillow 生成的真件） */
const PNG_32x24 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAANElEQVR4nGOUizrBQEvARFPTGUYtIAKMxgFBMBpEBMFoEBEEo0FEEIwGEUEwGkQEAc2DCAA+4gFw1nh8rAAAAABJRU5ErkJggg=='

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

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

/** SSE 响应体 → 结构化 part 列表（跳过 [DONE] 终结行） */
function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
/** 每次模型调用收到的 prompt 原样存下来：最后一份就是"工具结果长什么样"的现场 */
const prompts: unknown[] = []

async function chat(messages: unknown[], threadId: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
  })
  expect(response.status).toBe(200)
  return await response.text()
}

function user(text: string, id = 'u-1'): Record<string, unknown> {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-read-media-'))
  workspace = realpathSync.native(dir)
  writeFileSync(join(workspace, 'note.txt'), 'hello round 71', 'utf8')
  writeFileSync(join(workspace, 'shot.png'), Buffer.from(PNG_32x24, 'base64'))

  // 工作区设为 full：这一轮只关心 prompt 现场，不关心审批（round 75 起读图片根本不弹卡，
  // 判定见 tools/__tests__/read.spec.ts 的"读图片不审"一节）
  const workspaces: Workspace[] = [{ path: workspace, mode: 'full' }]

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-read-media-mock',
    modelId: 'kyclaw-read-media-mock',
    doStream: async (options) => {
      prompts.push(options.prompt)
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({
          chunks: script(),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => workspaces,
    projects: () => []
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('read 的图片交给模型（第二轮 prompt 现场）', () => {
  it('读图片：工具结果里带的是图片字节（base64 一字不差），模型确实拿到了图', async () => {
    scripts.length = 0
    prompts.length = 0
    scripts.push(() => toolCallScript('call-read-img', 'read', { path: 'shot.png' }))
    scripts.push(() => textScript('图我看过了。'))

    const parts = sseParts(await chat([user('看一眼 shot.png')], 'thread-read-img'))

    expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '图我看过了。'
    ])
    // 判据：第二轮那次请求的 prompt 里，PNG 的 base64 原样在（图真的进了请求体）
    const second = JSON.stringify(prompts.at(-1))
    expect(second).toContain(PNG_32x24)
    expect(second).toContain('已经交给你看')
  })

  it('读文本：工具结果照旧是**文本**（这次改动没有给文本档套包装）', async () => {
    scripts.length = 0
    prompts.length = 0
    scripts.push(() => toolCallScript('call-read-txt', 'read', { path: 'note.txt' }))
    scripts.push(() => textScript('文件我看过了。'))

    const parts = sseParts(await chat([user('读一下 note.txt')], 'thread-read-txt'))

    expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)
    const second = JSON.stringify(prompts.at(-1))
    expect(second).toContain('hello round 71')
    // 文本档不该变成 JSON 包一层，也不该是空（toModelOutput 那一支对字符串原样放行）
    expect(second).not.toContain('"value":null')
    expect(second).not.toContain('{"message"')
  })

  it('读图片不弹任何审批卡（round 75：读图不审，图片档与文本档同一档）', async () => {
    scripts.length = 0
    prompts.length = 0
    scripts.push(() => toolCallScript('call-read-img-2', 'read', { path: 'shot.png' }))
    scripts.push(() => textScript('嗯。'))

    const parts = sseParts(await chat([user('再看一次')], 'thread-read-img-2'))

    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(parts.some((part) => part.type === 'tool-output-available')).toBe(true)
  }, 30_000)

  it('模型读不了图：**一个字节都不发**，第二轮 prompt 里没有 base64、只有那句人话', async () => {
    // 本部署事实（生产由 main 侧按 visionOf 口径算好装进这个注册表，见 skills/runtime）
    setSkillRuntimeFactsSource(() => ({ pptRenderer: null, vision: false }))
    try {
      scripts.length = 0
      prompts.length = 0
      scripts.push(() => toolCallScript('call-read-img-3', 'read', { path: 'shot.png' }))
      scripts.push(() => textScript('看不了。'))

      const parts = sseParts(await chat([user('这张图里是什么')], 'thread-read-img-3'))
      expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)

      const second = JSON.stringify(prompts.at(-1))
      console.log(
        `[r75-vision] 第二轮 prompt 里含 base64=${second.includes(PNG_32x24)}；` +
          `含"当前模型看不了图"=${second.includes('当前模型看不了图')}`
      )
      expect(second).not.toContain(PNG_32x24)
      expect(second).toContain('当前模型看不了图')
    } finally {
      resetSkillRuntimeFactsSource()
    }
  }, 30_000)
})
