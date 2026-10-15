// @vitest-environment node
/**
 * 探针（gated，默认不跑）：用**本机 LM Studio**（无密钥）跑一轮真实多步对话，把 provider 真收到的
 * 每一条请求体逐条留档 —— 回答 round 87（用户反馈 015）设计要用的三件事：
 *
 *   1. **每一步**的请求体长什么样（消息条数 / 角色序列 / 系统指令 / 工具表 / 体量）；
 *   2. 相邻两步之间是"前缀 + 追加"还是别的形状（决定去重口径：能不能只存增量）；
 *   3. 记忆 / 规矩 / 任务上下文这些**注入**以什么角色、什么形状出现（只落会话消息是不够的原因）。
 *
 * 另外一问：**失败的请求**能不能记 —— 第二个用例把端点指到一个死端口，看 onFinish 到底会不会触发。
 *
 * 做法：把 `globalThis.fetch` 包一层（与 `_r69-behavior.spec.ts` 同路数），凡打到本机 LM Studio 的
 * 请求都把**原文**落盘到 `.superpowers/lmstudio-probe/`，并把摘要打出来；不碰被测代码。
 *
 * 跑法：`KYCLAW_R87_LIVE=1 node_modules/.bin/vitest run src/mastra/__tests__/_r87-live-request.spec.ts`
 *
 * ## 2026-10-15 实测结论（这些数就是 round 87 设计的依据）
 *
 *   - 真实请求体（`qwen3.8-27b`、无密钥）：`messages` = **3 条 system**（主指令 11,808 字 +
 *     `WORKING_MEMORY_SYSTEM_INSTRUCTION` 2,013 字 + 「我的规矩」571 字）+ 1 条 user；
 *     `tools` = **35 件**（81,641 字节）；整份 body **96,409 字节**。
 *     → **记忆与规矩只在这里看得到**（`mastra_messages` 只有 user/assistant），这就是用户反馈
 *     015 说的"缺系统上下文注入"；
 *     → 一条请求 ~96 KB：列表不能背它（所以 `/api/trajectory/requests` 只回摘要、正文按 id 取）。
 *   - 该模型装载的上下文只有 8192 token（本机内存装不下更大档：`lms load -c 32768/65536` 都是
 *     "failed to allocate buffer for kv cache"）→ 满编工具表的请求 **被端点 400 打回**
 *     （`request (23951 tokens) exceeds the available context size (8192 tokens)`）。
 *     **多步的逐步请求体因此没能在真端点上取到**（改用真 Mastra loop + mock provider 的
 *     `request-snapshot-e2e.spec.ts` 验逐步；真 provider 这一侧验的是"body 长什么样"）。
 *   - **失败的请求**：`onFinish` **不触发**（没有 step、没有请求体），所以那一轮只在
 *     chat 路由的 UI 消息流里留下 `{ type: 'error', errorText }` ——
 *     `createRequestFailureRecorder` 就是按这条现实接的（实测落下 `status='error'` 那行，
 *     原因带端点的 400 原文）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { resolveModel } from '../model'
import { settingsPath, writeSettings } from '../../main/settings'
import { defaultSettings, type Workspace } from '../../shared/settings'
import type { ProviderConfig } from '../../shared/providers'

const enabled = process.env.KYCLAW_R87_LIVE === '1'
const BASE_URL = process.env.KYCLAW_R87_BASE ?? 'http://127.0.0.1:1234/v1'
const API_KEY = process.env.KYCLAW_R87_KEY ?? 'lm-studio'
const MODEL = process.env.KYCLAW_R87_MODEL ?? 'qwen3.8-27b'
const THREAD = 'r87-live-request'

const OUT_DIR = join(process.cwd(), '.superpowers', 'lmstudio-probe')
let server: AgentServerHandle | undefined

/**
 * 探针的工作目录（2026-10-15 起的新口径）：落**工作区** `.superpowers/test-scratch/` 下，
 * 唯一子目录，**跑完不删**；共享 `TEMP`（`C:\lmstudio-temp`）不再放产物、也一律不清理
 * —— 那天有过一次把共享根目录整个清掉的事故。
 */
function tempDir(label: string): string {
  const value = join(
    process.cwd(),
    '.superpowers',
    'test-scratch',
    `${label}-${randomUUID().slice(0, 8)}`
  )
  mkdirSync(value, { recursive: true })
  return value
}

interface Captured {
  index: number
  messages: Array<{ role: string; contentChars: number; hasImage: boolean; toolCalls: number }>
  roles: string[]
  systemChars: number
  toolCount: number
  bytes: number
  note: string
}

/** 一个角色一条摘要（给日志看形状；正文落盘） */
function outlineOf(parsed: Record<string, unknown>): Captured['messages'] {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  return messages.map((raw) => {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown; tool_calls?: unknown }
    const content = message.content
    const asText = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    return {
      role: typeof message.role === 'string' ? message.role : 'unknown',
      contentChars: asText.length,
      hasImage: asText.includes('image_url') || asText.includes('data:image'),
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0
    }
  })
}

/** 抓 provider 请求（原文落盘 + 摘要） */
function captureProviderRequests(host: string, label: string): Captured[] {
  const captured: Captured[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes(host)) return original(input, init)
    if (typeof init?.body === 'string' && init.body !== '') {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>
        const messages = outlineOf(parsed)
        const index = captured.length + 1
        captured.push({
          index,
          messages,
          roles: messages.map((message) => message.role),
          systemChars: messages
            .filter((message) => message.role === 'system')
            .reduce((sum, message) => sum + message.contentChars, 0),
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          bytes: init.body.length,
          note: url
        })
        mkdirSync(OUT_DIR, { recursive: true })
        writeFileSync(join(OUT_DIR, `${label}-request-${index}.json`), init.body)
      } catch {
        // 不是 JSON 体就不记
      }
    }
    return original(input, init)
  }) as typeof globalThis.fetch
  return captured
}

/** 从一份请求体里看相邻两步的共同前缀（决定"能不能只存增量"） */
function commonPrefix(left: unknown[], right: unknown[]): number {
  let index = 0
  while (index < left.length && index < right.length) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) break
    index += 1
  }
  return index
}

afterAll(async () => {
  await server?.stop()
  // 工作目录留在工作区 `.superpowers/test-scratch/` 下（排障要看；一律不删）
})

describe.skipIf(!enabled)('本机 LM Studio：真实请求体的形状', () => {
  it(
    '一轮多步任务：逐步留档请求体（注入 / 工具结果 / 增量形状）',
    async () => {
      const dir = tempDir('r87-live')
      const ws = join(dir, 'ws')
      const sessionDir = join(ws, 'tasks', THREAD.slice(0, 8).toLowerCase())
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'notes.md'), '# 备忘\n\n- 本机探针用的样本文件\n')

      const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
      const provider: ProviderConfig = {
        id: 'lmstudio',
        type: 'openai-compatible',
        baseUrl: BASE_URL,
        model: MODEL,
        isDefault: true
      }
      writeSettings(settingsPath(dir), {
        ...defaultSettings(),
        providers: [provider],
        workspaces
      })

      const host = new URL(BASE_URL).host
      const captured = captureProviderRequests(host, 'r87-live')
      const original = globalThis.fetch

      try {
        server = await startAgentServer({
          dataDir: dir,
          resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
          workspaces: () => workspaces,
          defaultWorkspace: () => ws,
          projects: () => [],
          rules: {
            readGlobalRules: () => ({ text: '回答尽量短。', diagnostics: [] }),
            readProjectRules: () => ({ text: '', diagnostics: [] })
          }
        })

        const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
          body: JSON.stringify({
            messages: [
              {
                id: 'u-1',
                role: 'user',
                parts: [
                  {
                    type: 'text',
                    text: '请先用 read 工具读一下 notes.md，然后用一句话告诉我它写了什么。'
                  }
                ]
              }
            ],
            memory: { thread: THREAD, resource: 'local-user' }
          })
        })
        const sse = await response.text()
        if (response.status !== 200) console.log(`[r87-live] 非 200 响应体：${sse.slice(0, 500)}`)
        expect(response.status).toBe(200)

        console.log(
          [
            `[r87-live] SSE ${sse.length} 字节 · provider 请求 ${captured.length} 条`,
            ...captured.map(
              (entry) =>
                `  · #${entry.index} 消息 ${entry.messages.length} 条 [${entry.roles.join(', ')}] · system ${entry.systemChars} 字 · 工具 ${entry.toolCount} 个 · ${entry.bytes} 字节`
            )
          ].join('\n')
        )

        // 相邻两步的共同前缀（决定去重口径）
        const bodies = captured.map((entry) => {
          const path = join(OUT_DIR, `r87-live-request-${entry.index}.json`)
          const raw = ((): unknown => {
            try {
              return JSON.parse(readFileSync(path, 'utf8'))
            } catch {
              return {}
            }
          })()
          const messages = (raw as { messages?: unknown[] }).messages ?? []
          return { messages, hasImage: entry.messages.some((message) => message.hasImage) }
        })
        for (let index = 1; index < bodies.length; index += 1) {
          const previous = bodies[index - 1]
          const current = bodies[index]
          console.log(
            `[r87-live] #${index} → #${index + 1}：前一步 ${previous.messages.length} 条 · 共同前缀 ${commonPrefix(previous.messages, current.messages)} 条 · 后一步 ${current.messages.length} 条`
          )
        }

        // 我们的记录器现在收到了什么（round 87 的读侧）
        const recorded = await fetch(
          `${server.baseUrl}/api/trajectory/requests?threadId=${encodeURIComponent(THREAD)}`,
          { headers: { authorization: `Bearer ${server.token}` } }
        )
        const payload = (await recorded.json()) as {
          requests?: Array<Record<string, unknown>>
          error?: unknown
        }
        console.log(
          `[r87-live] /api/trajectory/requests → ${JSON.stringify(payload).slice(0, 800)}`
        )
        const failed = sse.includes('"type":"error"')
        console.log(
          `[r87-live] SSE 里带 error part = ${failed}；记账行数 = ${payload.requests?.length ?? 0}`
        )
        // 真端点把这一轮打回（8k 上下文装不下满编工具表）→ 应当留下一行 status=error；
        // 成功能跑完时则应当是逐步的 complete 行（两种都算这条探针跑通，结论写进 report）
        if (failed) {
          expect(payload.requests?.some((row) => row.status === 'error')).toBe(true)
        }
        expect(captured.length).toBeGreaterThan(0)
      } finally {
        globalThis.fetch = original
      }
    },
    10 * 60 * 1000
  )

  it(
    '失败的请求：端点不可达时 onFinish 会不会触发、能记下什么',
    async () => {
      const dir = tempDir('r87-live-fail')
      const dead: ProviderConfig = {
        id: 'dead',
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'dead-model',
        isDefault: true
      }
      writeSettings(settingsPath(dir), {
        ...defaultSettings(),
        providers: [dead],
        workspaces: []
      })
      const original = globalThis.fetch
      try {
        server = await startAgentServer({ dataDir: dir })
        const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
          body: JSON.stringify({
            messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }],
            memory: { thread: 'r87-live-fail', resource: 'local-user' }
          })
        })
        const body = await response.text()
        console.log(`[r87-live] 失败一轮：HTTP ${response.status} · SSE ${body.length} 字节`)
        const recorded = await fetch(
          `${server.baseUrl}/api/trajectory/requests?threadId=${encodeURIComponent('r87-live-fail')}`,
          { headers: { authorization: `Bearer ${server.token}` } }
        )
        console.log(
          `[r87-live] 失败一轮 /api/trajectory/requests → ${JSON.stringify(await recorded.json()).slice(0, 400)}`
        )
      } finally {
        globalThis.fetch = original
      }
    },
    3 * 60 * 1000
  )
})
