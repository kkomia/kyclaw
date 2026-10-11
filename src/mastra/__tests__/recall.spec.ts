// @vitest-environment node
/**
 * round 28 模块 3：语义召回（长期记忆，跨会话语义召回）的三层测试。
 *
 *   1. 解析层（resolveRecall）：开关 / 半截配置 / 端点不通 → **没有 embedder** 且状态是人话
 *      （失败＝加法）；本地模型准备（本地 http 源 → 6 个文件 → 整目录改名后才算就绪）。
 *   2. 服务层（startAgentServer + 真 libsql vector + mock 模型 + 假嵌入服务）：
 *      - **验收主用例**：会话 A 说一件事 → 新会话 B **换个措辞**问相关的事 →
 *        B 收到的那轮 prompt 里出现 A 的内容（这就是"长期记忆"的定义）；
 *      - 删除清理：截断消息 / 删会话之后，向量里的嵌入随之消失，**不再召回已删内容**；
 *      - 失败降级：端点不通 / 挂上的 embedder 运行时抛错 → 对话照常（200 + 有正文）。
 *   3. 与压缩共处：POST /compact 删掉旧消息后，嵌入一起清（旧内容不再被召回），摘要照旧注入。
 *
 * 嵌入用**假服务**：一个真的 OpenAI 兼容 `/embeddings` HTTP 端点，把文本映射到几根手挑的
 * 概念轴上（同概念的不同说法同向）——这样"换个措辞"是可断言的，而且走的是生产代码路径
 * （mastra/embedding.ts 的远程一支：ModelRouterEmbeddingModel → 这个端点）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLVector } from '@mastra/libsql'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { resolveRecall, validateRecallEmbedder } from '../embedding'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }

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

// ---------------------------------------------------------------- 假嵌入服务

/**
 * 概念轴：文本落在哪些概念上（不是关键词相等——同一根轴上的不同说法余弦就高）。
 * 这么挑是为了让"换个措辞问同一件事"真的能被召回：A 说"去过富士山"，B 问"那个户外活动"。
 */
const CONCEPTS: Record<string, readonly string[]> = {
  mountain: ['山', '爬', '登', '户外', '远足', '峰', 'hike', 'mountain'],
  coffee: ['咖啡', '拿铁', '豆', '烘焙', 'coffee'],
  tax: ['报税', '税', '发票', '申报', 'tax'],
  coding: ['代码', '函数', '重构', '测试', 'code']
}

const AXES: readonly string[] = [...Object.keys(CONCEPTS), 'other']

/** 文本 → 概念计数向量（L2 归一；一个概念都没命中就落在 other 轴上，不留零向量） */
function conceptVector(text: string): number[] {
  const counts = Object.keys(CONCEPTS).map(
    (key) => CONCEPTS[key].filter((word) => text.toLowerCase().includes(word)).length
  )
  const hits = counts.reduce((sum, count) => sum + count, 0)
  const vector = hits === 0 ? [...counts.map(() => 0), 1] : [...counts, 0]
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / norm)
}

/** 该向量空间里"存下来的消息"用的索引名（维度 = 轴数） */
function messageIndexName(): string {
  return `memory_messages_${AXES.length}`
}

interface EmbedService {
  baseUrl: string
  /** 端点收到的 input 条数（成本口径：每轮对话发几次、每次几条） */
  calls: number
  close: () => Promise<void>
}

/** 一个真的 OpenAI 兼容嵌入端点（POST {base}/embeddings） */
async function startEmbedService(): Promise<EmbedService> {
  const service: EmbedService = { baseUrl: '', calls: 0, close: async () => undefined }
  const server: Server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/embeddings')) {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { input?: unknown }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      service.calls += inputs.length
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          model: 'kyclaw-stub-embedding',
          data: inputs.map((input, index) => ({
            object: 'embedding',
            index,
            embedding: conceptVector(String(input))
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length }
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  service.baseUrl = `http://127.0.0.1:${port}/v1`
  service.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  return service
}

/** 轮询到条件成立（后台的向量清理是异步的，松一点、别把库读锁死） */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function dbUrl(dataDir: string): string {
  return `file:${join(dataDir, 'kyclaw.db').replace(/\\/g, '/')}`
}

/**
 * 逗号解释：直接问向量表"这个内容还在不在"。
 * 连接**复用一条**（开/关连接太频繁会把 libsql 的文件锁搅乱——实测过），afterAll 里关。
 */
let probeVector: LibSQLVector | undefined

async function vectorRows(
  dataDir: string,
  text: string
): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>> {
  probeVector ??= new LibSQLVector({ id: 'kyclaw-recall-probe', url: dbUrl(dataDir) })
  return probeVector.query({
    indexName: messageIndexName(),
    queryVector: conceptVector(text),
    topK: 20
  })
}

// ---------------------------------------------------------------- 解析层

describe('resolveRecall：开关 / 半截配置 / 起不来', () => {
  it('关掉时没有 embedder，状态是 off', async () => {
    const recall = await resolveRecall({
      settings: { enabled: false, source: 'remote', baseUrl: 'x', model: 'y' },
      embeddingKey: 'secret'
    })
    expect(recall.embedder).toBeUndefined()
    expect(recall.status()).toMatchObject({ state: 'off', active: false })
  })

  it('配置半截（缺地址/模型/密钥）→ 没有 embedder，原因逐项说清', async () => {
    const recall = await resolveRecall({
      settings: { enabled: true, source: 'remote', baseUrl: '', model: '' },
      embeddingKey: null
    })
    expect(recall.embedder).toBeUndefined()
    const status = recall.status()
    expect(status.state).toBe('unavailable')
    expect(status.detail).toContain('缺服务地址')
    expect(status.detail).toContain('缺模型名')
    expect(status.detail).toContain('缺 API Key')
    // 密钥明文绝不进状态行
    expect(status.detail).not.toContain('secret')
  })

  it('服务不通 → 探测失败也没有 embedder（不把不健康的 embedder 挂给 Memory）', async () => {
    const recall = await resolveRecall({
      settings: {
        enabled: true,
        source: 'remote',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'nope'
      },
      embeddingKey: 'sk-test'
    })
    expect(recall.embedder).toBeUndefined()
    const status = recall.status()
    expect(status.state).toBe('unavailable')
    expect(status.active).toBe(false)
    expect(status.detail).toContain('嵌入服务不可用')
  })

  it('服务可用 → 探测通过，挂上 embedder', async () => {
    const service = await startEmbedService()
    try {
      const recall = await resolveRecall({
        settings: {
          enabled: true,
          source: 'remote',
          baseUrl: service.baseUrl,
          model: 'stub'
        },
        embeddingKey: 'sk-test'
      })
      expect(recall.embedder).toBeDefined()
      expect(recall.status()).toMatchObject({ state: 'active', active: true, source: 'remote' })
      // 探测本身也算一次调用（一条 input）
      expect(service.calls).toBeGreaterThanOrEqual(1)
    } finally {
      await service.close()
    }
  })

  it('启动自检：拿不到维度（embedder 抛错）→ 回人话原因', async () => {
    const broken = {
      getEmbeddingDimension: async () => {
        throw new Error('embedder 挂了')
      }
    }
    const problem = await validateRecallEmbedder(broken, 1_000)
    expect(problem).toContain('启动自检')
    expect(problem).toContain('embedder 挂了')
  })
})

// ---------------------------------------------------------------- 服务层

let dir: string
let embedService: EmbedService
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
const calls: unknown[] = []

/** 最近一轮 mock 模型收到的完整 prompt 文本（含工具/历史/召回注入） */
function promptText(index: number): string {
  return JSON.stringify((calls[index] as { prompt?: unknown }).prompt ?? '')
}

async function chat(threadId: string, text: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [
        { id: `u-${threadId}-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }
      ],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return response.text()
}

async function threadMessages(threadId: string): Promise<Array<{ id: string; role: string }>> {
  const response = await fetch(`${server.baseUrl}/api/threads/${threadId}/messages`, {
    headers: { authorization: `Bearer ${server.token}` }
  })
  const body = (await response.json()) as { messages: Array<{ id: string; role: string }> }
  return body.messages
}

async function truncate(threadId: string, messageId: string): Promise<number> {
  const response = await fetch(`${server.baseUrl}/api/threads/${threadId}/truncate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messageId })
  })
  const body = (await response.json()) as { deleted: number }
  return body.deleted
}

async function deleteThread(threadId: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/threads/${threadId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${server.token}` }
  })
  expect(response.status).toBe(200)
}

async function recallStatus(): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.baseUrl}/api/memory/recall`, {
    headers: { authorization: `Bearer ${server.token}` }
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { recall: Record<string, unknown> }
  return body.recall
}

describe('服务层：跨会话语义召回（长期记忆）', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-recall-'))
    embedService = await startEmbedService()
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-recall-mock',
      modelId: 'kyclaw-recall-mock',
      doStream: async (options: unknown) => {
        calls.push(options)
        const script = scripts.shift()
        return {
          stream: simulateReadableStream({
            chunks: script === undefined ? textScript('好。') : script(),
            initialDelayInMs: 0,
            chunkDelayInMs: 0
          })
        }
      },
      // 压缩的摘要调用走 generate（不是 stream）：给一段固定摘要，好在下一轮 prompt 里认出来
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '上下文压缩摘要：用户在改一个重构函数。' }],
        finishReason: FINISH_STOP,
        usage: USAGE,
        warnings: []
      })
    })
    server = await startAgentServer({
      dataDir: dir,
      model,
      semanticRecall: () => ({
        enabled: true,
        source: 'remote',
        baseUrl: embedService.baseUrl,
        model: 'stub'
      }),
      embeddingKey: () => 'sk-test'
    })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    await probeVector?.close().catch(() => undefined)
    await embedService?.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('本次运行的召回状态是 active（服务起来就把 embedder 挂上了）', async () => {
    const status = await recallStatus()
    expect(status).toMatchObject({ state: 'active', active: true, enabled: true, source: 'remote' })
  })

  it('验收主用例：会话 A 说的事，新会话 B 换个措辞能召回', async () => {
    // A：说一件事（用户消息 + 助手回复都落库、都嵌入）
    scripts.length = 0
    scripts.push(() => textScript('记下了：你上周末去爬了富士山。'))
    await chat('recall-thread-a', '我上周末去爬了富士山，天气很好')
    // 存的消息落库（+ 嵌入写进向量表）是异步的：等到"能问出来"为止
    await waitFor(async () => (await vectorRows(dir, '山')).length > 0)

    // B：**新会话**、**不同措辞**问相关的事
    const before = calls.length
    scripts.length = 0
    scripts.push(() => textScript('你上周末去爬了富士山。'))
    await chat('recall-thread-b', '我之前提过的那个户外活动是什么？')

    expect(calls.length).toBe(before + 1)
    const prompt = promptText(calls.length - 1)
    // 召回注入：跨会话的系统消息里带着 A 的内容（且标着"来自之前的对话"）
    expect(prompt).toContain('remembered_from_other_conversation')
    expect(prompt).toContain('Message from previous conversation')
    expect(prompt).toContain('富士山')
    // 这一轮是会话 B 的：注入的那条不是它自己的历史（B 只有这一句提问）
    expect(prompt).toContain('我之前提过的那个户外活动是什么？')
  }, 30_000)

  it('删除清理：截断之后那条消息的嵌入随之消失，不再被召回', async () => {
    scripts.length = 0
    scripts.push(() => textScript('好，记下了。'))
    await chat('recall-thread-c', '帮我记一下：周五要交报税材料')
    await waitFor(async () => (await vectorRows(dir, '报税')).length > 0)

    const messages = await threadMessages('recall-thread-c')
    const userMessage = messages.find((message) => message.role === 'user')
    expect(userMessage).toBeDefined()

    // 截断（= 编辑重发那条路径上的删除）：这条及之后的消息被物理删除
    const deleted = await truncate('recall-thread-c', userMessage?.id ?? '')
    expect(deleted).toBeGreaterThan(0)

    // 向量表里不再有这条消息：用它的文本查（它若还在，就是分数 1.0 的头条），
    // 查回来的一批里不该再有这个会话的任何一条。清理是异步的，等它落定。
    await waitFor(async () =>
      (await vectorRows(dir, '报税材料')).every(
        (row) => row.metadata?.thread_id !== 'recall-thread-c'
      )
    )
    const rows = await vectorRows(dir, '报税材料')
    expect(rows.map((row) => row.metadata?.message_id)).not.toContain(userMessage?.id)

    // 再开一个新会话问同一件事：prompt 里不该出现已删内容
    const before = calls.length
    scripts.length = 0
    scripts.push(() => textScript('没有相关记录。'))
    await chat('recall-thread-c-ask', '我上次说的那个报税的材料是什么？')
    expect(calls.length).toBe(before + 1)
    expect(promptText(calls.length - 1)).not.toContain('报税材料')
  }, 30_000)

  it('删除清理：删掉会话之后，它的消息也不再被召回', async () => {
    scripts.length = 0
    scripts.push(() => textScript('好。'))
    await chat('recall-thread-d', '我最近在学做手冲咖啡，买了新豆子')
    await waitFor(async () => (await vectorRows(dir, '咖啡')).length > 0)

    await deleteThread('recall-thread-d')
    // 删会话把它的嵌入一起收走（memory.deleteThread 自带清理）：查它的文本，不该再有它的行
    await waitFor(async () =>
      (await vectorRows(dir, '手冲咖啡')).every(
        (row) => row.metadata?.thread_id !== 'recall-thread-d'
      )
    )

    const before = calls.length
    scripts.length = 0
    scripts.push(() => textScript('没有相关记录。'))
    await chat('recall-thread-d-ask', '我上次说的那个喝的东西是什么？')
    expect(calls.length).toBe(before + 1)
    expect(promptText(calls.length - 1)).not.toContain('手冲咖啡')
  }, 30_000)

  it('与压缩共处：POST /compact 删掉旧消息后，嵌入一起清（摘要照旧注入）', async () => {
    // 多轮对话攒够素材（默认保留窗口 20 条，这里多聊几轮）
    scripts.length = 0
    for (let round = 1; round <= 8; round++) {
      scripts.push(() => textScript(`第 ${round} 轮回答。`))
      await chat('recall-thread-compact', `第 ${round} 轮：我在改一个重构函数，第 ${round} 遍`)
    }
    await waitFor(async () => (await vectorRows(dir, '重构')).length > 0)

    const beforeIds = new Set((await threadMessages('recall-thread-compact')).map((m) => m.id))

    const dry = await fetch(`${server.baseUrl}/api/threads/recall-thread-compact/compaction`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(dry.status).toBe(200)

    const response = await fetch(`${server.baseUrl}/api/threads/recall-thread-compact/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({})
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      compacted: boolean
      compaction: { summarized: number; summary: string } | null
    }
    expect(body.compacted).toBe(true)
    expect(body.compaction?.summarized ?? 0).toBeGreaterThan(0)

    // 压缩删掉的那批旧消息：嵌入不再留在向量表里（"已删内容不能召回"的同一口径）。
    // 注意只断言**这个会话**的行：向量表是共享的，别的会话的行本来就在（正交向量也会被查出来，
    // 分数 0 也在结果里——libsql 的 minScore 是 `score > 0`，float 误差下 0 会漏出来）。
    const remaining = new Set((await threadMessages('recall-thread-compact')).map((m) => m.id))
    const removed = [...beforeIds].filter((id) => !remaining.has(id))
    expect(removed.length).toBeGreaterThan(0)
    await waitFor(async () => {
      const rows = await vectorRows(dir, '重构函数')
      return rows
        .filter((row) => row.metadata?.thread_id === 'recall-thread-compact')
        .every((row) => !removed.includes(String(row.metadata?.message_id)))
    })

    // 摘要仍然进下一轮的 prompt（压缩摘要 + 语义召回是两条独立的路）
    const before = calls.length
    scripts.length = 0
    scripts.push(() => textScript('继续。'))
    await chat('recall-thread-compact', '那我们接着来')
    expect(calls.length).toBe(before + 1)
    expect(promptText(calls.length - 1)).toContain('上下文压缩摘要')
  }, 60_000)
})

// ---------------------------------------------------------------- 失败降级（服务层）

describe('失败＝加法：语义召回起不来/挂掉都不拦对话', () => {
  it('远程端点不通：服务照常起、对话照常、状态如实说不可用', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'kyclaw-recall-bad-'))
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-recall-bad-mock',
      modelId: 'kyclaw-recall-bad-mock',
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: textScript('照样回答。'),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      })
    })
    const bad = await startAgentServer({
      dataDir: badDir,
      model,
      semanticRecall: () => ({
        enabled: true,
        source: 'remote',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'nope'
      }),
      embeddingKey: () => 'sk-test'
    })
    try {
      const response = await fetch(`${bad.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bad.token}`
        },
        body: JSON.stringify({
          messages: [{ id: 'u-bad-1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }],
          ...threadMemoryBody('recall-bad-thread')
        })
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('照样回答。')

      const statusResponse = await fetch(`${bad.baseUrl}/api/memory/recall`, {
        headers: { authorization: `Bearer ${bad.token}` }
      })
      const { recall } = (await statusResponse.json()) as { recall: Record<string, unknown> }
      expect(recall).toMatchObject({ state: 'unavailable', active: false, enabled: true })
    } finally {
      await bad.stop()
      try {
        rmSync(badDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（交系统清理）：', badDir)
      }
    }
  }, 60_000)

  it('挂上的 embedder 运行时抛错：对话仍然完成（召回注入整段被吞掉）', async () => {
    const crashDir = mkdtempSync(join(tmpdir(), 'kyclaw-recall-crash-'))
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-recall-crash-mock',
      modelId: 'kyclaw-recall-crash-mock',
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: textScript('照样回答。'),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      })
    })
    // 一个"挂上了但在运行时抛错"的 embedder（模拟端点中途挂掉 / 模型文件坏了）：
    // 这正是"失败只做加法"最需要钉住的边界——每轮取输入处理器时会问它维度
    const broken = {
      specificationVersion: 'v2' as const,
      provider: 'kyclaw-broken',
      modelId: 'kyclaw-broken',
      maxEmbeddingsPerCall: 256,
      supportsParallelCalls: false,
      doEmbed: async () => {
        throw new Error('embedder 挂了')
      }
    } as unknown as Parameters<typeof startAgentServer>[0]['recallEmbedder']
    const crash = await startAgentServer({
      dataDir: crashDir,
      model,
      semanticRecall: () => ({
        enabled: true,
        source: 'remote',
        baseUrl: 'x',
        model: 'y'
      }),
      recallEmbedder: broken
    })
    try {
      const response = await fetch(`${crash.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${crash.token}` },
        body: JSON.stringify({
          messages: [{ id: 'u-crash-1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }],
          ...threadMemoryBody('recall-crash-thread')
        })
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('照样回答。')

      // 启动自检没过 → 这次运行没有召回（状态如实说），但对话照常
      const statusResponse = await fetch(`${crash.baseUrl}/api/memory/recall`, {
        headers: { authorization: `Bearer ${crash.token}` }
      })
      const { recall } = (await statusResponse.json()) as { recall: Record<string, unknown> }
      expect(recall).toMatchObject({ state: 'unavailable', active: false, enabled: true })
      expect(String(recall.detail)).toContain('启动自检')
    } finally {
      await crash.stop()
      try {
        rmSync(crashDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（交系统清理）：', crashDir)
      }
    }
  }, 60_000)
})
