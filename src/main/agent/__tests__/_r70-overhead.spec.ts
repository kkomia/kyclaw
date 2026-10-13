// @vitest-environment node
/**
 * R70 探针：**固定开销的逐项真值**（round 70 的第二刀）。
 *
 * 沿用 r69 探针 A 的抓法与计数口径（同一台机器、同一套装配、同一份载荷），差别只有两处：
 *   ① 标签换成 `KYCLAW_R70_LABEL`（before / after），产出 `_r70-<label>-system.txt` / `-tools.json`；
 *   ② 额外导出 **working memory 指令块的两种形态**（Mastra 的稳定档 / vnext 档）——C-1 要判断
 *      "438 token 的英文样板能不能在不降能力的前提下缩短"，只有把两种形态逐字取出来才谈得上量化。
 *
 * 计数口径：字符数 = `String.length`；token 数**不估算** —— 由同目录的 `_r70-token-count.mjs`
 * 拿 DeepSeek 真分词器读 `usage.prompt_tokens`。
 *
 * 用法：
 *   KYCLAW_R70_REAL=1 KYCLAW_R70_LABEL=before pnpm exec vitest run src/main/agent/__tests__/_r70-overhead.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { estimateTokens } from '../../../mastra/compaction'
import { KYCLAW_WORKING_MEMORY_TEMPLATE } from '../../../mastra/index'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'

const enabled = process.env.KYCLAW_R70_REAL === '1'
const LABEL = process.env.KYCLAW_R70_LABEL ?? 'before'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r70-probe')

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
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r70-'))
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
    provider: 'kyclaw-r70-mock',
    modelId: 'kyclaw-r70-mock',
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
        { type: 'text-start', id: 'r70' },
        { type: 'text-delta', id: 'r70', delta: '好的。' },
        { type: 'text-end', id: 'r70' },
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
    builtinSkillsDir: join(repoRoot, 'resources', 'skills')
  })

  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }],
      memory: { thread: `r70-${LABEL}`, resource: 'local-user' }
    })
  })
  await response.text()
  if (captured === null) throw new Error('没抓到载荷：mock 没被调用')
  return { captured, dir, server }
}

/**
 * working memory 指令块的两种形态（C-1 的判据）：都是 **@mastra/memory 自己生成的**文本，
 * 用同一个 `this` + 我们自己的模板 + 空数据。这里刻意不在测试里复制那两段英文样板：
 * 抄一份就等于量了一份不存在的东西。
 *
 * `defaultWorkingMemoryTemplate` 在库的实例字段上（原型上没有），这里给 undefined —— 它只在
 * vnext 档用来选"是否只存模板里的字段"那句注解，而我们的中文模板本来就 ≠ 库的英文默认模板，
 * 分支与真实运行完全一致。
 */
async function workingMemoryVariants(): Promise<{ stable: string; vnext: string }> {
  const { Memory } = await import('@mastra/memory')
  const proto = Memory.prototype as unknown as Record<string, (...args: unknown[]) => string>
  const fakeThis = { defaultWorkingMemoryTemplate: Memory.prototype.defaultWorkingMemoryTemplate }
  // 库的 getWorkingMemoryTemplate 会给模板做一次 `.trim()`（dist 的 34024 行）——这里照做
  const args = [
    { template: { format: 'markdown', content: KYCLAW_WORKING_MEMORY_TEMPLATE.trim() }, data: '' }
  ]
  return {
    stable: proto.getWorkingMemoryToolInstruction.call(fakeThis, ...args),
    vnext: proto.__experimental_getWorkingMemoryToolInstructionVNext.call(fakeThis, ...args)
  }
}

describe.runIf(enabled)('R70 探针：固定开销逐项计数（before/after 同法）', () => {
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
      writeFileSync(join(evidenceDir, `_r70-${LABEL}-system.txt`), captured.system)
      writeFileSync(
        join(evidenceDir, `_r70-${LABEL}-tools.json`),
        `${JSON.stringify(captured.rawTools, null, 2)}\n`
      )
      writeFileSync(
        join(evidenceDir, `_r70-${LABEL}-capture.json`),
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
        `[r70:${LABEL}] system=${captured.system.length} 字符 / ${captured.system.split('\n').length} 行；tools=${toolsChars} 字符（${captured.tools.length} 件）`
      )
    }
    await server?.stop()
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r70 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  })

  it('抓到了系统指令与工具定义', () => {
    expect(captured?.system ?? '').toContain('kyclaw')
    expect((captured?.tools ?? []).length).toBeGreaterThan(0)
  })

  it('导出 working memory 指令块的两种形态（稳定档 / vnext 档）', async () => {
    const { stable, vnext } = await workingMemoryVariants()
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, '_r70-wm-stable.txt'), stable)
    writeFileSync(join(evidenceDir, '_r70-wm-vnext.txt'), vnext)

    // 稳定档就是每轮真的进系统消息的那一段（拿系统指令里的原句对一下，防止这里量错东西）
    expect(captured?.system ?? '').toContain(stable)
    // 两种形态的**长短不写死**在这里：vnext 那段注解比稳定档的长（实测），断言方向只会误导
    expect(vnext).not.toBe(stable)
  })
})
