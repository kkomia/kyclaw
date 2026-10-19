// @vitest-environment node
/**
 * PB-018：main 侧内核命令平面 UI 网关（/api/kernel/*）的真实 HTTP 行为。
 *
 * 钉住四件事：
 *   1. 菜单目录来自 adapter.listCommands（唯一来源），flag 关不假装有命令；
 *   2. command 的 SSE 帧顺序 `command/run` → `command/done`，且**不调 startTurn**（命令不产生模型消息）；
 *   3. threadId 必填且一路透传给 adapter（不落默认会话）；
 *   4. adapter 为 null（内核未起）时不静默：projection 回 503 KERNEL_DISABLED，command 给可诊断错误。
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { KernelAdapter } from '../kernel-adapter'
import { createKernelUiRouter, KERNEL_UI_ROUTE_PREFIX } from '../kernel-ui-route'

const KERNEL_GOAL = {
  goal: {
    id: 'g1',
    objective: '完成迁移',
    phase: 'active' as const,
    maxGoalRounds: 256,
    revision: 2
  },
  roundsStarted: 1,
  createdAt: 1,
  updatedAt: 2
}

interface FakeAdapterOptions {
  commands?: Array<{ name: string; description?: string }>
  executeResult?: unknown
  goal?: typeof KERNEL_GOAL | null
  plan?: { active: boolean; pending: boolean } | null
}

function fakeAdapter(options: FakeAdapterOptions = {}): {
  adapter: KernelAdapter
  calls: {
    listCommands: Array<string | undefined>
    executeCommand: Array<{ line: string; threadId?: string }>
    readGoalState: Array<string | undefined>
    readPlanState: Array<string | undefined>
    startTurn: number
  }
} {
  const calls = {
    listCommands: [] as Array<string | undefined>,
    executeCommand: [] as Array<{ line: string; threadId?: string }>,
    readGoalState: [] as Array<string | undefined>,
    readPlanState: [] as Array<string | undefined>,
    startTurn: 0
  }
  const adapter = {
    sessionId: 'default-session',
    pid: 1,
    port: 1,
    async startTurn() {
      calls.startTurn += 1
      return { frames: [], sse: '', text: '' }
    },
    async cancelTurn() {
      await Promise.resolve()
    },
    async stop() {
      await Promise.resolve()
    },
    async listCommands(threadId?: string) {
      calls.listCommands.push(threadId)
      return (
        options.commands ?? [
          { name: 'compact', description: '压缩上下文' },
          { name: 'goal', description: '目标' },
          { name: 'plan', description: '规划模式' }
        ]
      )
    },
    async executeCommand(line: string, threadId?: string) {
      calls.executeCommand.push({ line, ...(threadId === undefined ? {} : { threadId }) })
      if ('executeResult' in options) return options.executeResult
      return {
        commandId: 'cmd-1',
        result: { kind: 'success', text: `执行了 ${line}` }
      }
    },
    async readGoalState(threadId?: string) {
      calls.readGoalState.push(threadId)
      return options.goal === undefined ? KERNEL_GOAL : options.goal
    },
    async readPlanState(threadId?: string) {
      calls.readPlanState.push(threadId)
      return options.plan === undefined ? { active: false, pending: false } : options.plan
    },
    async listKernelSessions() {
      return []
    },
    async reattach() {
      return {}
    }
  } as unknown as KernelAdapter
  return { adapter, calls }
}

function appWith(options: { adapter: KernelAdapter | null }): Hono {
  const app = new Hono()
  app.route(
    KERNEL_UI_ROUTE_PREFIX,
    createKernelUiRouter({
      adapter: options.adapter
    })
  )
  return app
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => JSON.parse(part.replace(/^data:\s*/u, '')) as Record<string, unknown>)
}

async function command(app: Hono, body: unknown): Promise<Response> {
  return app.request(`${KERNEL_UI_ROUTE_PREFIX}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('kernel-ui-route：flag 开（内核命令平面）', () => {
  it('status/catalog：目录只来自 adapter.listCommands（不硬编码）', async () => {
    const { adapter, calls } = fakeAdapter({
      commands: [{ name: 'eve-only', description: '独有命令' }]
    })
    const app = appWith({ adapter })
    const status = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/status`)
    expect(await status.json()).toEqual({ enabled: true })
    const catalog = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/catalog`)
    expect(await catalog.json()).toEqual({
      enabled: true,
      commands: [{ name: 'eve-only', description: '独有命令' }]
    })
    expect(calls.listCommands).toEqual([undefined])
  })

  it('projection：threadId 必填并透传；goal 六行来自内核投影，plan 双形态原样带回', async () => {
    const { adapter, calls } = fakeAdapter({ plan: { active: false, pending: true } })
    const app = appWith({ adapter })
    const missing = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/projection`)
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: 'KERNEL_THREAD_REQUIRED' })

    const response = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/projection?threadId=thread-a`)
    const body = (await response.json()) as {
      goal: { visible: boolean; rows: Array<{ id: string; value: string }> }
      plan: { active: boolean; pending: boolean }
    }
    expect(body.goal.visible).toBe(true)
    expect(body.goal.rows.map((row) => row.id)).toEqual([
      'status',
      'blocker',
      'objective',
      'rounds',
      'activation',
      'commands'
    ])
    expect(body.goal.rows.find((row) => row.id === 'rounds')?.value).toBe('1/16（内核上限 256）')
    expect(body.plan).toEqual({ active: false, pending: true })
    expect(calls.readGoalState).toEqual(['thread-a'])
    expect(calls.readPlanState).toEqual(['thread-a'])
  })

  it('command：run → done 顺序、透传 threadId、带最新投影、不产生模型消息', async () => {
    const { adapter, calls } = fakeAdapter({ plan: { active: true, pending: false } })
    const app = appWith({ adapter })
    const response = await command(app, { threadId: 'thread-a', line: '/goal 完成迁移' })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const frames = parseSse(await response.text())
    expect(frames.map((frame) => frame.type)).toEqual(['command/run', 'command/done'])
    expect(frames[0]).toMatchObject({ type: 'command/run', line: '/goal 完成迁移' })
    expect(frames[1]).toMatchObject({
      type: 'command/done',
      result: { kind: 'success', text: '执行了 /goal 完成迁移' },
      plan: { active: true, pending: false }
    })
    expect((frames[1]?.goal as { visible: boolean }).visible).toBe(true)
    expect(calls.executeCommand).toEqual([{ line: '/goal 完成迁移', threadId: 'thread-a' }])
    expect(calls.startTurn).toBe(0)
  })

  it('command：缺 threadId / 非斜杠行 → 400（不许静默落默认会话）', async () => {
    const { adapter, calls } = fakeAdapter()
    const app = appWith({ adapter })
    const noThread = await command(app, { line: '/goal' })
    expect(noThread.status).toBe(400)
    expect(await noThread.json()).toMatchObject({ error: 'KERNEL_THREAD_REQUIRED' })
    const badLine = await command(app, { threadId: 't', line: 'goal' })
    expect(badLine.status).toBe(400)
    expect(await badLine.json()).toMatchObject({ error: 'KERNEL_COMMAND_INVALID' })
    expect(calls.executeCommand).toEqual([])
  })

  it('command：adapter 返回 undefined（内核静默丢弃）→ done 是可诊断 error，不是成功', async () => {
    const { adapter } = fakeAdapter({ executeResult: undefined })
    const app = appWith({ adapter })
    const frames = parseSse(
      await (await command(app, { threadId: 't', line: '/eve-nope-command' })).text()
    )
    expect(frames[1]).toMatchObject({
      type: 'command/done',
      result: { kind: 'error' }
    })
    expect(String((frames[1]?.result as { text: string }).text)).toContain('/eve-nope-command')
  })

  it('真实 HTTP：起 Hono 服务（socket）读 POST /command 的 SSE 帧', async () => {
    const { adapter, calls } = fakeAdapter()
    const app = appWith({ adapter })
    const server = serve({ fetch: app.fetch, port: 0 })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no listen address')
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}${KERNEL_UI_ROUTE_PREFIX}/command`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId: 'thread-http', line: '/plan off' })
        }
      )
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const chunk = await reader?.read()
        if (chunk === undefined || chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      const frames = parseSse(text)
      expect(frames.map((frame) => frame.type)).toEqual(['command/run', 'command/done'])
      expect(calls.executeCommand).toEqual([{ line: '/plan off', threadId: 'thread-http' }])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('kernel-ui-route：adapter=null（内核未起，不静默）', () => {
  it('status/catalog 报 disabled；projection 回 503 KERNEL_DISABLED', async () => {
    const app = appWith({ adapter: null })
    const status = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/status`)
    expect(await status.json()).toEqual({ enabled: false })
    const catalog = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/catalog`)
    expect(await catalog.json()).toEqual({ enabled: false, commands: [] })

    const response = await app.request(`${KERNEL_UI_ROUTE_PREFIX}/projection?threadId=thread-old`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'KERNEL_DISABLED' })
  })

  it('command 仍回 command/run → command/done，kind=error 且说明内核未启用', async () => {
    const app = appWith({ adapter: null })
    const frames = parseSse(await (await command(app, { threadId: 't', line: '/goal' })).text())
    expect(frames[0]).toMatchObject({ type: 'command/run', line: '/goal' })
    expect(frames[1]).toMatchObject({
      type: 'command/done',
      result: { kind: 'error' },
      goal: null,
      plan: null
    })
    expect(String((frames[1]?.result as { text?: string }).text)).toContain('内核未启用')
  })
})
