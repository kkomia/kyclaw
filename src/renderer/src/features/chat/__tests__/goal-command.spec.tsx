import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelCommandSummary, KernelGoalProjection } from '@shared/kernel-ui'
import { resetThreadChats } from '../thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { ChatSession } from '../ChatPage'
import { PlanModeChip } from '../PlanModeChip'
import { kernelPlanActive } from '../plan-ui'
import { flattenGroups, slashGroups } from '../suggestion-model'
import { createMockTransport } from './mock-transport'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-018：内核命令平面在 renderer 的三个硬口径（Eve verdict + Lead 批复）：
 *   1. **菜单只来自 catalog**：给 `commands` 时不再出现静态三行（catalog 没有的命令一条都不出现）；
 *   2. **`command/run` → `command/done` 不进消息流**：提交 slash 命令时 chat transport 零请求，
 *      结果卡由事件驱动（六行逐字来自投影）；
 *   3. **`kernelPlanActive = active || pending`**：两种合法 plan 形态都算规划中（不得只钉一种）。
 *
 * 传输层是 mock：这里验 UI 接线；main 侧真实 HTTP 由 `src/main/kernel/__tests__/kernel-ui-route.spec.ts` 覆盖。
 */

const CATALOG: KernelCommandSummary[] = [
  { name: 'compact', description: '压缩上下文' },
  { name: 'export', description: '导出会话' },
  { name: 'feedback', description: '提交反馈' },
  { name: 'goal', description: '目标' },
  { name: 'permission', description: '权限' },
  { name: 'plan', description: '规划模式' }
]

const PROJECTION: KernelGoalProjection = {
  visible: true,
  goalId: 'g1',
  phase: 'active',
  rounds: { started: 0, limit: 16, kernelLimit: 256, label: '0/16（内核上限 256）' },
  rows: [
    { id: 'status', label: 'Status', value: '进行中', tone: 'normal' },
    { id: 'blocker', label: 'Blocker', value: '—', tone: 'muted' },
    { id: 'objective', label: 'Objective', value: '完成迁移', tone: 'normal' },
    { id: 'rounds', label: 'Rounds', value: '0/16（内核上限 256）', tone: 'normal' },
    { id: 'activation', label: 'Activation', value: '续行已启用', tone: 'normal' },
    {
      id: 'commands',
      label: 'Commands',
      value: '/goal pause · /goal edit · /goal clear',
      tone: 'muted'
    }
  ],
  commands: ['goal pause', 'goal edit', 'goal clear']
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

interface StubOptions {
  enabled?: boolean
  catalog?: KernelCommandSummary[]
  projection?: KernelGoalProjection | null
  plan?: { active: boolean; pending: boolean } | null
  /** 按整行命令返回 done 帧的 result/goal/plan */
  reply?: (line: string) => {
    result: { kind: 'success' | 'error'; text?: string }
    goal: KernelGoalProjection | null
    plan: { active: boolean; pending: boolean } | null
  }
}

function stubKernel(options: StubOptions = {}): ReturnType<typeof vi.fn> {
  const enabled = options.enabled !== false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/kernel/status')) return json({ enabled })
    if (url.endsWith('/api/kernel/catalog')) {
      return json({ enabled, commands: enabled ? (options.catalog ?? CATALOG) : [] })
    }
    if (url.includes('/api/kernel/projection')) {
      return json({
        goal: options.projection ?? null,
        plan: options.plan ?? { active: false, pending: false }
      })
    }
    if (url.endsWith('/api/kernel/command')) {
      const body = JSON.parse(String(init?.body)) as { line: string }
      const reply = options.reply?.(body.line) ?? {
        result: { kind: 'success' as const },
        goal: null,
        plan: null
      }
      return sse([
        { type: 'command/run', commandId: 'cmd-test', line: body.line },
        { type: 'command/done', commandId: 'cmd-test', line: body.line, ...reply }
      ])
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function renderSession(): Promise<ReturnType<typeof createMockTransport>> {
  const control = createMockTransport()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId="thread-cmd"
        runtime={{
          transport: control.transport,
          loadHistory: async () => [],
          onTurnEnd: () => {},
          refreshInteractions: false
        }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return control
}

function runLine(text: string): void {
  const input = screen.getByTestId('composer-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  installKyclawBridge()
  window.kyclaw.agent.endpoint = async () => ({ baseUrl: 'http://kernel.local', token: 'tok' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearKyclawBridge()
})

describe('PB-018 菜单：只来自内核 catalog', () => {
  it('slashGroups 给 commands 时不拼静态三行：catalog 没有的命令不出现', () => {
    const groups = slashGroups(
      { plugins: [], skills: [], commands: [{ name: 'compact' }, { name: 'export' }] },
      ''
    )
    const rows = flattenGroups(groups).filter((row) => row.id.startsWith('command:'))
    expect(rows.map((row) => row.id)).toEqual(['command:compact', 'command:export'])
    expect(rows.map((row) => row.command)).toEqual(['compact', 'export'])
    // goal 是 leadingInput（只插 `/goal `），其余命令立即执行
    expect(rows[0]?.commandRun).toBe('execute')
  })

  it('catalog 里没有 plan/goal 时，`/` 菜单里一条都不出现（不硬编码第二份清单）', async () => {
    stubKernel({ catalog: [{ name: 'compact' }, { name: 'export' }] })
    await renderSession()
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: '/' } })
    expect(await screen.findByTestId('suggest-command:export')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('suggest-command:plan')).not.toBeInTheDocument()
    )
    expect(screen.queryByTestId('suggest-command:goal')).not.toBeInTheDocument()
  })

  it('goal 选中只把 `/goal ` 留在输入框（leadingInput），不立即执行', async () => {
    const fetchMock = stubKernel()
    await renderSession()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '/' } })
    fireEvent.click(await screen.findByTestId('suggest-command:goal'))
    expect(input.value).toContain('/goal')
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/kernel/command'))
    ).toHaveLength(0)
  })
})

describe('PB-018 结果卡：command/run → command/done 驱动，不进消息流', () => {
  it('`/goal` 六行逐字来自投影；chat transport 零请求', async () => {
    stubKernel({
      projection: PROJECTION,
      reply: () => ({
        result: { kind: 'success' },
        goal: PROJECTION,
        plan: { active: false, pending: false }
      })
    })
    const control = await renderSession()
    await act(async () => runLine('/goal 完成迁移'))

    const card = await screen.findByTestId('goal-command-card')
    for (const label of ['Status', 'Blocker', 'Objective', 'Rounds', 'Activation', 'Commands']) {
      expect(card).toHaveTextContent(label)
    }
    expect(card).toHaveTextContent('完成迁移')
    expect(card).toHaveTextContent('0/16（内核上限 256）')
    expect(control.requests).toHaveLength(0)
  })

  it('done.result=error → 结果卡显示可诊断错误（不静默成功）', async () => {
    stubKernel({
      reply: () => ({
        result: { kind: 'error', text: '未识别的命令：/eve-nope-command' },
        goal: null,
        plan: null
      })
    })
    const control = await renderSession()
    await act(async () => runLine('/eve-nope-command'))
    expect(await screen.findByTestId('goal-command-error')).toHaveTextContent(
      '未识别的命令：/eve-nope-command'
    )
    expect(control.requests).toHaveLength(0)
  })
})

describe('PB-018 plan：两种合法投影形态都接受', () => {
  it.each([
    { active: true, pending: false },
    { active: false, pending: true }
  ])('kernelPlanActive(%o) === true；PlanModeChip 显示「规划中」', (plan) => {
    expect(kernelPlanActive(plan)).toBe(true)
    render(<PlanModeChip state={null} kernelPlan={plan} />)
    expect(screen.getByTestId('plan-mode-chip')).toHaveTextContent('规划中')
  })

  it('裸的 {active:false,pending:false} 不算规划中（反向对照）', () => {
    expect(kernelPlanActive({ active: false, pending: false })).toBe(false)
    const { container } = render(
      <PlanModeChip state={null} kernelPlan={{ active: false, pending: false }} />
    )
    expect(container.querySelector('[data-testid=plan-mode-chip]')).toBeNull()
  })

  it.each([
    { active: true, pending: false },
    { active: false, pending: true }
  ])('`/plan` 的 done 帧两种形态都点亮结果卡 data-plan-active', async (plan) => {
    stubKernel({
      reply: () => ({
        result: { kind: 'success', text: 'Plan mode on.' },
        goal: null,
        plan
      })
    })
    const control = await renderSession()
    await act(async () => runLine('/plan'))
    const card = await screen.findByTestId('goal-command-card')
    expect(card).toHaveAttribute('data-plan-active', 'true')
    expect(await screen.findByTestId('goal-command-result')).toHaveTextContent('Plan mode on.')
    expect(control.requests).toHaveLength(0)
  })
})
