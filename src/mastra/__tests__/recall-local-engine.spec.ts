// @vitest-environment node
/**
 * 模块 3B：**端到端**（真引擎 + 真小模型 + 真向量库 + 真召回链路）。
 *
 * 链路一头是 `resources/llama/llama-server.exe`（`pnpm fetch:llama` 落的 pinned 构建），
 * 另一头是 agent 服务的 chat 路由；中间是模型下载器、引擎管理、嵌入网关、
 * `mastra/embedding.ts` 的本机一支、Mastra Memory 的 semanticRecall（resource 作用域）。
 *
 * 断的四件事：
 *   1. **一次真 embeddings 请求**（经网关）：维度 512、向量 L2 归一到 1.0（归一化口径实测）；
 *   2. 消息真的进了向量库（`memory_messages_512` 能查出来）；
 *   3. **跨会话召回**：会话 A 说的事，新会话 B 换措辞问，B 那轮 prompt 里出现 A 的内容；
 *   4. 引擎是**按需起来**的（装配时还没有进程，第一条嵌入请求把它拉起来）。
 *
 * 依赖与环境：模型用**最小档**（bge-small-zh-v1.5 Q8_0，26MB，只下一次，缓存在
 * `resources/llama/.cache/models/`）；二进制或模型都拿不到时**跳过**（不把环境问题当红灯），
 * 但跳过理由会打出来。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibSQLVector } from '@mastra/libsql'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { downloadModelFile, verifyModelFile } from '../../main/llama/download'
import { createLlamaEngine, type LlamaEngine } from '../../main/llama/engine'
import { createEmbeddingGateway, type EmbeddingGateway } from '../../main/llama/gateway'
import { localModelById, downloadPlanOf } from '../../shared/local-models'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'

const ROOT = resolve(__dirname, '../../../')
const BINARY = join(ROOT, 'resources', 'llama', 'llama-server.exe')
const MODEL_CACHE_DIR = join(ROOT, 'resources', 'llama', '.cache', 'models')
const SMALL = localModelById('bge-small-zh-v1.5-q8')!

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

/** 模型就位（缓存命中就直接用；否则真下载一次，走生产下载器） */
async function ensureModel(): Promise<string> {
  const dest = join(MODEL_CACHE_DIR, `${SMALL.id}.gguf`)
  const manifest = { bytes: SMALL.file.bytes, sha256: SMALL.file.sha256 }
  if (existsSync(dest) && (await verifyModelFile(dest, manifest)) === null) return dest
  mkdirSync(MODEL_CACHE_DIR, { recursive: true })
  const plan = downloadPlanOf(SMALL)
  const outcome = await downloadModelFile({
    file: manifest,
    urls: plan.flatMap((file) => [...file.urls]),
    dest,
    log: () => undefined
  })
  console.log(`[e2e] 模型已就位：${dest}（来源 ${outcome.url}）`)
  return dest
}

let dir: string
let modelPath: string
let engine: LlamaEngine
let gateway: EmbeddingGateway
let server: AgentServerHandle
let probeVector: LibSQLVector | undefined
/** 网关与引擎共用的那把本机密钥（生产里是每次启动新生成的随机串） */
const apiKey = 'e2e-local-engine-key'
/** 断言用的日志（skip 时打出来） */
const calls: Array<{ prompt?: unknown }> = []
const scripts: Array<() => StreamPart[]> = []
let skipReason: string | null = null

function dbUrl(dataDir: string): string {
  return `file:${join(dataDir, 'kyclaw.db').replace(/\\/g, '/')}`
}

async function embeddings(texts: string[]): Promise<number[][]> {
  const base = gateway.baseUrl()
  if (base === null) throw new Error('网关还没起')
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: SMALL.id, input: texts })
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: Array<{ embedding: number[] }> }
  return body.data.map((item) => item.embedding)
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
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

function promptText(index: number): string {
  return JSON.stringify(calls[index]?.prompt ?? '')
}

beforeAll(async () => {
  if (!existsSync(BINARY)) {
    skipReason = `没有本机引擎运行时：${BINARY}（先跑 pnpm fetch:llama）`
    return
  }
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-local-engine-'))
  try {
    modelPath = await ensureModel()
  } catch (error) {
    skipReason = `小档模型拿不到（网络？）：${error instanceof Error ? error.message : String(error)}`
    return
  }

  // 生产形状：引擎 + 网关（key 每次启动新生成）
  engine = createLlamaEngine({
    binaryPath: BINARY,
    modelPath,
    modelId: SMALL.id,
    apiKey,
    startupTimeoutMs: 60_000,
    idleMs: () => 0, // 这条用例要连着用，别中途回收
    log: () => undefined
  })
  gateway = createEmbeddingGateway({ engine, apiKey, log: () => undefined })
  await gateway.start()

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-local-engine-mock',
    modelId: 'kyclaw-local-engine-mock',
    doStream: async (options: unknown) => {
      calls.push(options as { prompt?: unknown })
      const script = scripts.shift()
      return {
        stream: simulateReadableStream({
          chunks: script === undefined ? textScript('好。') : script(),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    semanticRecall: () => ({
      enabled: true,
      source: 'localEngine',
      baseUrl: '',
      model: '',
      idleMinutes: 5
    }),
    // 主进程那一层的职责（真实运行时是 main/llama/service.ts）：给一个 OpenAI 兼容端点
    localEmbedding: async () => ({
      baseUrl: gateway.baseUrl() ?? '',
      modelId: SMALL.id,
      apiKey
    })
  })
}, 300_000)

afterAll(async () => {
  await server?.stop()
  await gateway?.close()
  await engine?.dispose()
  await probeVector?.close().catch(() => undefined)
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  }
})

describe('本机引擎：端到端（真引擎 + 真小模型）', () => {
  it('装好就能召回：状态是 active / localEngine，且引擎是按需起来的', async (context: TestContext) => {
    if (skipReason !== null) {
      console.log(`[e2e] 跳过：${skipReason}`)
      context.skip()
      return
    }
    const response = await fetch(`${server.baseUrl}/api/memory/recall`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    const { recall } = (await response.json()) as { recall: Record<string, unknown> }
    expect(recall).toMatchObject({ state: 'active', active: true, source: 'localEngine' })
    expect(String(recall.detail)).toContain(SMALL.name)
    expect(engine.status().phase).toBe('running')
  }, 60_000)

  it('一次真 embeddings 请求：512 维、L2 归一到 1.0（归一化口径）', async (context: TestContext) => {
    if (skipReason !== null) {
      context.skip()
      return
    }
    const [first, second] = await embeddings(['我上周末去爬了富士山', '今天天气不错'])
    expect(first).toHaveLength(SMALL.dim)
    expect(second).toHaveLength(SMALL.dim)

    const norm = (vector: number[]): number =>
      Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    // 引擎侧 --embd-normalize 的缺省 2 = L2：实测归一后范数正好 1.000000（浮点误差内）
    expect(norm(first!)).toBeCloseTo(1, 5)
    expect(norm(second!)).toBeCloseTo(1, 5)

    // 同一句话的向量稳定（同一次进程内可复现），不同句子不重合
    const [again] = await embeddings(['我上周末去爬了富士山'])
    const cosine = (a: number[], b: number[]): number =>
      a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)
    expect(cosine(again!, first!)).toBeCloseTo(1, 5)
    expect(cosine(second!, first!)).toBeLessThan(0.99)
  }, 60_000)

  it('消息真进了向量库（memory_messages_512），并且跨会话召回能把 A 的内容喂给 B', async (context: TestContext) => {
    if (skipReason !== null) {
      context.skip()
      return
    }
    probeVector ??= new LibSQLVector({ id: 'kyclaw-local-e2e-probe', url: dbUrl(dir) })

    // 会话 A：说一件事（用户消息与助手回复都会嵌入）
    scripts.length = 0
    scripts.push(() => textScript('记下了：你上周末去爬了富士山。'))
    await chat('local-e2e-a', '我上周末去爬了富士山，天气很好')

    const query = (await embeddings(['我上周末去爬了富士山，天气很好']))[0]!
    await waitFor(async () => {
      const rows = await probeVector!.query({
        indexName: `memory_messages_${SMALL.dim}`,
        queryVector: query,
        topK: 5
      })
      return rows.length > 0
    })

    const rows = await probeVector.query({
      indexName: `memory_messages_${SMALL.dim}`,
      queryVector: query,
      topK: 5
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => String(row.metadata?.thread_id) === 'local-e2e-a')).toBe(true)

    // 会话 B（新会话、换措辞问同一件事）：A 的内容被召回进 B 这轮的 prompt
    const before = calls.length
    scripts.length = 0
    scripts.push(() => textScript('你上周末去爬了富士山。'))
    await chat('local-e2e-b', '我之前说的富士山那次户外活动是什么？')
    expect(calls.length).toBe(before + 1)

    const prompt = promptText(calls.length - 1)
    expect(prompt).toContain('remembered_from_other_conversation')
    expect(prompt).toContain('富士山')
    expect(prompt).toContain('我之前说的富士山那次户外活动是什么？')
  }, 120_000)
})
