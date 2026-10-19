// @vitest-environment node
/**
 * R69 探针 B：**行为回归** —— 真模型跑一个"看目录 → 写 md"的简单任务，
 * 把它的**工具调用序列**逐条留档，用来验证指令里的成对否定式（用 read/glob/grep，
 * 不要 `cat` / `dir /s` / `findstr`）真的把模型约束在专用工具上。
 *
 * 做法：把 `globalThis.fetch` 包一层，凡打到 provider 主机的请求都记下请求体；
 * 请求体里的 `messages[].tool_calls` 就是**历次助手回合调用过的工具**（OpenAI 协议口径），
 * 按 id 去重即得完整序列。不碰被测代码。
 *
 * 用法（会真花钱）：
 *   KYCLAW_R69_REAL=1 KYCLAW_R69_LABEL=after pnpm exec vitest run src/main/agent/__tests__/_r69-behavior.spec.ts
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
import { afterAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { resolveModel } from '../../model'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'

const requested = process.env.KYCLAW_R69_REAL === '1'
const LABEL = process.env.KYCLAW_R69_LABEL ?? 'after'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r69-probe')

const BASE_URL = process.env.KYCLAW_R69_BASE ?? 'https://api.deepseek.com'
const API_KEY = process.env.KYCLAW_R69_KEY ?? ''

/** 门开一半（REAL=1 但 KEY 空）时说清为什么跳过：本文件**不提供任何默认密钥** */
if (requested && API_KEY === '') {
  console.warn('[R69] KYCLAW_R69_REAL=1 但 KYCLAW_R69_KEY 为空——真服务探针跳过（没有默认密钥可用）')
}
const enabled = requested && API_KEY !== ''
const MODEL = process.env.KYCLAW_R69_MODEL ?? 'deepseek-flash'
const TASK = process.env.KYCLAW_R69_TASK ?? '看下这个目录里有什么文件，随便写个 md 总结一下'
/** 会话 id（前 8 位决定会话根目录名；两次对照必须一致） */
const THREAD = 'r69-behavior-task'

/** 一条被调用过的工具（从请求体里抓的） */
interface ToolCallRecord {
  id: string
  name: string
  args: string
}

let server: AgentServerHandle | undefined
let dir = ''
let sessionDir = ''
/** 助手回复正文（从 SSE 的 text-delta 里拼） */
let assistantText = ''
const seenToolCalls = new Map<string, ToolCallRecord>()
const requestLog: Array<{
  messageCount: number
  toolCount: number
  systemChars: number
  promptTokens: number | null
}> = []
let finished = false

/** 会话根里最后留下的文件（相对路径 + 字节数） */
function listFiles(root: string): string[] {
  if (root === '' || !existsSync(root)) return []
  const out: string[] = []
  const walk = (where: string): void => {
    for (const entry of readdirSync(where, { withFileTypes: true })) {
      const full = join(where, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${full.slice(root.length + 1)} (${statSync(full).size}B)`)
    }
  }
  walk(root)
  return out.sort()
}

describe.runIf(enabled)('R69 探针 B：真模型跑"看目录 + 写 md"，留档工具调用序列', () => {
  afterAll(async () => {
    if (!finished) return
    const calls = [...seenToolCalls.values()]
    const report = {
      label: LABEL,
      task: TASK,
      model: MODEL,
      toolCalls: calls,
      toolCallNames: calls.map((call) => call.name),
      shellCommands: calls.filter((call) => call.name === 'bash').map((call) => call.args),
      /** 任务真的做完了吗：会话根里最后留下了什么 */
      produced: listFiles(sessionDir),
      /** 回给用户的正文（检查语言） */
      assistantText,
      assistantTextHasCjk: /[\u4e00-\u9fff]/.test(assistantText),
      requests: requestLog
    }
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(
      join(evidenceDir, `_r69-behavior-${LABEL}.json`),
      `${JSON.stringify(report, null, 2)}\n`
    )
    console.log(`[r69-B:${LABEL}] 工具调用序列：${report.toolCallNames.join(' → ')}`)
    for (const call of calls) console.log(`  · ${call.name} ${call.args.slice(0, 160)}`)
    console.log(`[r69-B:${LABEL}] bash 次数：${report.shellCommands.length}`)
    console.log(
      `[r69-B:${LABEL}] 回复含中文：${report.assistantTextHasCjk}；正文 ${assistantText.length} 字`
    )
    console.log(`[r69-B:${LABEL}] 正文开头：${assistantText.slice(0, 160).replace(/\n/g, ' ⏎ ')}`)
    await server?.stop()
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r69 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  })

  it(
    '一轮任务：记录工具调用序列与 shell 使用情况',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'kyclaw-r69-behavior-'))
      const ws = join(dir, 'ws')
      // 无项目会话的根是 `<默认工作区>/tasks/<threadId 前 8 位>`（round 55 的落点规则，
      // 见 shared/session-dir.ts）——样本文件必须造在**会话根里面**，否则模型看到的是空目录，
      // 任务会变成"去工作区外翻找文件"，量出来的就不是"用不用专用工具"了。
      sessionDir = join(ws, 'tasks', THREAD.slice(0, 8).toLowerCase())
      mkdirSync(join(sessionDir, 'notes'), { recursive: true })
      mkdirSync(join(sessionDir, 'src'), { recursive: true })
      writeFileSync(
        join(sessionDir, 'notes', '2026-10-会议记录.md'),
        '# 会议记录\n\n- 排期顺延一周\n'
      )
      writeFileSync(join(sessionDir, 'notes', '待办.md'), '# 待办\n\n- 补测试\n- 改文档\n')
      writeFileSync(join(sessionDir, 'src', 'app.ts'), 'export const hello = (): string => "hi"\n')

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
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes(host)) return originalFetch(input, init)
        try {
          const raw = typeof init?.body === 'string' ? init.body : ''
          const parsed = JSON.parse(raw) as {
            messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown }>
            tools?: unknown[]
          }
          const messages = parsed.messages ?? []
          const systemChars = messages
            .filter((message) => message.role === 'system')
            .map((message) => (typeof message.content === 'string' ? message.content.length : 0))
            .reduce((sum, value) => sum + value, 0)
          requestLog.push({
            messageCount: messages.length,
            toolCount: (parsed.tools ?? []).length,
            systemChars,
            promptTokens: null
          })
          // 助手回合的 tool_calls 就是"调用过的工具"；同一个 id 在后续请求里会重复出现
          for (const message of messages) {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
            for (const call of message.tool_calls as Array<{
              id?: unknown
              function?: { name?: unknown; arguments?: unknown }
            }>) {
              const id = typeof call.id === 'string' ? call.id : ''
              const name = typeof call.function?.name === 'string' ? call.function.name : ''
              if (id === '' || name === '' || seenToolCalls.has(id)) continue
              seenToolCalls.set(id, {
                id,
                name,
                args: typeof call.function?.arguments === 'string' ? call.function.arguments : ''
              })
            }
          }
        } catch {
          // 不是 JSON 体的请求就不记
        }

        const response = await originalFetch(input, init)
        if (response.headers.get('content-type')?.includes('text/event-stream') === true) {
          const clone = response.clone()
          void clone.text().then((text) => {
            let promptTokens: number | null = null
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data === '' || data === '[DONE]') continue
              try {
                const usage = (JSON.parse(data) as { usage?: { prompt_tokens?: number } }).usage
                if (usage?.prompt_tokens !== undefined) promptTokens = usage.prompt_tokens
              } catch {
                // 心跳/注释行
              }
            }
            const last = requestLog[requestLog.length - 1]
            if (last !== undefined && last.promptTokens === null) last.promptTokens = promptTokens
          })
        }
        return response
      }) as typeof globalThis.fetch

      try {
        server = await startAgentServer({
          dataDir: dir,
          resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
          workspaces: () => workspaces,
          defaultWorkspace: () => ws,
          projects: () => []
        })

        const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
          body: JSON.stringify({
            messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: TASK }] }],
            memory: { thread: THREAD, resource: 'local-user' }
          })
        })
        expect(response.status).toBe(200)
        const sse = await response.text()
        // 助手正文（回给用户看的那段）：验"英文指令会不会让模型用英文回答"
        assistantText = [...sse.matchAll(/^data: (.*)$/gm)]
          .map((match) => {
            try {
              const part = JSON.parse(match[1] as string) as {
                type?: string
                delta?: string
                text?: string
              }
              if (part.type === 'text-delta') return part.delta ?? ''
              if (part.type === 'text') return part.text ?? ''
              return ''
            } catch {
              return ''
            }
          })
          .join('')
        finished = true
        // 等一下：usage 是异步从 clone 里读的
        await new Promise((r) => setTimeout(r, 2_000))

        const names = [...seenToolCalls.values()].map((call) => call.name)
        console.log(`[r69-B:${LABEL}] SSE 长度 ${sse.length}；工具调用 ${names.length} 次`)
        expect(names.length).toBeGreaterThan(0)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
    20 * 60 * 1000
  )
})
