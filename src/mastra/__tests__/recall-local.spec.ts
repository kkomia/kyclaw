// @vitest-environment node
/**
 * 模块 3B：语义召回的「本机引擎」这一支（解析层）。
 *
 * 与远程那一支的三点不同，逐条钉住：
 *   1. **没接上 / 没有模型** → 没有 embedder（这次运行不召回），状态是人话，**不抛**（失败只做加法）；
 *   2. 端点是主进程给的（`localEmbedding`），本模块不碰引擎与端口；
 *   3. 探测给的超时更长（60 秒）：这一次调用会顺手把引擎拉起来，冷启动的成本记在这一步。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRecall } from '../embedding'
import type { SemanticRecallSettings } from '../../shared/settings'
import { LOCAL_EMBEDDING_MODELS } from '../../shared/local-models'

const LOCAL_SETTINGS: SemanticRecallSettings = {
  enabled: true,
  source: 'localEngine',
  baseUrl: '',
  model: '',
  idleMinutes: 5
}

const openServers: Array<() => Promise<void>> = []

/** 一个 OpenAI 兼容的假嵌入服务（8 维、L2 归一）：冒充"主进程给的本机端点" */
async function startFakeEmbed(): Promise<{ baseUrl: string; calls: number }> {
  const service = { baseUrl: '', calls: 0 }
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { input?: unknown }
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      service.calls += inputs.length
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          object: 'list',
          model: 'stub',
          data: inputs.map((input, index) => {
            const raw = Array.from({ length: 8 }, (_, position) =>
              Math.abs(Math.sin(String(input).length + position))
            )
            const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1
            return { object: 'embedding', index, embedding: raw.map((value) => value / norm) }
          }),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length }
        })
      )
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  service.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  openServers.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
  )
  return service
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()?.()
})

describe('本机引擎这一支：起不来就没有 embedder', () => {
  it('主进程没接上（缺 localEmbedding）：不抛、状态说人话', async () => {
    const recall = await resolveRecall({ settings: LOCAL_SETTINGS, log: () => undefined })
    expect(recall.embedder).toBeUndefined()
    expect(recall.status()).toMatchObject({
      state: 'unavailable',
      active: false,
      enabled: true,
      source: 'localEngine'
    })
    expect(recall.status().detail).toContain('本机引擎没有接上')
  })

  it('还没有启用本机模型（provider 回 null）：状态提示"还没有启用"，不是报错', async () => {
    const recall = await resolveRecall({
      settings: LOCAL_SETTINGS,
      localEmbedding: async () => null,
      log: () => undefined
    })
    expect(recall.embedder).toBeUndefined()
    expect(recall.status().detail).toContain('还没有启用本机嵌入模型')
  })

  it('引擎起不来（provider 抛错）：原因进状态行，且不带堆栈', async () => {
    const recall = await resolveRecall({
      settings: LOCAL_SETTINGS,
      localEmbedding: async () => {
        throw new Error('引擎文件缺失：D:\\kyclaw\\resources\\llama\\llama-server.exe')
      },
      log: () => undefined
    })
    expect(recall.embedder).toBeUndefined()
    const detail = recall.status().detail
    expect(detail).toContain('本机嵌入引擎起不来')
    expect(detail).toContain('引擎文件缺失')
    expect(detail.split('\n')).toHaveLength(1)
  })

  it('端点指着一个没人听的端口（引擎死了）：探测失败 → 不挂 embedder', async () => {
    const recall = await resolveRecall({
      settings: LOCAL_SETTINGS,
      localEmbedding: async () => ({
        baseUrl: 'http://127.0.0.1:1/v1',
        modelId: 'bge-small-zh-v1.5-q8',
        apiKey: 'local-key'
      }),
      log: () => undefined
    })
    expect(recall.embedder).toBeUndefined()
    expect(recall.status().detail).toContain('本机嵌入引擎不可用')
  })
})

describe('本机引擎这一支：接上了', () => {
  it('端点可用 → 挂上 embedder，状态行用清单元数据里的中文名，来源是 localEngine', async () => {
    const service = await startFakeEmbed()
    const model = LOCAL_EMBEDDING_MODELS[0]!
    const recall = await resolveRecall({
      settings: LOCAL_SETTINGS,
      localEmbedding: async () => ({
        baseUrl: service.baseUrl,
        modelId: model.id,
        apiKey: 'local-key'
      }),
      log: () => undefined
    })

    expect(recall.embedder).toBeDefined()
    expect(recall.status()).toMatchObject({
      state: 'active',
      active: true,
      enabled: true,
      source: 'localEngine'
    })
    expect(recall.status().detail).toContain('本机引擎')
    expect(recall.status().detail).toContain(model.name)
    // 探测本身走了一次嵌入（一条 input）——这条路以后就是每轮召回的入口
    expect(service.calls).toBeGreaterThanOrEqual(1)

    const probe = await recall.embedder!.doEmbed({ values: ['你好', '世界'] })
    expect(probe.embeddings).toHaveLength(2)
    expect(probe.embeddings[0]).toHaveLength(8)
  })

  it('自定义档（id 不在清单里）：状态行说"自定义模型"，不假装知道它叫什么', async () => {
    const service = await startFakeEmbed()
    const recall = await resolveRecall({
      settings: LOCAL_SETTINGS,
      localEmbedding: async () => ({
        baseUrl: service.baseUrl,
        modelId: 'custom',
        apiKey: 'local-key'
      }),
      log: () => undefined
    })
    expect(recall.status().detail).toContain('自定义模型')
  })

  it('开关关着：本机引擎这一支根本不会被调用', async () => {
    let called = false
    const recall = await resolveRecall({
      settings: { ...LOCAL_SETTINGS, enabled: false },
      localEmbedding: async () => {
        called = true
        return null
      },
      log: () => undefined
    })
    expect(recall.embedder).toBeUndefined()
    expect(recall.status().state).toBe('off')
    expect(called).toBe(false)
  })
})
