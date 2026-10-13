// @vitest-environment node
/**
 * 审批回调里的"会话"（round 46）。
 *
 * 现场：权限 chip 显示「完全访问」，但 bash 不给 cwd（`pwd && ls -la`）仍弹审批卡。成因是
 * `needsApproval` 判不了"这个会话的根是哪个工作区"，只能拿整份授权列表保守判（多工作区 → 问）。
 *
 * 这里钉三件事：
 *   1. `approvalSessionOf` 能从**回调第二参的真实形状**里取出线程 id（键位实证见
 *      src/mastra/__tests__/approval-session-chain.spec.ts：躺平后只有 `MastraMemory`）；
 *   2. 无显式目标的判定按**会话根**判（单根 full 免审、单根 ask 看规则；多根仍要全 full；
 *      拿不到会话 = 老口径的整份列表）；
 *   3. 显式目标按整份授权列表判区（round 75 起连 delete/move 也走同一套判区）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { classifyToolCall } from '../../../main/permission/classify'
import type { PermissionRule, Workspace, WorkspaceMode } from '../../../shared/settings'
import { approvalSessionOf, createToolContext, needsApproval } from '../guard'
import { createBed, type TestBed } from './helpers'

let beds: TestBed[] = []

afterEach(() => {
  for (const bed of beds) bed.dispose()
  beds = []
})

/**
 * 一份"按会话取根"的 ctx：会话键 `t1` → 第一个根；`t2` → 第二个根；其余 → 整份授权列表
 * （与 agents/kyclaw.ts 的 roots() 同形状：sessionRoots 给单根，没有项目/默认工作区就是全表）。
 * `rules` 是"永久允许"表（可原地改，模拟设置里点过"永久允许"）。
 */
function workspaceBed(
  modes: WorkspaceMode[],
  rules: PermissionRule[] = []
): { ctx: TestBed['ctx']; roots: Workspace[]; rules: PermissionRule[] } {
  const bedsForRoots = modes.map(() => createBed())
  beds.push(...bedsForRoots)
  const roots: Workspace[] = bedsForRoots.map((bed, index) => ({
    path: bed.root,
    mode: modes[index]
  }))
  const ctx = createToolContext({
    roots: (session) => {
      if (session === 't1') return [roots[0]]
      if (session === 't2') return roots[1] === undefined ? roots : [roots[1]]
      return roots
    },
    classify: classifyToolCall,
    permissionRules: () => rules
  })
  return { ctx, roots, rules }
}

describe('approvalSessionOf：审批回调里的线程 id', () => {
  it('实证形状：摊平的 plain object，线程 id 在 MastraMemory.thread.id', () => {
    expect(
      approvalSessionOf({
        args: { command: 'pwd && ls -la' },
        requestContext: { MastraMemory: { thread: { id: 'thread-1' } } },
        workspace: undefined
      })
    ).toBe('thread-1')
  })

  it('兜底：core 的单键 mastra__threadId（1.75.0 实测没有，留着防它以后补上）', () => {
    expect(approvalSessionOf({ requestContext: { mastra__threadId: 'thread-2' } })).toBe('thread-2')
    // 两个都在时以 MastraMemory 为准（agent 每轮写它，是执行层 same 的那一份）
    expect(
      approvalSessionOf({
        requestContext: { MastraMemory: { thread: { id: 'a' } }, mastra__threadId: 'b' }
      })
    ).toBe('a')
  })

  it('取不到就 undefined（调用方按"拿不到会话"的保守口径判）', () => {
    expect(approvalSessionOf(undefined)).toBeUndefined()
    expect(approvalSessionOf('nope')).toBeUndefined()
    expect(approvalSessionOf({})).toBeUndefined()
    expect(approvalSessionOf({ requestContext: undefined })).toBeUndefined()
    expect(approvalSessionOf({ requestContext: {} })).toBeUndefined()
    expect(approvalSessionOf({ requestContext: { MastraMemory: {} } })).toBeUndefined()
    expect(
      approvalSessionOf({ requestContext: { MastraMemory: { thread: { id: '' } } } })
    ).toBeUndefined()
    expect(
      approvalSessionOf({ requestContext: { MastraMemory: { thread: { id: 42 } } } })
    ).toBeUndefined()
    expect(approvalSessionOf({ requestContext: { mastra__threadId: '   ' } })).toBeUndefined()
  })
})

describe('needsApproval：无显式目标按会话根判 full（round 46）', () => {
  it('用户场景：会话根是 full（其余工作区 ask）→ bash 不给 cwd 免审', () => {
    const { ctx, roots } = workspaceBed(['full', 'ask'])
    expect(needsApproval(ctx, 'bash', { command: 'pwd && ls -la' }, 't1')).toBe(false)
    // 对照：同一个 ctx，不传会话（拿不到线程 id 的老口径）→ 混合档照问
    expect(needsApproval(ctx, 'bash', { command: 'pwd && ls -la' })).toBe(true)
    expect(roots).toHaveLength(2)
  })

  it('会话根是 ask → 照问（full 与否只看会话根）', () => {
    const { ctx } = workspaceBed(['ask', 'full'])
    expect(needsApproval(ctx, 'bash', { command: 'pwd' }, 't1')).toBe(true)
    // t2 是 full 那个根 → 免审
    expect(needsApproval(ctx, 'bash', { command: 'pwd' }, 't2')).toBe(false)
  })

  it('会话多根（没有项目也没指认默认工作区）：仍要全部 full 才免审', () => {
    const allFull = workspaceBed(['full', 'full'])
    expect(needsApproval(allFull.ctx, 'bash', { command: 'pwd' }, 'other-session')).toBe(false)

    const mixed = workspaceBed(['full', 'ask'])
    expect(needsApproval(mixed.ctx, 'bash', { command: 'pwd' }, 'other-session')).toBe(true)
  })

  it('拿不到会话（不传）＝老口径：单根 full 免审、全 full 免审、混合档问', () => {
    expect(needsApproval(workspaceBed(['full']).ctx, 'bash', { command: 'pwd' })).toBe(false)
    expect(needsApproval(workspaceBed(['ask']).ctx, 'bash', { command: 'pwd' })).toBe(true)
    expect(needsApproval(workspaceBed(['full', 'full']).ctx, 'bash', { command: 'pwd' })).toBe(
      false
    )
    expect(needsApproval(workspaceBed(['full', 'ask']).ctx, 'bash', { command: 'pwd' })).toBe(true)
  })

  it('能力类三档同口径：fetch / web_search / git_add 没给显式目标时也吃会话根', () => {
    const { ctx } = workspaceBed(['full', 'ask'])
    expect(needsApproval(ctx, 'fetch', { url: 'https://example.com' }, 't1')).toBe(false)
    expect(needsApproval(ctx, 'web_search', { query: '今天天气' }, 't1')).toBe(false)
    expect(needsApproval(ctx, 'git_add', { paths: ['.'] }, 't1')).toBe(false)
    // 不传会话又回到混合档的老口径
    expect(needsApproval(ctx, 'fetch', { url: 'https://example.com' })).toBe(true)
    expect(needsApproval(ctx, 'web_search', { query: '今天天气' })).toBe(true)
  })

  it('外部/未知工具（MCP）的无目标档同一处判定：会话根 full → 免审', () => {
    const { ctx } = workspaceBed(['full', 'ask'])
    expect(needsApproval(ctx, 'mcp__srv__search', { q: 'x' }, 't1')).toBe(false)
    expect(needsApproval(ctx, 'mcp__srv__search', { q: 'x' })).toBe(true)

    const askRoot = workspaceBed(['ask', 'full'])
    expect(needsApproval(askRoot.ctx, 'mcp__srv__search', { q: 'x' }, 't1')).toBe(true)
    expect(needsApproval(askRoot.ctx, 'mcp__srv__search', { q: 'x' }, 't2')).toBe(false)
  })
})

describe('显式目标 / 规则那条路（round 75 起跟着"目标落在哪个区"走）', () => {
  it('显式目标按整份授权列表判区：cwd 落在 ask 工作区 → 问；落在 full 的 → 免审', () => {
    const { ctx, roots } = workspaceBed(['full', 'ask'])
    expect(needsApproval(ctx, 'bash', { command: 'pwd', cwd: roots[1].path }, 't1')).toBe(true)
    // 落在 full 的那个工作区（哪怕不是会话根）→ 免审
    expect(needsApproval(ctx, 'bash', { command: 'pwd', cwd: roots[0].path }, 't1')).toBe(false)
  })

  it('"永久允许"规则：判得出落在哪个工作区时就认那条规则（含会话根那一支）', () => {
    const multi = workspaceBed(['ask', 'ask'])
    multi.rules.push({ tool: 'bash', workspace: multi.roots[0].path, mode: 'allow' })
    // 会话根 = roots[0]（执行层就在它里面跑）→ 命中规则 → 免审
    expect(needsApproval(multi.ctx, 'bash', { command: 'pwd' }, 't1')).toBe(false)
    // 拿不到会话 + 多个 ask 工作区：说不清落在哪 → 走「工作区之外」那一档（默认问，规则不生效）
    expect(needsApproval(multi.ctx, 'bash', { command: 'pwd' })).toBe(true)
    // 另一个会话（根是 roots[1]，没有规则）→ 照旧问
    expect(needsApproval(multi.ctx, 'bash', { command: 'pwd' }, 't2')).toBe(true)

    // 单工作区（审批口径列表就一个）+ 命中该工作区的规则 → 放行
    const single = workspaceBed(['ask'])
    single.rules.push({ tool: 'bash', workspace: single.roots[0].path, mode: 'allow' })
    expect(needsApproval(single.ctx, 'bash', { command: 'pwd' }, 't1')).toBe(false)
  })

  it('delete 跟着档位走（round 75：不再"永远问"）：区内 full 免审、区内 ask 问', () => {
    const full = workspaceBed(['full', 'ask'])
    expect(needsApproval(full.ctx, 'delete', { path: 'x.txt' }, 't1')).toBe(false)

    const ask = workspaceBed(['ask', 'full'])
    expect(needsApproval(ask.ctx, 'delete', { path: 'x.txt' }, 't1')).toBe(true)
  })
})
