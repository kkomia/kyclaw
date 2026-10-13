// @vitest-environment node
/**
 * 探针（round 72）：**真实链路**上的停止键 —— 客户端中止 HTTP 请求 → mastra 的
 * `context.abortSignal` → 我们的 bash 工具 → 子进程真的死。
 *
 * 为什么要有这一条（不满足于直接给工具塞一个 AbortSignal 的单测）：
 *   - 单测里那个 signal 是我自己造的，"字段名对不对"没被验证；
 *   - 真实现是 `@mastra/ai-sdk` 的 chatRoute 把 `c.req.raw.signal` 装进 params
 *     （`@mastra/ai-sdk/dist/index.js:15762`），core 再把它当 `abortSignal` 交给工具 execute
 *     （`@mastra/core/dist/agent-*.js` 的 `toolOptions` → `tool.execute(args, toolOptions)`，
 *     类型声明 `@mastra/core/dist/tools/types.d.ts:528`）。
 * 这条用例把这一整段跑一遍：起真 mastra server（stub 模型吐一个 bash 工具调用），
 * 客户端 abort fetch，然后看命令的进程是不是真的没了。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import type { Workspace } from '../../shared/settings'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function bashCallScript(toolCallId: string, command: string): StreamPart[] {
  const json = JSON.stringify({ command, timeout_ms: 600_000 })
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName: 'bash' },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName: 'bash', input: json },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
      usage: USAGE
    }
  ]
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await delay(100)
  }
  return check()
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-r72-chain-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r72-mock',
    modelId: 'kyclaw-r72-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: (): Workspace[] => [{ path: workspace, mode: 'full' }],
    projects: () => []
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放）：', dir)
  }
})

describe.runIf(process.platform === 'win32')('探针：停止键的整链路（round 72）', () => {
  it('客户端 abort HTTP 请求 → 工具拿到 abortSignal → 在跑的命令进程真的死', async () => {
    const childScript = join(workspace, 'chain-child.mjs')
    const pidFile = join(workspace, 'chain-child.pid')
    writeFileSync(
      childScript,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        'setTimeout(() => {}, 60000)\n'
    )

    scripts.length = 0
    scripts.push(() =>
      bashCallScript('call-chain', `"${process.execPath}" "${childScript}" "${pidFile}" & wait`)
    )

    const controller = new AbortController()
    const started = Date.now()
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: '跑一条长命令' }] }],
        ...threadMemoryBody('thread-r72-chain')
      }),
      signal: controller.signal
    })
    expect(response.status).toBe(200)

    // 读流的那一头就是渲染端；这里只负责在命令真跑起来之后按"停止"
    const bodyPromise = response.text().catch(() => 'ABORTED-CLIENT-SIDE')

    expect(await waitUntil(() => existsSync(pidFile), 20_000)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    const aliveBefore = pidAlive(childPid)

    controller.abort()

    const gone = await waitUntil(() => !pidAlive(childPid), 15_000)
    const body = await Promise.race([bodyPromise, delay(3_000).then(() => '<流已断>')])

    process.stdout.write(`\n[chain] 中止前 pid ${childPid} 存活 = ${aliveBefore}\n`)
    process.stdout.write(
      `[chain] 中止后 存活 = ${pidAlive(childPid)}（耗时 ${Date.now() - started}ms）\n`
    )
    process.stdout.write(`[chain] 客户端侧流：${body.slice(0, 400)}\n`)

    try {
      process.kill(childPid)
    } catch {
      // 已经死了
    }

    expect(aliveBefore).toBe(true)
    expect(gone).toBe(true)
  }, 60_000)
})
