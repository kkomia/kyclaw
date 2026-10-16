// @vitest-environment node
/**
 * R76 探针：**增量改产出物**（edit_ppt）到底省了多少 —— 真模型、同一个任务、同一个模型。
 *
 * 要回答的问题（用户口径：钱花在模型输出上，本地渲染不花）：
 *   1. 同一个"改一页"的诉求，**整份重生成**（旧路，create_ppt 重发全篇 slides）与
 *      **只发增量**（edit_ppt 一个 op）分别是多少输出 token、多少钱？
 *   2. 模型**入参大小**差多少（整份 slides 的字符数 vs 一个 op 的字符数）？
 *   3. 增量改完之后，产出物**仍然过结构自检**、页数正确、改的那一页真的改了（其余页逐字节没动）？
 *
 * 两臂做法（**变量只有"整份 vs 增量"**：同一份任务、同一个模型、同一个工作区形状）：
 *   - `before`：做第一版 → 再要一次"改第 3 页"，并**明确点名 create_ppt 整份重写**（旧口径的唯一办法）；
 *   - `after`：做第一版 → 再要一次同样的改动，**明确点名 edit_ppt 只改这一页**。
 *   两臂的改动诉求完全相同（同一页、同一段新文字），差别只在"要模型发多少"。
 *
 * 用法（会真花钱）：
 *   KYCLAW_R76_REAL=1 pnpm exec vitest run src/main/agent/__tests__/_r76-real.spec.ts
 * 环境变量：KYCLAW_R76_BASE / KYCLAW_R76_KEY / KYCLAW_R76_MODEL / KYCLAW_R76_TASK
 * 产物：`.superpowers/sdd/2026-10-10-kyclaw-mvp/_r76-edit-real.json`
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { resolveModel } from '../../../mastra/model'
import { checkPackage, readZipEntries } from '../../../mastra/tools/artifact-check'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'

const requested = process.env.KYCLAW_R76_REAL === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp')

const BASE_URL = process.env.KYCLAW_R76_BASE ?? 'https://api.deepseek.com'
const API_KEY = process.env.KYCLAW_R76_KEY ?? ''

/** 门开一半（REAL=1 但 KEY 空）时说清为什么跳过：本文件**不提供任何默认密钥** */
if (requested && API_KEY === '') {
  console.warn('[R76] KYCLAW_R76_REAL=1 但 KYCLAW_R76_KEY 为空——真服务探针跳过（没有默认密钥可用）')
}
const enabled = requested && API_KEY !== ''
const MODEL = process.env.KYCLAW_R76_MODEL ?? 'deepseek-flash'
const TASK = process.env.KYCLAW_R76_TASK ?? '简单查下今天的新闻，做个简报 PPT 给我，简单做下就行'

/** 两臂共用的"改一页"诉求（同一个页、同一段新文字） */
const CHANGE = '标题写成「国内要闻（修订）」，要点只留一条「PSL 利率下调 0.25 个百分点（央行）」'
const BEFORE_TURN = `现在改第 3 页：${CHANGE}。这次**必须用 create_ppt**：把整份 slides 一字不差地重发一遍（旧口径就是这样改写一页的，这次作为对照），**不要用 edit_ppt**，路径不变。`
const AFTER_TURN = `现在改第 3 页：${CHANGE}。**只用 edit_ppt 改这一页**，不要重发整份。`

/** 一次真发出去的请求（旁观记录） */
interface SeenRequest {
  url: string
  bodyChars: number
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

/** SSE 文本 → 这一轮模型发起的工具调用（名字 + 入参字符数）——"模型入参大小"的实测口径 */
function toolCallsOfSse(text: string): Array<{ name: string; inputChars: number }> {
  const calls: Array<{ name: string; inputChars: number }> = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data) as {
        type?: string
        toolName?: string
        input?: unknown
      }
      if (parsed.type === 'tool-input-available' && typeof parsed.toolName === 'string') {
        calls.push({ name: parsed.toolName, inputChars: JSON.stringify(parsed.input ?? {}).length })
      }
    } catch {
      // 跳过
    }
  }
  return calls
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

function pptxIn(root: string): string | null {
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = pptxIn(full)
      if (nested !== null) return nested
    } else if (entry.name.toLowerCase().endsWith('.pptx')) {
      return full
    }
  }
  return null
}

/** 包内逐页 XML（页号 → slideN.xml 文本）："只有第 3 页变了"这类断言的口径 */
function deckPages(bytes: Uint8Array): Map<number, string> {
  const pages = new Map<number, string>()
  for (const [name, entry] of readZipEntries(bytes)) {
    const matched = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)
    if (matched !== null) pages.set(Number(matched[1]), entry.toString('utf8'))
  }
  return pages
}

interface TurnRecord {
  label: string
  seconds: number
  llmCalls: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  tools: Array<{ name: string; inputChars: number }>
}

describe.runIf(enabled)('R76 探针：整份重生成 vs 只发增量（真模型）', () => {
  it(
    '同一个任务、同一次"改一页"：before（create_ppt 整份）与 after（edit_ppt 增量）',
    async () => {
      mkdirSync(evidenceDir, { recursive: true })

      const originalFetch = globalThis.fetch
      const seen: SeenRequest[] = []
      const host = new URL(BASE_URL).host
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.includes(host)) return originalFetch(input, init)

        let record: SeenRequest | null = null
        try {
          const raw = typeof init?.body === 'string' ? init.body : ''
          record = { url, bodyChars: raw.length, usage: null }
          seen.push(record)
        } catch {
          // 没有 JSON 体就不记
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

      const dirs: string[] = []
      const servers: AgentServerHandle[] = []
      const report: Record<string, unknown> = { model: MODEL, task: TASK, change: CHANGE }

      /** 跑一臂：做第一版 → 改第 3 页 */
      const arm = async (
        label: 'before' | 'after',
        turn2: string
      ): Promise<Record<string, unknown>> => {
        const dir = mkdtempSync(join(tmpdir(), `kyclaw-r76-${label}-`))
        dirs.push(dir)
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

        const server = await startAgentServer({
          dataDir: dir,
          resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
          workspaces: () => workspaces,
          defaultWorkspace: () => ws,
          projects: () => []
        })
        servers.push(server)

        const threadId = `r76-${label}`
        const turn = async (text: string, seq: number): Promise<TurnRecord> => {
          const from = seen.length
          const started = Date.now()
          const response = await originalFetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${server.token}`
            },
            body: JSON.stringify({
              messages: [{ id: `u-${seq}`, role: 'user', parts: [{ type: 'text', text }] }],
              memory: { thread: threadId, resource: 'local-user' }
            })
          })
          expect(response.status).toBe(200)
          const body = await response.text()
          // usage 是 clone 之后异步解析的，等一拍再取
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const pending = seen.slice(from).some((item) => item.usage === null)
            if (!pending) break
            await new Promise((r) => setTimeout(r, 250))
          }

          const calls = seen.slice(from)
          const withUsage = calls.filter((item) => item.usage !== null)
          const promptTokens = withUsage.reduce((sum, i) => sum + (i.usage?.promptTokens ?? 0), 0)
          const cachedTokens = withUsage.reduce((sum, i) => sum + (i.usage?.cachedTokens ?? 0), 0)
          const outputTokens = withUsage.reduce(
            (sum, i) => sum + (i.usage?.completionTokens ?? 0),
            0
          )
          return {
            label: `turn-${seq}`,
            seconds: Math.round((Date.now() - started) / 1000),
            llmCalls: calls.length,
            promptTokens,
            cachedTokens,
            outputTokens,
            tools: toolCallsOfSse(body)
          }
        }

        const first = await turn(TASK, 1)
        const deckBefore = pptxIn(ws)
        const beforeBytes = deckBefore === null ? null : readFileSync(deckBefore)
        const pagesBefore =
          beforeBytes === null ? new Map<number, string>() : deckPages(beforeBytes)

        const second = await turn(turn2, 2)
        const deckAfter = pptxIn(ws)
        const afterBytes = deckAfter === null ? null : readFileSync(deckAfter)
        const pagesAfter = afterBytes === null ? new Map<number, string>() : deckPages(afterBytes)

        const result: Record<string, unknown> = {
          threadId,
          firstTurn: first,
          editTurn: second,
          produced: listFiles(ws),
          deckPath: deckAfter,
          turns: { create: first.tools, edit: second.tools }
        }

        if (afterBytes !== null) {
          // 结构自检走产品自己那一份（页数按包内真实页数给，验的是"这个包按 OOXML 规矩装好了"）
          const check = checkPackage(afterBytes, {
            kind: 'pptx',
            slides: pagesAfter.size,
            texts: []
          })
          result.selfCheck = check.note
          result.structureOk = check.ok
          result.bytes = afterBytes.byteLength
        }
        if (beforeBytes !== null && afterBytes !== null) {
          result.deckChanged = !beforeBytes.equals(afterBytes)
          result.beforeBytes = beforeBytes.byteLength
          result.pageCount = { before: pagesBefore.size, after: pagesAfter.size }
          result.changedPages = [...pagesAfter.keys()]
            .filter((page) => pagesAfter.get(page) !== pagesBefore.get(page))
            .sort((left, right) => left - right)
          result.page3HasNewTitle = (pagesAfter.get(3) ?? '').includes('国内要闻（修订）')
        }
        return result
      }

      try {
        report.before = await arm('before', BEFORE_TURN)
        report.after = await arm('after', AFTER_TURN)

        writeFileSync(
          join(evidenceDir, '_r76-edit-real.json'),
          `${JSON.stringify(report, null, 2)}\n`
        )

        const before = report.before as Record<string, unknown>
        const after = report.after as Record<string, unknown>
        const beforeEdit = before.editTurn as TurnRecord
        const afterEdit = after.editTurn as TurnRecord
        /** 这一轮里模型自己发出去的最大一份工具入参（"整份 vs 增量"的直接读数） */
        const biggest = (turn: TurnRecord): number =>
          turn.tools.reduce((max, call) => Math.max(max, call.inputChars), 0)
        const createInput = biggest((before.firstTurn as TurnRecord) ?? beforeEdit)

        console.log(
          `[r76] before 改一页：输入 ${beforeEdit.promptTokens}（缓存 ${beforeEdit.cachedTokens}）/ 输出 ${beforeEdit.outputTokens} token；` +
            `最大入参 ${biggest(beforeEdit)} 字符（整份重发：第一版 create_ppt 的入参 ${createInput} 字符）；工具 ${beforeEdit.tools.map((c) => c.name).join('→')}`
        )
        console.log(
          `[r76] after  改一页：输入 ${afterEdit.promptTokens}（缓存 ${afterEdit.cachedTokens}）/ 输出 ${afterEdit.outputTokens} token；` +
            `最大入参 ${biggest(afterEdit)} 字符；工具 ${afterEdit.tools.map((c) => c.name).join('→')}`
        )
        console.log(
          `[r76] after 产出：页数 ${JSON.stringify(after.pageCount)}；变了的页 ${JSON.stringify(after.changedPages)}；` +
            `第 3 页有标题=${String(after.page3HasNewTitle)}；结构自检 ${String(after.selfCheck)}`
        )
        console.log(`[r76] 产出：${JSON.stringify(after.produced)}`)

        // 两臂都真的动过那份文件
        expect(before.deckChanged).toBe(true)
        expect(after.deckChanged).toBe(true)
        // before 这一臂必须真走"整份重发"（不然这次对照不成立）
        expect(beforeEdit.tools.map((call) => call.name)).toContain('create_ppt')
        // after 这一臂必须走的是 edit_ppt
        expect(afterEdit.tools.map((call) => call.name)).toContain('edit_ppt')
        // 改完仍然过结构自检、页数不变、改的那一页真的改了
        expect(after.structureOk).toBe(true)
        expect(after.page3HasNewTitle).toBe(true)
        expect((after.pageCount as { before: number; after: number }).after).toBe(
          (after.pageCount as { before: number; after: number }).before
        )
      } finally {
        globalThis.fetch = originalFetch
        for (const server of servers) await server.stop().catch(() => {})
        for (const dir of dirs) {
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          } catch {
            console.warn('[kyclaw] r76 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
          }
        }
      }
    },
    30 * 60 * 1000
  )
})
