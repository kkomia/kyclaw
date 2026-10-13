// @vitest-environment node
/**
 * R71 · U3/U12 探针：**一次模型回复里多个工具调用，Mastra 到底怎么跑？**
 *
 * ## 三个子问题与实测口径
 *
 *   U3①  同一步的多个工具调用是并行还是串行？（真 agent + 真 bash + 真 sleep，用工具进程自己写的
 *         起止毫秒判重叠）
 *   U3①  其中一个工具"需要审批"时，同批的**其他工具**会不会被一起挡住？
 *        （两个方向都测：审批工具在前 → 兄弟有没有跑；审批工具在后 → 兄弟跑完才挂起）
 *   U12   工具是不是在**流式期间**（模型还在输出）就开跑了？
 *        （桩模型自建流：tool-call 之后还有 ~2.7s 的输出，桩侧记下每个 chunk 的**发送时刻**；
 *          客户端侧同时轮询标记文件，看它出现在"模型最后一 chunk"之前还是之后）
 *
 * ## 读码线索（探针要证伪/证实的对象）
 *
 *   - `@mastra/core/dist/agent-*.js:28817 resolveEmittedToolCallConcurrency`：两段判定 ——
 *     ① `effectiveToolSetRequiresSequentialExecution({...args, dynamicApprovalEvaluated: true})`
 *       （strategy='available' 时遍历 active 工具：`hasSuspendSchema` → 串行；
 *        `getNeedsApprovalFn(tool)` 真值 → **dynamicApprovalEvaluated 时返回 false，不强制串行**；
 *        否则看静态 `Boolean(tool.requireApproval)`）；
 *     ② 都没强制串行时，逐个**被调用**的工具用本次入参算审批结论（`resolveToolApprovalVerdict`），
 *       任一条为真 → 1，全假 → `configuredConcurrency`（`DEFAULT_TOOL_CALL_CONCURRENCY` = 10）。
 *   - 我们每个工具都用**函数形态** `requireApproval`（`createTool({ requireApproval: (input, ctx) => ... })`），
 *     `dist/utils--*js:725` 把它变成 `requireApproval = true` + `needsApprovalFn = fn` —— 于是第①段
 *     踩的是 `getNeedsApprovalFn` 那一支（不强制串行），第②段才是真正决定并发的地方。
 *     **本 spec 的用例 1/2/3 就是在验这一条**。
 *   - `agent-*.js:33382` 预执行开关 = `eagerToolExecution && methodType === 'stream' && strategy === 'available'`；
 *     `:43450` 默认 `options.eagerToolExecution ?? true`，我们没关 → 开关开着。
 *     但 `:26489 isEagerlyExecutableToolCall` 白名单里有一条 `Boolean(tool.requireApproval) → false`，
 *     而我们的工具运行时披着 `requireApproval: true` → **预期不会预执行**（用例 4 验它）。
 *
 * 本 spec 的断言写的是**当前实测行为**（现在是绿的），所以它同时是"哪天 Mastra 换了口径 /
 * 我们把 requireApproval 改成别的形状"的漂移探针。
 *
 * 安全边界：所有写/删都只发生在 `mkdtemp` 目录里；`sleep` 是唯一耗时手段；不碰任何用户数据。
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import { defaultSettings } from '../../shared/settings'
import { settingsPath, writeSettings } from '../../main/settings'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

/** 同一步里多个工具调用（形状照 approval-resume.spec 的 multiToolCallScript） */
function multiToolCallScript(
  calls: Array<{ id: string; name: string; input: unknown }>,
  tail: { textChunks: number } = { textChunks: 0 }
): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const call of calls) {
    const json = JSON.stringify(call.input)
    parts.push({ type: 'tool-input-start', id: call.id, toolName: call.name })
    parts.push({ type: 'tool-input-delta', id: call.id, delta: json })
    parts.push({ type: 'tool-input-end', id: call.id })
  }
  for (const call of calls) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input)
    })
  }
  if (tail.textChunks > 0) {
    parts.push({ type: 'text-start', id: 't-tail' })
    for (let i = 0; i < tail.textChunks; i += 1) {
      parts.push({ type: 'text-delta', id: 't-tail', delta: `还在输出第 ${i + 1} 段…` })
    }
    parts.push({ type: 'text-end', id: 't-tail' })
  }
  parts.push({ type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE })
  return parts
}

function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

const SLEEP_MS = 1200
const TAIL_CHUNKS = 10
const TAIL_DELAY_MS = 300

/** 让 bash 在**它自己的进程里**写下起止毫秒（判重叠不靠测试进程的钟） */
function sleepCommand(marker: string): string {
  const start = posix(`${marker}.start`)
  const end = posix(`${marker}.end`)
  return (
    `printf '%s' "$(date +%s%3N)" > "${start}"; ` +
    `sleep ${SLEEP_MS / 1000}; ` +
    `printf '%s' "$(date +%s%3N)" > "${end}"; echo "slept"`
  )
}

let dir: string
let full: string
let ask: string
let markers: string
let server: AgentServerHandle

interface MockScript {
  /** 惰性造 chunk：这样脚本里的路径等内容在用例运行时才求值 */
  parts: () => StreamPart[]
  /** 相邻两个 chunk 之间的真实停顿（毫秒） */
  delayMs: number
}

const pending: MockScript[] = []
/** 每次模型调用里，每个 chunk 被**送出**的时刻（相对 T0）—— 预执行判定要用它当"模型还在流的窗口" */
const callStamps: number[][] = []
/** 本轮请求的统一时钟原点（桩模型侧与客户端侧共用） */
let T0 = 0
const now = (): number => Date.now() - T0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface RunRecord {
  parts: Array<{ t: number; type: string; toolCallId?: string }>
  lastPartAt: number
  approval: Array<{ t: number; part: Record<string, unknown> }>
  output: Array<{ t: number; part: Record<string, unknown> }>
  markerSeen: Record<string, number>
  errors: string[]
}

/**
 * 真链路跑一轮：settings.json 现写（两个工作区，只靠 cwd 区分 full/ask），
 * SSE 逐块读（同时把每块到达时刻记下来），并轮询标记文件首次出现时刻。
 */
async function runOnce(threadId: string, markerNames: string[]): Promise<RunRecord> {
  if (pending.length === 0) throw new Error('桩模型还没排上脚本')
  callStamps.length = 0
  T0 = Date.now()

  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: `u-${threadId}`, role: 'user', parts: [{ type: 'text', text: '做吧' }] }],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)

  const markerSeen: Record<string, number> = {}
  const poll = setInterval(() => {
    for (const name of markerNames) {
      if (markerSeen[name] === undefined && existsSync(join(markers, name))) {
        markerSeen[name] = now()
      }
    }
  }, 10)

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const timeline: RunRecord['parts'] = []
  const raw: Array<{ t: number; part: Record<string, unknown> }> = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      if (data === '' || data === '[DONE]') continue
      const part = JSON.parse(data) as Record<string, unknown>
      const t = now()
      raw.push({ t, part })
      timeline.push({
        t,
        type: String(part.type),
        ...(typeof part.toolCallId === 'string' ? { toolCallId: part.toolCallId } : {})
      })
    }
  }
  const lastPartAt = now()
  clearInterval(poll)
  for (const name of markerNames) {
    if (markerSeen[name] === undefined && existsSync(join(markers, name))) {
      markerSeen[name] = now()
    }
  }

  return {
    parts: timeline,
    lastPartAt,
    approval: raw.filter((entry) => entry.part.type === 'tool-approval-request'),
    output: raw.filter((entry) => entry.part.type === 'tool-output-available'),
    markerSeen,
    errors: raw
      .filter((entry) => entry.part.type === 'tool-output-error')
      .map((entry) => String(entry.part.errorText ?? ''))
  }
}

interface Span {
  name: string
  start: number
  end: number
}

function spanOf(name: string): Span | null {
  const startFile = join(markers, `${name}.start`)
  const endFile = join(markers, `${name}.end`)
  if (!existsSync(startFile) || !existsSync(endFile)) return null
  return {
    name,
    start: Number(readFileSync(startFile, 'utf8').trim()),
    end: Number(readFileSync(endFile, 'utf8').trim())
  }
}

/** 两个区间重叠多少毫秒（>0 = 真并行跑过） */
function overlapMs(a: Span | null, b: Span | null): number {
  if (a === null || b === null) return 0
  return Math.min(a.end, b.end) - Math.max(a.start, b.start)
}

function clearMarkers(): void {
  rmSync(markers, { recursive: true, force: true })
  mkdirSync(markers, { recursive: true })
}

function setWorkspaces(fullMode: 'full' | 'ask', askMode: 'full' | 'ask'): void {
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces: [
      { path: full, mode: fullMode },
      { path: ask, mode: askMode }
    ]
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-r71-u3-'))
  mkdirSync(join(dir, 'full'), { recursive: true })
  mkdirSync(join(dir, 'ask'), { recursive: true })
  full = realpathSync.native(join(dir, 'full'))
  ask = realpathSync.native(join(dir, 'ask'))
  // 标记文件放在**授权工作区里面**（`full` 下）：命令写它们这件事本身就不会被判成"区外"，
  // 这些用例量的才是并发 / 预执行（判定链见 guard.needsApproval：区外目标按「工作区之外」那一档）。
  markers = join(full, 'markers')
  mkdirSync(markers, { recursive: true })
  writeFileSync(join(full, 'a.txt'), 'AAA\n', 'utf8')

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r71-u3-mock',
    modelId: 'kyclaw-r71-u3-mock',
    doStream: async () => {
      const script = pending.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      const chunks = script.parts()
      // 自建流（不用 simulateReadableStream）：这样每个 chunk 的**送出时刻**是我们自己记的，
      // "模型还在流"的窗口才有事实依据 —— 预执行判定要靠它（见用例 4）。
      const stamps: number[] = []
      callStamps.push(stamps)
      let index = 0
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          if (index >= chunks.length) {
            controller.close()
            return
          }
          if (index > 0) await sleep(script.delayMs)
          stamps.push(now())
          controller.enqueue(chunks[index] as StreamPart)
          index += 1
        }
      })
      return { stream }
    }
  })

  server = await startAgentServer({ dataDir: dir, model })
  console.log(`[r71-u3] 环境：full=${full}；ask=${ask}；markers=${markers}；sleep=${SLEEP_MS}ms`)
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('U3①：同一步多工具调用的并发口径（真 bash + 真 sleep）', () => {
  it('三个 bash（cwd 都在 full 工作区、都免审）：三段 sleep 重叠 → 并行', async () => {
    setWorkspaces('full', 'ask')
    clearMarkers()
    pending.length = 0
    pending.push({
      delayMs: 0,
      parts: () =>
        multiToolCallScript(
          ['a', 'b', 'c'].map((name) => ({
            id: `call-${name}`,
            name: 'bash',
            input: { cwd: full, command: sleepCommand(join(markers, name)) }
          }))
        )
    })
    pending.push({ delayMs: 0, parts: () => textScript('跑完了。') })

    const record = await runOnce('r71-u3-parallel', ['a.start', 'b.start', 'c.start', 'a.end'])
    const spans = ['a', 'b', 'c'].map((name) => spanOf(name))
    const overlaps = [overlapMs(spans[0], spans[1]), overlapMs(spans[0], spans[2])]
    const wall =
      Math.max(...spans.map((span) => span?.end ?? 0)) -
      Math.min(...spans.map((span) => span?.start ?? 0))

    console.log(
      `[r71-u3] 用例1（三个免审 bash，每个 sleep ${SLEEP_MS}ms）：` +
        `${spans.map((span) => `${span?.name}=[${span?.start}→${span?.end}]`).join(' ')}；` +
        `a∩b=${overlaps[0]}ms a∩c=${overlaps[1]}ms；总墙钟=${wall}ms` +
        `（串行应≈${SLEEP_MS * 3}ms，并行应≈${SLEEP_MS}ms）；审批卡=${record.approval.length}；` +
        `output=${record.output.length}；error=${JSON.stringify(record.errors)}`
    )
    console.log(`[r71-u3] 用例1 客户端时间轴：${JSON.stringify(record.parts)}`)

    expect(record.approval).toHaveLength(0)
    expect(record.output).toHaveLength(3)
    expect(overlaps[0]).toBeGreaterThan(0)
    expect(overlaps[1]).toBeGreaterThan(0)
    expect(wall).toBeLessThan(SLEEP_MS * 2)
  }, 90_000)

  it('对照组：两个 bash 的 cwd 换到 ask 工作区（都要审批）—— 一张审批卡 + 两个都没跑', async () => {
    setWorkspaces('ask', 'ask')
    clearMarkers()
    pending.length = 0
    pending.push({
      delayMs: 0,
      parts: () =>
        multiToolCallScript(
          ['c', 'd'].map((name) => ({
            id: `call-${name}`,
            name: 'bash',
            input: { cwd: ask, command: sleepCommand(join(markers, name)) }
          }))
        )
    })

    const record = await runOnce('r71-u3-ask', ['c.start', 'd.start'])
    console.log(
      `[r71-u3] 用例2（ask 里两个都需审批的 bash）：审批卡=${record.approval.length}` +
        `（toolCallId=${JSON.stringify(record.approval.map((entry) => entry.part.toolCallId))}，` +
        `到达于 ${JSON.stringify(record.approval.map((entry) => entry.t))}ms）；` +
        `output=${record.output.length}；标记文件出现=${JSON.stringify(record.markerSeen)}`
    )
    console.log(`[r71-u3] 用例2 客户端时间轴：${JSON.stringify(record.parts)}`)

    expect(record.approval.length).toBeGreaterThan(0)
    expect(existsSync(join(markers, 'c.start'))).toBe(false)
    expect(existsSync(join(markers, 'd.start'))).toBe(false)
  }, 90_000)

  it('串行屏障（审批工具在后）：[bash(免审, sleep) + write(ask 工作区，必要审批)] —— 免审那个跑完才挂起', async () => {
    setWorkspaces('full', 'ask')
    clearMarkers()
    pending.length = 0
    const blocked = join(ask, 'blocked.txt')
    rmSync(blocked, { force: true })
    pending.push({
      delayMs: 0,
      parts: () =>
        multiToolCallScript([
          {
            id: 'call-e',
            name: 'bash',
            input: { cwd: full, command: sleepCommand(join(markers, 'e')) }
          },
          // "必要审批"的工具：目标是 **ask 工作区**里的文件（round 75 起 delete/move 在 full 工作区
          // 也免审，"审批工具"的载体换成写类 + ask 工作区）
          { id: 'call-w', name: 'write', input: { path: blocked, content: 'x' } }
        ])
    })

    const record = await runOnce('r71-u3-barrier-after', ['e.start', 'e.end'])
    const span = spanOf('e')
    const approvalAt = record.approval[0]?.t
    console.log(
      `[r71-u3] 用例3a（[bash(sleep ${SLEEP_MS}ms), write(ask)] @full）：bash 起止=${JSON.stringify(span)}；` +
        `审批卡到达于 ${approvalAt}ms（客户端时钟）；output=${record.output.length}`
    )
    console.log(`[r71-u3] 用例3a 客户端时间轴：${JSON.stringify(record.parts)}`)

    expect(span).not.toBeNull()
    expect(record.approval.length).toBeGreaterThan(0)
    // 并发上限 = 1 时：bash 先独占跑完 (~1200ms+)，write 的审批卡才出现。
    // 若并发 > 1，审批卡会在几十毫秒内就到达（另一条分支同时在跑）。
    expect(approvalAt!).toBeGreaterThan(SLEEP_MS)
    expect(existsSync(blocked)).toBe(false)
  }, 90_000)

  it('串行屏障（审批工具在前）：[write(ask 工作区，必要审批) + bash(免审)] —— 免审那个一步都没跑', async () => {
    setWorkspaces('full', 'ask')
    clearMarkers()
    pending.length = 0
    const blocked = join(ask, 'blocked.txt')
    rmSync(blocked, { force: true })
    pending.push({
      delayMs: 0,
      parts: () =>
        multiToolCallScript([
          { id: 'call-w2', name: 'write', input: { path: blocked, content: 'x' } },
          {
            id: 'call-f',
            name: 'bash',
            input: { cwd: full, command: sleepCommand(join(markers, 'f')) }
          }
        ])
    })

    const record = await runOnce('r71-u3-barrier-before', ['f.start'])
    console.log(
      `[r71-u3] 用例3b（[write(ask), bash(sleep ${SLEEP_MS}ms)] @full）：审批卡=${record.approval.length}` +
        `（到达于 ${record.approval[0]?.t}ms）；output=${record.output.length}；` +
        `免审那个 bash 的标记=${JSON.stringify(record.markerSeen)}；blocked 没落盘=${!existsSync(blocked)}`
    )
    console.log(`[r71-u3] 用例3b 客户端时间轴：${JSON.stringify(record.parts)}`)

    expect(record.approval.length).toBeGreaterThan(0)
    expect(existsSync(join(markers, 'f.start'))).toBe(false)
    expect(existsSync(blocked)).toBe(false)
  }, 90_000)
})

describe('U12：工具是否在流式期间就开跑（预执行）', () => {
  it('tool-call 之后模型还继续吐 ~2.7s：标记文件出现在窗口内还是窗口后', async () => {
    setWorkspaces('full', 'ask')
    clearMarkers()
    pending.length = 0
    pending.push({
      delayMs: TAIL_DELAY_MS,
      parts: () =>
        multiToolCallScript(
          [
            {
              id: 'call-eager',
              name: 'bash',
              input: {
                cwd: full,
                command: `printf 'ran' > "${posix(join(markers, 'eager.flag'))}"; sleep 0.2; echo ran`
              }
            }
          ],
          { textChunks: TAIL_CHUNKS }
        )
    })
    pending.push({ delayMs: 0, parts: () => textScript('好了。') })

    const record = await runOnce('r71-u3-eager', ['eager.flag'])
    const stamps = callStamps[0] ?? []
    const toolCallAt = stamps[3] // 脚本第 4 个 chunk = tool-call（见 multiToolCallScript 的顺序）
    const lastModelChunkAt = stamps[stamps.length - 1]
    const flagAt = record.markerSeen['eager.flag']
    const outputAt = record.output[0]?.t

    console.log(
      `[r71-u3] 用例4（流式期预执行）：桩模型第 1 次调用的 chunk 时刻=${JSON.stringify(stamps)}；` +
        `tool-call 送出于 ${toolCallAt}ms，模型最后一块送出于 ${lastModelChunkAt}ms；` +
        `标记文件首次出现于 ${flagAt ?? '未出现'}ms；tool-output-available 于 ${outputAt ?? '未出现'}ms`
    )
    console.log(`[r71-u3] 用例4 客户端时间轴：${JSON.stringify(record.parts)}`)
    console.log(
      `[r71-u3] 用例4 判定：标记 − tool-call = ${flagAt !== undefined && toolCallAt !== undefined ? flagAt - toolCallAt : '-'}ms；` +
        `标记 − 模型最后一块 = ${flagAt !== undefined && lastModelChunkAt !== undefined ? flagAt - lastModelChunkAt : '-'}ms` +
        `（若预执行，标记应≈tool-call+几十~几百 ms，远早于模型出完）`
    )

    expect(flagAt).toBeDefined()
    expect(toolCallAt).toBeDefined()
    expect(lastModelChunkAt).toBeDefined()
    // 判定①：工具启动发生在"模型整个流都出完了"之后
    expect(flagAt!).toBeGreaterThan(lastModelChunkAt!)
    // 判定②：把流式窗口整体跨过去（窗口 ≈ (TAIL_CHUNKS+2) 个间隔），远大于任何 spawn 开销
    expect(flagAt! - toolCallAt!).toBeGreaterThan((TAIL_CHUNKS + 2) * TAIL_DELAY_MS)
    // 判定③：工具结果同样只在流收尾之后才发出来
    expect(outputAt!).toBeGreaterThan(lastModelChunkAt!)
  }, 90_000)
})

describe('工具的运行时形状（并发判定真正读到的东西）', () => {
  it('出厂工具是 Tool 实例（函数形态 requireApproval）；经 CoreToolBuilder 才带 needsApprovalFn', async () => {
    const { createBashTool } = await import('../tools/bash')
    const { createDeleteTool } = await import('../tools/delete')
    const { createReadTool } = await import('../tools/read')
    const { createToolContext } = await import('../tools/guard')
    const { classifyToolCall } = await import('../../main/permission/classify')
    const { Agent } = await import('@mastra/core/agent')
    const { RequestContext } = await import('@mastra/core/request-context')

    const ctx = createToolContext({
      roots: () => [{ path: full, mode: 'full' }],
      classify: classifyToolCall
    })
    const built = {
      bash: await createBashTool(ctx),
      delete: await createDeleteTool(ctx),
      read: await createReadTool(ctx)
    }

    interface ToolShape {
      requireApprovalType: string
      requireApprovalTruthy: boolean
      needsApprovalFnType: string
    }
    const shapeOf = (tools: Record<string, unknown>): Record<string, ToolShape> =>
      Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => {
          const value = tool as { requireApproval?: unknown; needsApprovalFn?: unknown }
          const shape: ToolShape = {
            requireApprovalType: typeof value.requireApproval,
            requireApprovalTruthy: Boolean(value.requireApproval),
            needsApprovalFnType: typeof value.needsApprovalFn
          }
          return [name, shape]
        })
      )

    console.log(`[r71-u3] 出厂（Tool 实例）形状：${JSON.stringify(shapeOf(built))}`)

    // 借一个真 Agent 把工具过一遍 CoreToolBuilder（执行期 convertTools 走的就是 makeCoreTool）
    const probeAgent = new Agent({
      id: 'r71-tool-shape',
      name: 'r71-tool-shape',
      instructions: '形状探针',
      model: new MockLanguageModelV4({
        provider: 'r71-shape-mock',
        modelId: 'r71-shape-mock',
        doStream: async () => {
          throw new Error('形状探针不该调模型')
        }
      }),
      tools: built
    })
    const loader = probeAgent as unknown as {
      getToolsForExecution: (options: {
        requestContext: unknown
      }) => Promise<Record<string, unknown>>
    }
    const runtime = await loader.getToolsForExecution({ requestContext: new RequestContext() })
    console.log(
      `[r71-u3] 运行时（convertTools/CoreToolBuilder 之后）形状：${JSON.stringify(shapeOf(runtime))}`
    )

    for (const value of Object.values(shapeOf(built))) {
      expect(value.requireApprovalType).toBe('function')
      expect(value.requireApprovalTruthy).toBe(true)
      expect(value.needsApprovalFnType).toBe('undefined')
    }
    for (const value of Object.values(shapeOf(runtime))) {
      expect(value.requireApprovalTruthy).toBe(true)
      expect(value.needsApprovalFnType).toBe('function')
    }
  }, 60_000)
})
