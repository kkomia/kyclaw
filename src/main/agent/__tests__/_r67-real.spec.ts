// @vitest-environment node
/**
 * R67 探针 B：**真模型实测**（同一个 PPT 任务，抓每一次发往 provider 的请求体 + provider 回的使用量）。
 *
 * 要回答的问题（探针 A 只能给"固定开销有多大"，给不出"记账口径对不对"）：
 *   1. 真跑一轮时，**每一次** LLM 调用发出去多少 tokens？（第 1 次 = 固定开销的实测真值）
 *   2. `usage_runs` 里那一行的 `input_tokens` 是"最后一次调用"还是"这一轮所有调用之和"？
 *      （Mastra 的 onFinish 给的是 `totalUsage` = AI SDK 的"all steps 之和"，usage.ts 取的是它
 *        —— 探针要把这件事钉成数字）
 *   3. 上下文面板说的 221K 属于哪一种口径。
 *
 * 做法：把 `globalThis.fetch` 包一层，凡打到 provider 主机的请求都记下请求体（字符数、消息条数、
 * 工具条数、system 文本长度），并从 SSE 尾部的 usage 块里取 provider 报的真值。
 * 不碰被测代码——探针只旁观。
 *
 * 用法（会真花钱，约 0.3–0.5 元/次）：
 *   KYCLAW_R67_REAL=1 KYCLAW_R67_TASK="简单查下今天的新闻，做个简报 PPT 给我，简单做下就行" \
 *     pnpm exec vitest run src/main/agent/__tests__/_r67-real.spec.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { resolveModel } from '../../model'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'

const requested = process.env.KYCLAW_R67_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r67-probe')

const BASE_URL = process.env.KYCLAW_R67_BASE ?? 'https://api.deepseek.com'
const API_KEY = process.env.KYCLAW_R67_KEY ?? ''

/** 门开一半（REAL=1 但 KEY 空）时说清为什么跳过：本文件**不提供任何默认密钥** */
if (requested && API_KEY === '') {
  console.warn('[R67] KYCLAW_R67_REAL=1 但 KYCLAW_R67_KEY 为空——真服务探针跳过（没有默认密钥可用）')
}
const enabled = requested && API_KEY !== ''
const MODEL = process.env.KYCLAW_R67_MODEL ?? 'deepseek-flash'
const TASK = process.env.KYCLAW_R67_TASK ?? '简单查下今天的新闻，做个简报 PPT 给我，简单做下就行'
const LABEL = process.env.KYCLAW_R67_LABEL ?? 'run'

/** 一次真发出去的请求（旁观记录） */
interface SeenRequest {
  url: string
  bodyChars: number
  messageCount: number
  toolCount: number
  systemChars: number
  toolsChars: number
  /** provider 回的 usage（SSE 尾部 include_usage 块；拿不到就是 null） */
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
}

/** SSE 文本 → 最后那个带 usage 的块 */
function usageOfSse(text: string): SeenRequest['usage'] {
  let found: SeenRequest['usage'] = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as {
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_cache_hit_tokens?: number
        }
      }
      if (parsed.usage !== undefined && parsed.usage !== null) {
        found = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          cachedTokens: parsed.usage.prompt_cache_hit_tokens ?? 0
        }
      }
    } catch {
      // 非 JSON 的行（注释/心跳）跳过
    }
  }
  return found
}

/** 工作区里的产出（相对路径 + 字节数） */
function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${full.slice(root.length + 1)} (${statSync(full).size} bytes)`)
    }
  }
  walk(root)
  return out
}

describe.runIf(enabled)('R67 探针 B：真模型每轮开销与记账口径', () => {
  it(
    '跑一次 PPT 任务，抓每次请求的载荷与 provider usage',
    async () => {
      mkdirSync(evidenceDir, { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r67-real-'))
      const ws = join(dir, 'ws')
      mkdirSync(ws, { recursive: true })
      const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
      const provider: ProviderConfig = {
        id: 'deepseek',
        type: 'openai-compatible',
        baseUrl: BASE_URL,
        model: MODEL,
        isDefault: true
      }
      writeSettings(settingsPath(dir), {
        ...defaultSettings(),
        providers: [provider],
        workspaces,
        defaultWorkspace: ws
      })

      const host = new URL(BASE_URL).host
      const seen: SeenRequest[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes(host)) return originalFetch(input, init)

        let record: SeenRequest | null = null
        try {
          const raw = typeof init?.body === 'string' ? init.body : ''
          const parsed = JSON.parse(raw) as {
            messages?: Array<{ role?: string; content?: unknown }>
            tools?: unknown[]
          }
          const messages = parsed.messages ?? []
          const tools = parsed.tools ?? []
          const systemText = messages
            .filter((message) => message.role === 'system')
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content ?? '')
            )
            .join('\n')
          record = {
            url,
            bodyChars: raw.length,
            messageCount: messages.length,
            toolCount: tools.length,
            systemChars: systemText.length,
            toolsChars: JSON.stringify(tools).length,
            usage: null
          }
          seen.push(record)
        } catch {
          // 不是 JSON 体的请求（理论上没有）就不记
        }

        const response = await originalFetch(input, init)
        if (record !== null) {
          const clone = response.clone()
          void clone
            .text()
            .then((text) => {
              record.usage = usageOfSse(text)
            })
            .catch(() => {})
        }
        return response
      }) as typeof globalThis.fetch

      let server: AgentServerHandle | undefined
      try {
        server = await startAgentServer({
          dataDir: dir,
          resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
          workspaces: () => workspaces,
          defaultWorkspace: () => ws,
          projects: () => []
        })

        const started = Date.now()
        const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
          body: JSON.stringify({
            messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: TASK }] }],
            memory: { thread: `r67-${LABEL}`, resource: 'local-user' }
          })
        })
        expect(response.status).toBe(200)
        await response.text()
        await new Promise((r) => setTimeout(r, 2_000))
        const durationMs = Date.now() - started

        const usage = (await fetch(`${server.baseUrl}/api/usage/context?threadId=r67-${LABEL}`, {
          headers: { authorization: `Bearer ${server.token}` }
        }).then((r) => r.json())) as Record<string, unknown>

        const withUsage = seen.filter((request) => request.usage !== null)
        const sumPrompt = withUsage.reduce((sum, item) => sum + (item.usage?.promptTokens ?? 0), 0)
        const sumCached = withUsage.reduce((sum, item) => sum + (item.usage?.cachedTokens ?? 0), 0)
        const last = withUsage[withUsage.length - 1]

        const report = {
          label: LABEL,
          task: TASK,
          model: MODEL,
          durationMs,
          llmCallCount: seen.length,
          sumPromptTokens: sumPrompt,
          sumCachedTokens: sumCached,
          lastCallPromptTokens: last?.usage?.promptTokens ?? null,
          firstCall: seen[0] ?? null,
          usageRunsRow: usage,
          requests: seen,
          produced: listFiles(ws)
        }
        writeFileSync(
          join(evidenceDir, `_r67-real-${LABEL}.json`),
          `${JSON.stringify(report, null, 2)}\n`
        )
        console.log(
          `[r67-B] LLM 调用 ${seen.length} 次；Σprompt=${sumPrompt}（Σcache=${sumCached}）；最后一次 prompt=${last?.usage?.promptTokens ?? 'n/a'}`
        )
        console.log(`[r67-B] usage_runs 口径回包：${JSON.stringify(usage)}`)
        console.log(
          `[r67-B] 耗时 ${(durationMs / 1000).toFixed(1)}s；产出 ${report.produced.join('、')}`
        )
        expect(seen.length).toBeGreaterThan(0)
      } finally {
        globalThis.fetch = originalFetch
        await server?.stop()
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          console.warn('[kyclaw] r67 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
        }
      }
    },
    20 * 60 * 1000
  )
})
