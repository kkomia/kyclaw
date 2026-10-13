// @vitest-environment node
/**
 * R70 探针 C：**zod 校验失败消息到底给谁看** —— 只给模型，还是也会出现在对话里（工具卡结果预览）？
 *
 * 为什么要问：这一轮要把"模型侧文案"改英文，但**同时会出现在界面上**的字符串必须保持中文
 * （工具卡会把 `part.errorText ?? part.output` 直接画在结果预览里，见 renderer 的 ToolCard.tsx）。
 * 校验失败消息是不是这一类，不能靠猜 —— 用一个**越界的入参**真跑一遍，把两条线都留档：
 *   ① 客户端 SSE（渲染端拿到的、用户看得见的那份）里有没有它；
 *   ② 下一次发往 provider 的消息里，工具结果是什么形状（模型看到的那份）。
 *
 * 做法：MockLanguageModelV4 脚本化一次 tool-call（create_ppt 的 title 超过 200 字上限），
 * 之后回一段纯文本收尾。零网络、可重复。
 *
 * 用法：KYCLAW_R70_REAL=1 pnpm exec vitest run src/main/agent/__tests__/_r70-validation.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'

const enabled = process.env.KYCLAW_R70_REAL === '1'
const LABEL = process.env.KYCLAW_R70_LABEL ?? 'zh'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r69-probe')

/** 越界的入参：create_ppt 的 title 上限 200 字，这里给 250 */
const OVERLONG_TITLE = '标'.repeat(250)

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}

describe.runIf(enabled)('R70 探针 C：校验失败消息的可见面', () => {
  it('越界入参 → 看 SSE（用户可见）与下一次请求（模型可见）里各有什么', async () => {
    mkdirSync(evidenceDir, { recursive: true })
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-r70-'))
    const ws = join(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    const workspaces: Workspace[] = [{ path: ws, mode: 'full' }]
    writeSettings(settingsPath(dir), {
      ...defaultSettings(),
      workspaces,
      defaultWorkspace: ws
    })

    const seenBodies: string[] = []
    let call = 0
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-r70-mock',
      modelId: 'kyclaw-r70-mock',
      doStream: async (callOptions) => {
        // 第 2 次及以后：把上一轮的工具结果原样留档，然后收尾
        if (call > 0) {
          seenBodies.push(JSON.stringify((callOptions as unknown as { prompt?: unknown }).prompt))
          const script: StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'r70' },
            { type: 'text-delta', id: 'r70', delta: '收到。' },
            { type: 'text-end', id: 'r70' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE }
          ]
          return {
            stream: simulateReadableStream({ chunks: script, initialDelayInMs: 0, chunkDelayInMs: 0 })
          }
        }
        call += 1
        const script: StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'create_ppt',
            input: JSON.stringify({ title: OVERLONG_TITLE, slides: [{ title: '一页', bullets: ['一个要点'] }] })
          } as StreamPart,
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE }
        ]
        return {
          stream: simulateReadableStream({ chunks: script, initialDelayInMs: 0, chunkDelayInMs: 0 })
        }
      }
    })

    let server: AgentServerHandle | undefined
    try {
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
          messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '做个 PPT' }] }],
          memory: { thread: 'r70-validation', resource: 'local-user' }
        })
      })
      const sse = await response.text()
      await new Promise((r) => setTimeout(r, 1_500))

      const report = {
        label: LABEL,
        overlongTitleChars: OVERLONG_TITLE.length,
        // ① 用户可见的那份：SSE 里出现校验文案了吗
        sseHasTitleLimit: sse.includes('标题最长'),
        sseHasValidationEnvelope: sse.includes('Tool input validation failed'),
        // ② 模型可见的那份：下一次请求里的工具结果
        nextRequestHasTitleLimit: seenBodies.some((body) => body.includes('标题最长')),
        sse,
        nextRequestBodies: seenBodies
      }
      writeFileSync(join(evidenceDir, `_r70-validation-${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`)
      console.log(`[r70-C:${LABEL}] SSE 含校验文案=${report.sseHasTitleLimit}；SSE 含 Mastra 校验包裹=${report.sseHasValidationEnvelope}；下一次请求含校验文案=${report.nextRequestHasTitleLimit}`)
      // 把 SSE 里带 error 的片段单独打出来，便于肉眼确认它落在哪个 part
      for (const line of sse.split('\n')) {
        if (line.includes('error') && line.includes('标题')) console.log('[r70-C] SSE 片段:', line.slice(0, 400))
      }
      expect(sse.length).toBeGreaterThan(0)
    } finally {
      await server?.stop()
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] r70 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
      }
    }
  }, 120_000)
})
