// @vitest-environment node
/**
 * R75 探针 A：**渐进披露前后的每轮固定开销**逐字留档（同一台机器、同一套装配、真 kybase）。
 *
 * 抓法与 r69 探针 A 一致：MockLanguageModelV4 的 `doStream(options)` 收到的是 AI SDK 转换后、
 * 准备发给 provider 的**终态载荷**（模型真正看到的那份 tools 数组），零网络、可重复。
 * token 真值由 `_r75-token-count.mjs` 拿 DeepSeek 的 prompt_tokens 量（读的就是本探针写出的
 * `_r75-<label>-system.txt` / `_r75-<label>-tools.json`）。
 *
 * 两个 label 由**代码状态**区分（与 r69 同法）：
 *   - before：lifecycle 的渐进披露关掉（`threshold: Infinity`，逐件注入）；
 *   - after：默认（阈值 3，kybase 的 11 件换成 1 个元工具）。
 *
 * 用法：
 *   KYCLAW_R75_REAL=1 KYCLAW_R75_LABEL=before pnpm exec vitest run src/main/mcp/__tests__/_r75-overhead.spec.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { McpLifecycle } from '../lifecycle'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { estimateTokens } from '../../../mastra/compaction'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type McpServerConfig, type Workspace } from '../../../shared/settings'

const enabled = process.env.KYCLAW_R75_REAL === '1'
const LABEL = process.env.KYCLAW_R75_LABEL ?? 'after'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r75-mcp-pd')
/** 真实用户设置（kybase 那条就在这里）；默认红覆盖成临时设置也能跑 */
const userSettings =
  process.env.KYCLAW_SETTINGS ?? join(process.env.APPDATA ?? '', 'kyclaw', 'settings.json')

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

function mcpServersFromUserSettings(): McpServerConfig[] {
  const parsed = JSON.parse(readFileSync(userSettings, 'utf8')) as {
    mcpServers?: McpServerConfig[]
  }
  return (parsed.mcpServers ?? []).filter((server) => server.enabled)
}

function systemTextOf(prompt: unknown): string {
  const list = Array.isArray(prompt) ? prompt : []
  return list
    .filter((message) => (message as { role?: unknown }).role === 'system')
    .map((message) => {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .flatMap((part) =>
          typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
            ? [String((part as { text?: unknown }).text ?? '')]
            : []
        )
        .join('\n')
    })
    .join('\n\n')
}

describe.runIf(enabled)('R75 探针 A：MCP 工具定义进请求前缀的固定开销（before/after）', () => {
  let dir = ''
  let server: AgentServerHandle | undefined
  let system = ''
  let rawTools: unknown[] = []

  beforeAll(async () => {
    mkdirSync(evidenceDir, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-r75-'))
    const ws = join(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      workspaces,
      defaultWorkspace: ws,
      mcpServers: mcpServersFromUserSettings()
    })

    const model = new MockLanguageModelV4({
      provider: 'kyclaw-r75-mock',
      modelId: 'kyclaw-r75-mock',
      doStream: async (callOptions) => {
        const raw = callOptions as unknown as { prompt?: unknown; tools?: unknown[] }
        system = systemTextOf(raw.prompt)
        rawTools = raw.tools ?? []
        const script: StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'r75' },
          { type: 'text-delta', id: 'r75', delta: '好的。' },
          { type: 'text-end', id: 'r75' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: USAGE
          }
        ]
        return {
          stream: simulateReadableStream({ chunks: script, initialDelayInMs: 0, chunkDelayInMs: 0 })
        }
      }
    })

    server = await startAgentServer({
      dataDir: dir,
      model,
      workspaces: () => workspaces,
      defaultWorkspace: () => ws,
      projects: () => []
    })

    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }],
        memory: { thread: `r75-${LABEL}`, resource: 'local-user' }
      })
    })
    await response.text()
  }, 120_000)

  afterAll(async () => {
    if (rawTools.length > 0) {
      const rows = (rawTools as Array<{ name?: string; description?: string }>).map((tool) => ({
        name: String(tool.name ?? ''),
        chars: JSON.stringify(tool).length,
        descChars: String(tool.description ?? '').length
      }))
      const mcp = rows.filter((row) => row.name.startsWith('mcp__'))
      const toolsChars = rows.reduce((sum, row) => sum + row.chars, 0)
      writeFileSync(join(evidenceDir, `_r75-${LABEL}-system.txt`), system)
      writeFileSync(
        join(evidenceDir, `_r75-${LABEL}-tools.json`),
        `${JSON.stringify(rawTools, null, 2)}\n`
      )
      writeFileSync(
        join(evidenceDir, `_r75-${LABEL}-capture.json`),
        `${JSON.stringify(
          {
            label: LABEL,
            serverCount: mcpServersFromUserSettings().length,
            systemChars: system.length,
            systemTokensEst: estimateTokens(system.length),
            toolCount: rows.length,
            toolsChars,
            toolsTokensEst: estimateTokens(toolsChars),
            mcpTools: mcp,
            mcpChars: mcp.reduce((sum, row) => sum + row.chars, 0),
            mcpTokensEst: estimateTokens(mcp.reduce((sum, row) => sum + row.chars, 0)),
            all: [...rows].sort((a, b) => b.chars - a.chars)
          },
          null,
          2
        )}\n`
      )
      console.log(
        `[r75-A:${LABEL}] tools=${toolsChars} 字符（${rows.length} 件，其中 MCP ${mcp.length} 件 / ${mcp.reduce((sum, row) => sum + row.chars, 0)} 字符）`
      )

      // 元工具 `list` 的正文（一次性开销）：走同一份生产实现把真 kybase 的工具清单算出来
      const lifecycle = new McpLifecycle({
        servers: () => mcpServersFromUserSettings(),
        timeoutMs: 20_000
      })
      try {
        const table = await lifecycle.tools(() => false)
        const meta = table[`mcp__${mcpServersFromUserSettings()[0]?.id ?? ''}__meta`]
        const execute = meta?.execute as
          ((input: unknown, context: unknown) => Promise<unknown>) | undefined
        if (execute !== undefined) {
          const list = String(await execute.call(meta, { action: 'list' }, {}))
          writeFileSync(join(evidenceDir, '_r75-list.txt'), `${list}\n`)
          console.log(
            `[r75-A:${LABEL}] 元工具 list=${list.length} 字符（${estimateTokens(list.length)} token 估）`
          )
        }
      } finally {
        await lifecycle.stop()
      }
    }
    await server?.stop()
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r75 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  })

  it('抓到了 kybase 的工具定义（渐进披露在前缀上省下的就是这一块）', () => {
    const names = (rawTools as Array<{ name?: string }>).map((tool) => String(tool.name ?? ''))
    expect(names.some((name) => name.startsWith('mcp__'))).toBe(true)
  })
})
