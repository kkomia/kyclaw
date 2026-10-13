// @vitest-environment node
/**
 * R69 探针 A：**系统指令重构前后的固定开销逐项计数**（同一台机器、同一套装配、同一份载荷）。
 *
 * 为什么用这份而不是 r67 的那份：r69 要的是**可对比的 before/after**——同一个探针跑两遍，
 * 只靠 `KYCLAW_R69_LABEL` 区分（before / after），产出的 system 文本与工具定义逐字留档。
 * 抓法与 r67 一致：MockLanguageModelV4 的 `doStream(options)` 收到的是 AI SDK 转换后、准备发给
 * provider 的**终态载荷**，也就是模型真正看到的东西（零网络、可重复）。
 *
 * 计数口径：
 *   - 字符数 = `String.length`（UTF-16 码元，中文一字一码元）；
 *   - token 数 = **不用估算**——真值由 `_r69-token-count.mjs` 直接拿 DeepSeek 的 prompt_tokens
 *     （那份脚本读的就是本探针写出来的 `_r69-<label>-system.txt` / `_r69-<label>-tools.json`）。
 *
 * 用法：
 *   KYCLAW_R69_REAL=1 KYCLAW_R69_LABEL=before pnpm exec vitest run src/main/agent/__tests__/_r69-overhead.spec.ts
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
import { defaultSettings, type Workspace } from '../../../shared/settings'

const enabled = process.env.KYCLAW_R69_REAL === '1'
const LABEL = process.env.KYCLAW_R69_LABEL ?? 'before'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r69-probe')

interface Captured {
  system: string
  tools: Array<{ name: string; chars: number; descChars: number; schemaChars: number }>
  rawTools: unknown[]
}

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
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

async function captureOnce(): Promise<{
  captured: Captured
  dir: string
  server: AgentServerHandle
}> {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r69-'))
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces,
    defaultWorkspace: ws
  })

  let captured: Captured | null = null
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r69-mock',
    modelId: 'kyclaw-r69-mock',
    doStream: async (callOptions) => {
      const raw = callOptions as unknown as {
        prompt?: unknown
        tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
      }
      captured = {
        system: systemTextOf(raw.prompt),
        tools: (raw.tools ?? []).map((tool) => ({
          name: String(tool.name ?? ''),
          chars: JSON.stringify(tool).length,
          descChars: String(tool.description ?? '').length,
          schemaChars: JSON.stringify(tool.inputSchema ?? {}).length
        })),
        rawTools: (raw.tools ?? []) as unknown[]
      }
      const script: StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'r69' },
        { type: 'text-delta', id: 'r69', delta: '好的。' },
        { type: 'text-end', id: 'r69' },
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
    // 带内置技能目录（resources/skills）：指令尾部的那一层要一起计入
    builtinSkillsDir: join(repoRoot, 'resources', 'skills')
  })

  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }],
      memory: { thread: `r69-${LABEL}`, resource: 'local-user' }
    })
  })
  await response.text()
  if (captured === null) throw new Error('没抓到载荷：mock 没被调用')
  return { captured, dir, server }
}

describe.runIf(enabled)('R69 探针 A：系统指令与工具定义的固定开销（before/after 同法计数）', () => {
  let dir = ''
  let server: AgentServerHandle | undefined
  let captured: Captured | null = null

  beforeAll(async () => {
    mkdirSync(evidenceDir, { recursive: true })
    const run = await captureOnce()
    dir = run.dir
    server = run.server
    captured = run.captured
  })

  afterAll(async () => {
    if (captured !== null) {
      const toolsChars = captured.tools.reduce((sum, tool) => sum + tool.chars, 0)
      writeFileSync(join(evidenceDir, `_r69-${LABEL}-system.txt`), captured.system)
      writeFileSync(
        join(evidenceDir, `_r69-${LABEL}-tools.json`),
        `${JSON.stringify(captured.rawTools, null, 2)}\n`
      )
      writeFileSync(
        join(evidenceDir, `_r69-${LABEL}-capture.json`),
        `${JSON.stringify(
          {
            label: LABEL,
            systemChars: captured.system.length,
            systemLines: captured.system.split('\n').length,
            systemTokensEst: estimateTokens(captured.system.length),
            toolCount: captured.tools.length,
            toolsChars,
            toolsTokensEst: estimateTokens(toolsChars),
            totalChars: captured.system.length + toolsChars,
            tools: [...captured.tools].sort((a, b) => b.chars - a.chars)
          },
          null,
          2
        )}\n`
      )
      console.log(
        `[r69-A:${LABEL}] system=${captured.system.length} 字符 / ${captured.system.split('\n').length} 行；tools=${toolsChars} 字符（${captured.tools.length} 件）`
      )
    }
    await server?.stop()
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r69 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  })

  it('抓到了系统指令与工具定义', () => {
    expect(captured?.system ?? '').toContain('kyclaw')
    expect((captured?.tools ?? []).length).toBeGreaterThan(0)
  })
})
