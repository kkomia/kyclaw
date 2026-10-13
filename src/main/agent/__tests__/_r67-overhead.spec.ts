// @vitest-environment node
/**
 * R67 探针 A：**每轮固定开销的实测**（系统提示词 + 工具定义，逐项计数）。
 *
 * 为什么要这个探针：用户在上下文面板看到「系统提示词/工具定义 ≈ 221K tokens」，需要回答
 * "这 221K 到底是真发出去的量，还是记账口径的产物"。只有把**真发给 provider 的那一份载荷**
 * 抓下来逐项数，才有资格下结论。
 *
 * 做法：MockLanguageModelV4 的 `doStream(options)` 收到的 `options.prompt` / `options.tools`
 * 就是 AI SDK 转换后、准备发给 provider 的**终态载荷**（与真模型的差异只在传输层）。抓它 =
 * 抓到了模型真正看到的东西。零网络、可重复。
 *
 * token 口径：`estimateTokens`（`src/mastra/compaction.ts`，3 字符/token 的经验折算）。
 * 这是**估算**；中英混排时误差约 ±15%（英文约 4 字符/token，中文约 1.5–2 字符/token，
 * 我们的载荷以中文为主、夹英文标识符）。真值由探针 B 的 provider usage 给出。
 *
 * 三个场景：
 *   A 基线 = 只有内置工具，没有技能目录；
 *   B + 内置技能目录（resources/skills，指令里的 `<available_skills>` 清单）；
 *   C + 用户真装的 MCP server（kybase，设置里的启用项）——需要网络，连不上就如实标注。
 *
 * 用法：KYCLAW_R67_REAL=1 pnpm exec vitest run src/main/agent/__tests__/_r67-overhead.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { estimateTokens } from '../../../mastra/compaction'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type McpServerConfig, type Workspace } from '../../../shared/settings'

const enabled = process.env.KYCLAW_R67_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r67-probe')

/** 用户真装的那个 MCP server（探针 C 用；与 %APPDATA%/kyclaw/settings.json 同一条配置） */
const KYBASE: McpServerConfig = {
  id: 'mcp-1',
  name: 'kybase',
  transport: 'http',
  url: 'http://100.66.1.12:8765/mcp',
  headers: { Authorization: 'Bearer kylab_sk_YaTge9q_9Hoo_wzzhcKHFcPTSCVYdxTvLUCRmJSQpo0' },
  enabled: true,
  readOnlyTools: []
}

/** 抓到的"终态载荷"（provider 视角） */
interface Captured {
  system: string
  tools: Array<{ name: string; chars: number; descChars: number; schemaChars: number }>
  /** 原始工具定义（provider 视角的那一份，逐字留档以便对比 before/after） */
  rawTools: unknown[]
  promptMessages: Array<{ role: string; chars: number }>
}

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

function partsOf(prompt: unknown): Array<{ role: string; chars: number }> {
  const list = Array.isArray(prompt) ? prompt : []
  return list.map((message) => {
    const entry = message as { role?: unknown; content?: unknown }
    return {
      role: typeof entry.role === 'string' ? entry.role : 'unknown',
      chars: JSON.stringify(entry.content ?? '').length
    }
  })
}

/** 从 AI SDK 转换后的 prompt 里取 system 文本（v4 spec：content 是 part 数组） */
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

/** 一次「跑一轮空对话」：抓载荷，然后回一段纯文本收尾 */
async function captureOnce(options: {
  skillsDir?: string | null
  mcpServers?: readonly McpServerConfig[]
  mcpWaitMs?: number
}): Promise<{ captured: Captured; dir: string; server: AgentServerHandle }> {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r67-'))
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces,
    defaultWorkspace: ws,
    mcpServers: (options.mcpServers ?? []) as never
  })

  let captured: Captured | null = null
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r67-mock',
    modelId: 'kyclaw-r67-mock',
    doStream: async (callOptions) => {
      const raw = callOptions as unknown as {
        prompt?: unknown
        tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
      }
      const tools = (raw.tools ?? []).map((tool) => ({
        name: String(tool.name ?? ''),
        chars: JSON.stringify(tool).length,
        descChars: String(tool.description ?? '').length,
        schemaChars: JSON.stringify(tool.inputSchema ?? {}).length
      }))
      captured = {
        system: systemTextOf(raw.prompt),
        tools,
        rawTools: (raw.tools ?? []) as unknown[],
        promptMessages: partsOf(raw.prompt)
      }
      const script: StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'r67' },
        { type: 'text-delta', id: 'r67', delta: '好的。' },
        { type: 'text-end', id: 'r67' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
      ]
      return {
        stream: simulateReadableStream({ chunks: script, initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  const server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => workspaces,
    defaultWorkspace: () => ws,
    projects: () => [],
    builtinSkillsDir: options.skillsDir ?? null,
    ...(options.mcpServers === undefined
      ? {}
      : { mcpServers: () => options.mcpServers as readonly McpServerConfig[] })
  })

  if (options.mcpWaitMs !== undefined) await new Promise((r) => setTimeout(r, options.mcpWaitMs))

  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }],
      memory: { thread: 'r67-overhead', resource: 'local-user' }
    })
  })
  await response.text()
  if (captured === null) throw new Error('没抓到载荷：mock 没被调用')
  return { captured, dir, server }
}

describe.runIf(enabled)('R67 探针 A：每轮固定开销逐项计数', () => {
  const report: Record<string, unknown> = {}

  beforeAll(() => {
    mkdirSync(evidenceDir, { recursive: true })
  })

  afterAll(() => {
    writeFileSync(join(evidenceDir, '_r67-overhead.json'), `${JSON.stringify(report, null, 2)}\n`)
  })

  it('A 基线（内置工具，无技能目录）', async () => {
    const { captured, dir, server } = await captureOnce({})
    try {
      const toolsChars = captured.tools.reduce((sum, tool) => sum + tool.chars, 0)
      report.A = {
        toolCount: captured.tools.length,
        systemChars: captured.system.length,
        toolsChars,
        totalChars: captured.system.length + toolsChars,
        systemTokensEst: estimateTokens(captured.system.length),
        toolsTokensEst: estimateTokens(toolsChars),
        totalTokensEst: estimateTokens(captured.system.length + toolsChars),
        tools: [...captured.tools].sort((a, b) => b.chars - a.chars)
      }
      writeFileSync(join(evidenceDir, '_r67-system-prompt.txt'), captured.system)
      writeFileSync(
        join(evidenceDir, `_r67-tools-${process.env.KYCLAW_R67_LABEL ?? 'a'}.json`),
        `${JSON.stringify(captured.rawTools, null, 2)}\n`
      )
      console.log('[r67-A]', JSON.stringify(report.A))
      expect(captured.tools.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r67 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  }, 120_000)

  it('B + 内置技能清单（resources/skills）', async () => {
    const { captured, dir, server } = await captureOnce({
      skillsDir: join(repoRoot, 'resources', 'skills')
    })
    try {
      const toolsChars = captured.tools.reduce((sum, tool) => sum + tool.chars, 0)
      report.B = {
        toolCount: captured.tools.length,
        systemChars: captured.system.length,
        toolsChars,
        totalChars: captured.system.length + toolsChars,
        totalTokensEst: estimateTokens(captured.system.length + toolsChars),
        systemPrompt: captured.system
      }
      writeFileSync(join(evidenceDir, '_r67-system-prompt-skills.txt'), captured.system)
      console.log('[r67-B] systemChars', captured.system.length, 'toolsChars', toolsChars)
      expect(captured.system).toContain('技能')
    } finally {
      await server.stop()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r67 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  }, 120_000)

  it('C + 用户实装的 MCP server（kybase）', async () => {
    const { captured, dir, server } = await captureOnce({
      mcpServers: [KYBASE],
      mcpWaitMs: 8_000
    })
    try {
      const builtin = captured.tools.filter((tool) => !tool.name.startsWith('mcp__'))
      const mcp = captured.tools.filter((tool) => tool.name.startsWith('mcp__'))
      const chars = (list: typeof captured.tools): number =>
        list.reduce((sum, tool) => sum + tool.chars, 0)
      report.C = {
        toolCount: captured.tools.length,
        builtinCount: builtin.length,
        mcpCount: mcp.length,
        mcpChars: chars(mcp),
        totalChars: captured.system.length + chars(captured.tools),
        totalTokensEst: estimateTokens(captured.system.length + chars(captured.tools)),
        mcpTools: [...mcp].sort((a, b) => b.chars - a.chars)
      }
      console.log('[r67-C] mcpCount', mcp.length, 'mcpChars', chars(mcp))
      // MCP 可达才断言；不可达时 lifecycle 会把工具拿掉（这是它的既定行为，不是本探针的判据）
      if (mcp.length > 0) expect(mcp[0]?.name.startsWith('mcp__')).toBe(true)
    } finally {
      await server.stop()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r67 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  }, 120_000)
})
