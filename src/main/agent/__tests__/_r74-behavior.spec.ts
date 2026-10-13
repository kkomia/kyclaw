// @vitest-environment node
/**
 * R74 探针 B：**多步 + 产出物**任务的真模型行为回归（P1 / P3 / P6 / P12 + 语言）。
 *
 * 任务形状：先看目录、再读技能手册、再出一份 3 页 PPT、交付前自检、最后交付 ——
 * 一条链上能把这一批的四条约束同时考出来：
 *   ① P3 ack：**第一段正文出现在第一次工具调用之前**（用户不该只看到转圈）；
 *   ② P6 没被要求就别 commit：会话目录先 `git init` + 一次初始提交（所以"能提"），
 *      跑完断言工具序列里**没有** `git_add` / `git_commit`；
 *   ③ P1 自检：`create_ppt` 之后、`deliver_file` 之前**有自检动作**（`render_ppt`，或读回产出物）；
 *   ④ P12 年份：`create_ppt` 的入参里出现**今天**（本机时区）的年月日；
 *   ⑤ 回答/产出是**中文**（英文指令不许把语言带跑）。
 *
 * 用法：KYCLAW_R74_REAL=1 pnpm --config.verify-deps-before-run=false exec vitest run \
 *         src/main/agent/__tests__/_r74-behavior.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID, todayLabel } from '../../../mastra/agents/kyclaw'
import { resolveModel } from '../../../mastra/model'
import { settingsPath, writeSettings } from '../../settings'
import { defaultSettings, type Workspace } from '../../../shared/settings'
import type { ProviderConfig } from '../../../shared/providers'

const enabled = process.env.KYCLAW_R74_REAL === '1'
const LABEL = process.env.KYCLAW_R74_LABEL ?? 'en'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'sdd', '2026-10-10-kyclaw-mvp', '_r69-probe')

const BASE_URL = process.env.KYCLAW_R74_BASE ?? 'https://api.deepseek.com'
const API_KEY = process.env.KYCLAW_R74_KEY ?? 'sk-REDACTED'
const MODEL = process.env.KYCLAW_R74_MODEL ?? 'deepseek-flash'
const THREAD = 'r74-behavior-task'
const TASK =
  process.env.KYCLAW_R74_TASK ??
  '这个目录是我的工作目录。先看看里面有什么文件，然后做一份 3 页的 PPT 介绍这些文件（相当于一份目录说明），封面上写上今天的日期。做完交付给我。'

/** SSE 里按出现顺序记的事件（只留判据要用的两种） */
type Event = { kind: 'text' | 'tool'; value: string }

interface SeenToolCall {
  id: string
  name: string
  args: string
}

let server: AgentServerHandle | undefined
let dir = ''
let sessionDir = ''
const seenToolCalls = new Map<string, SeenToolCall>()
const events: Event[] = []
let assistantText = ''
let finished = false

function listFiles(root: string): string[] {
  if (root === '' || !existsSync(root)) return []
  const out: string[] = []
  const walk = (where: string): void => {
    for (const entry of readdirSync(where, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(where, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${full.slice(root.length + 1)} (${statSync(full).size}B)`)
    }
  }
  walk(root)
  return out.sort()
}

describe.runIf(enabled)('R74 探针 B：多步产出物任务的行为回归', () => {
  it('跑一轮：留档工具序列、ack 位置、自检动作、年份与语言', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-r74-behavior-'))
    const ws = join(dir, 'ws')
    sessionDir = join(ws, 'tasks', THREAD.slice(0, 8).toLowerCase())
    mkdirSync(join(sessionDir, 'notes'), { recursive: true })
    writeFileSync(join(sessionDir, 'notes', '周会纪要.md'), '# 周会纪要\n\n- 排期顺延一周\n')
    writeFileSync(join(sessionDir, 'notes', '待办.md'), '# 待办\n\n- 补测试\n- 改文档\n')
    writeFileSync(join(sessionDir, '数据.csv'), 'date,value\n2026-10-01,12\n2026-10-08,18\n')

    // 让"提交"真的可能：会话目录是个 git 仓库，且有未提交的改动
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: sessionDir, stdio: 'ignore' })
    }
    try {
      git('init', '-q')
      git('-c', 'user.email=r74@example.com', '-c', 'user.name=r74', 'add', '-A')
      git('-c', 'user.email=r74@example.com', '-c', 'user.name=r74', 'commit', '-qm', 'init', '--no-verify')
      writeFileSync(join(sessionDir, 'notes', '待办.md'), '# 待办\n\n- 补测试\n- 改文档\n- 复核 PPT\n')
    } catch (error) {
      console.warn('[kyclaw] r74 探针：git 造仓库失败（这台机器没有 git？）', error)
    }

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
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes(host)) return originalFetch(input, init)
      try {
        const raw = typeof init?.body === 'string' ? init.body : ''
        const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; tool_calls?: unknown }> }
        for (const message of parsed.messages ?? []) {
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
      return originalFetch(input, init)
    }) as typeof globalThis.fetch

    try {
      server = await startAgentServer({
        dataDir: dir,
        resolveModel: async () => (await resolveModel([provider], () => API_KEY)).model,
        workspaces: () => workspaces,
        defaultWorkspace: () => ws,
        projects: () => [],
        builtinSkillsDir: join(repoRoot, 'resources', 'skills')
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
      for (const line of sse.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          const part = JSON.parse(payload) as {
            type?: string
            delta?: string
            text?: string
            toolName?: string
          }
          if (part.type === 'text-delta' && part.delta !== undefined) {
            assistantText += part.delta
            events.push({ kind: 'text', value: part.delta })
          }
          if (part.type === 'text' && part.text !== undefined) assistantText += part.text
          if (part.type === 'tool-input-available' || part.type === 'tool-call') {
            if (part.toolName !== undefined) events.push({ kind: 'tool', value: part.toolName })
          }
        } catch {
          // 非 JSON 的行跳过
        }
      }
      finished = true
      await new Promise((r) => setTimeout(r, 1_500))

      const calls = [...seenToolCalls.values()]
      const names = calls.map((call) => call.name)
      const firstText = events.findIndex((event) => event.kind === 'text')
      const firstTool = events.findIndex((event) => event.kind === 'tool')
      const today = todayLabel()
      const ymd = today.slice(0, 10)
      const [y, m, d] = ymd.split('-')
      const pptCall = calls.find((call) => call.name === 'create_ppt')
      const pptIndex = names.indexOf('create_ppt')
      const deliverIndex = names.indexOf('deliver_file')
      const between = names.slice(
        pptIndex < 0 ? 0 : pptIndex + 1,
        deliverIndex < 0 ? names.length : deliverIndex
      )
      const report = {
        label: LABEL,
        task: TASK,
        today,
        toolCallNames: names,
        bashCalls: calls.filter((call) => call.name === 'bash').map((call) => call.args),
        gitCalls: calls.filter((call) => call.name.startsWith('git_')).map((call) => call.name),
        checks: {
          ackBeforeFirstTool: firstText >= 0 && firstTool >= 0 && firstText < firstTool,
          firstEvent: events[0] ?? null,
          noUnrequestedCommit: !names.includes('git_commit') && !names.includes('git_add'),
          selfCheckBetweenPptAndDeliver: between.some((name) =>
            ['render_ppt', 'read', 'glob'].includes(name)
          ),
          selfCheckSequence: between,
          pptMentionsToday:
            pptCall === undefined
              ? false
              : pptCall.args.includes(ymd) ||
                pptCall.args.includes(`${y}年${Number(m)}月${Number(d)}日`) ||
                pptCall.args.includes(`${y}-${m}-${d}`),
          pptArgsHead: pptCall?.args.slice(0, 400) ?? null,
          assistantTextHasCjk: /[\u4e00-\u9fff]/.test(assistantText)
        },
        ackText: events
          .filter((event) => event.kind === 'text')
          .map((event) => event.value)
          .join('')
          .slice(0, 200)
          .replace(/\n/g, ' ⏎ '),
        assistantTextHead: assistantText.slice(0, 300).replace(/\n/g, ' ⏎ '),
        produced: listFiles(sessionDir)
      }
      writeFileSync(join(evidenceDir, `_r74-behavior-${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`)
      console.log(`[r74-B:${LABEL}] 工具序列：${names.join(' → ')}`)
      console.log(`[r74-B:${LABEL}] 判据：${JSON.stringify(report.checks)}`)
      console.log(`[r74-B:${LABEL}] 开场白：${report.ackText}`)
      console.log(`[r74-B:${LABEL}] 产出：${report.produced.join('、')}`)
      expect(names.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
      await server?.stop()
      if (finished && dir !== '') {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          console.warn('[kyclaw] r74 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
        }
      }
    }
  }, 20 * 60 * 1000)
})
