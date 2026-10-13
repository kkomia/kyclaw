import { afterEach, describe, expect, it } from 'vitest'
import { isAllowedByRules, withAllowedRule } from '@shared/permissions'
import type { Workspace } from '@shared/settings'
import {
  allowForSession,
  approvalDetailOf,
  approvalPath,
  approvalRiskOf,
  approvalRequestOf,
  approvalScopeNote,
  canResumeAfterApproval,
  capabilityToolOf,
  hasPendingApproval,
  isAllowedForSession,
  isAllowedForSessionNow,
  isDangerousTool,
  pendingApprovals,
  resetSessionApprovals,
  resolveApprovalWorkspace
} from '../approval'

/**
 * 审批 part 的读取与记忆（T13）：part → 待审批请求、工作区判定、会话记忆的粒度。
 * 粒度这条是 brief 点名的验收点：允许 write + wsA 不能顺带放过 write + wsB 或 edit + wsA。
 * round28：bash 按 cwd、fetch 按 save_to 判工作区（记忆入口能造出来）；bash 的命令 /
 * fetch 的 URL / move 的目标是卡片必须展示的内容。
 * round 76（用户口径"允许就是永久允许"）：delete / move 的记忆粒度与其它工具一字一样 ——
 * 同样是 (对话 × 工具 × 工作区)，服务端的规则也同样是 (工具 × 工作区)。
 */
const WS_A: Workspace = { path: 'D:\\项目\\demo', mode: 'ask' }
const WS_B: Workspace = { path: 'E:\\另一个', mode: 'ask' }

afterEach(() => {
  resetSessionApprovals()
})

describe('approvalRequestOf / pendingApprovals', () => {
  it('approval-requested + approval.id → 取出请求（tool-<name> 形态）', () => {
    const request = approvalRequestOf({
      type: 'tool-write',
      toolCallId: 'call-1',
      state: 'approval-requested',
      input: { path: 'a.txt', content: 'hi' },
      approval: { id: 'run-1::call-1' }
    })

    expect(request).toEqual({
      approvalId: 'run-1::call-1',
      toolCallId: 'call-1',
      toolName: 'write',
      input: { path: 'a.txt', content: 'hi' },
      path: 'a.txt'
    })
  })

  it('dynamic-tool part 用 part.toolName', () => {
    const request = approvalRequestOf({
      type: 'dynamic-tool',
      toolName: 'mcp__fs__write',
      toolCallId: 'call-2',
      state: 'approval-requested',
      input: { path: 'x.txt' },
      approval: { id: 'a-2' }
    })

    expect(request?.toolName).toBe('mcp__fs__write')
  })

  it('非审批态 / 缺 approval.id / 已回应过 → 一律 null', () => {
    for (const part of [
      { type: 'tool-write', toolCallId: 'c', state: 'input-available', input: {} },
      {
        type: 'tool-write',
        toolCallId: 'c',
        state: 'output-available',
        input: {},
        approval: { id: 'a', approved: true }
      },
      { type: 'tool-write', toolCallId: 'c', state: 'approval-requested', input: {} },
      { type: 'tool-write', toolCallId: 'c', state: 'approval-requested', input: {}, approval: {} },
      // approval.approved 有值 = 已经回应过（AI SDK 在 response 里带 approved）
      {
        type: 'tool-write',
        toolCallId: 'c',
        state: 'approval-requested',
        input: {},
        approval: { id: 'a', approved: true }
      },
      { type: 'text', text: 'x' },
      null,
      42
    ]) {
      expect(approvalRequestOf(part), JSON.stringify(part)).toBeNull()
    }
  })

  it('一条消息里多个待批调用都取出来；没有就是空数组', () => {
    const message = {
      parts: [
        { type: 'text', text: '写两个文件' },
        {
          type: 'tool-write',
          toolCallId: 'c1',
          state: 'approval-requested',
          input: { path: 'a' },
          approval: { id: 'a1' }
        },
        {
          type: 'tool-edit',
          toolCallId: 'c2',
          state: 'approval-requested',
          input: { path: 'b' },
          approval: { id: 'a2' }
        },
        {
          type: 'tool-read',
          toolCallId: 'c3',
          state: 'output-available',
          input: { path: 'c' },
          output: 'x'
        }
      ]
    }

    expect(pendingApprovals(message).map((request) => request.approvalId)).toEqual(['a1', 'a2'])
    expect(hasPendingApproval(message)).toBe(true)
    expect(hasPendingApproval({ parts: [{ type: 'text', text: 'x' }] })).toBe(false)
    expect(hasPendingApproval(undefined)).toBe(false)
  })
})

describe('approvalPath', () => {
  it('只认非空字符串的 path', () => {
    expect(approvalPath({ path: 'a.txt' })).toBe('a.txt')
    expect(approvalPath({ path: '' })).toBeNull()
    expect(approvalPath({ path: 7 })).toBeNull()
    expect(approvalPath({ pattern: '**/*' })).toBeNull()
    expect(approvalPath('a.txt')).toBeNull()
    expect(approvalPath(null)).toBeNull()
  })

  it('round28 展示兜底：path → cwd → save_to 依次取（bash 取 cwd、fetch 取 save_to）', () => {
    expect(approvalPath({ command: 'echo hi', cwd: 'D:\\项目\\demo' })).toBe('D:\\项目\\demo')
    expect(approvalPath({ url: 'https://x', save_to: 'out.bin' })).toBe('out.bin')
    // path 优先于 cwd（move 之类同时带 path 的工具不受影响）
    expect(approvalPath({ path: 'a.txt', cwd: 'D:\\项目\\demo' })).toBe('a.txt')
    expect(approvalPath({ command: 'echo hi' })).toBeNull()
  })

  it('给了工具名：按服务端 guard 的能力类口径只认该字段（不猜字段、不造永不生效的规则）', () => {
    expect(approvalPath({ command: 'ls', cwd: 'D:\\项目\\demo' }, 'bash')).toBe('D:\\项目\\demo')
    // shell 不认 path / save_to（与 guard 的 capabilityTarget 同口径）
    expect(approvalPath({ command: 'ls', path: 'D:\\项目\\demo' }, 'bash')).toBeNull()
    expect(approvalPath({ command: 'ls', save_to: 'x' }, 'bash')).toBeNull()
    expect(approvalPath({ url: 'u', save_to: 'out.bin' }, 'fetch')).toBe('out.bin')
    expect(approvalPath({ url: 'u', cwd: 'D:\\项目\\demo' }, 'fetch')).toBeNull()
    // git / 内置文件工具 / MCP：只认 path
    expect(approvalPath({ paths: ['.'], path: 'D:\\项目\\demo' }, 'git_add')).toBe('D:\\项目\\demo')
    expect(approvalPath({ path: 'a.txt', cwd: 'x' }, 'write')).toBe('a.txt')
    expect(approvalPath({ path: 'a.txt', cwd: 'x' }, 'mcp__x__do')).toBe('a.txt')
  })
})

describe('capabilityToolOf / isDangerousTool（与服务端分档同口径的镜像）', () => {
  it('能力类按整名：bash / fetch / git_add / git_commit；MCP 名不算', () => {
    expect(capabilityToolOf('bash')).toBe('shell')
    expect(capabilityToolOf(' Bash ')).toBe('shell')
    expect(capabilityToolOf('fetch')).toBe('network')
    expect(capabilityToolOf('git_add')).toBe('git')
    expect(capabilityToolOf('git_commit')).toBe('git')
    for (const name of ['write', 'move', 'git_status', 'mcp__x__bash', '']) {
      expect(capabilityToolOf(name), name).toBeNull()
    }
  })

  it('危险档：delete / move（含 MCP 末段命中）；其余不是', () => {
    expect(isDangerousTool('delete')).toBe(true)
    expect(isDangerousTool(' DELETE ')).toBe(true)
    expect(isDangerousTool('move')).toBe(true)
    expect(isDangerousTool('mcp__x__delete')).toBe(true)
    for (const name of ['write', 'bash', 'git_commit', 'mcp__x__write', '']) {
      expect(isDangerousTool(name), name).toBe(false)
    }
  })
})

describe('approvalDetailOf（审批卡必须让用户看见自己在批什么）', () => {
  it('bash → 命令、fetch → URL、move → 目标位置（整名判定）', () => {
    expect(approvalDetailOf('bash', { command: 'pnpm test\n  --watch' })).toEqual({
      kind: 'command',
      text: 'pnpm test\n  --watch'
    })
    expect(approvalDetailOf('fetch', { url: 'https://example.com/api' })).toEqual({
      kind: 'url',
      text: 'https://example.com/api'
    })
    expect(approvalDetailOf('move', { path: 'a.txt', to: 'docs/a.txt' })).toEqual({
      kind: 'move-to',
      text: 'docs/a.txt'
    })
  })

  it('MCP 名不冒充（mcp__x__bash 的命令不当成我们的 bash）；认不出 / 空值 → null', () => {
    expect(approvalDetailOf('mcp__x__bash', { command: 'rm -rf /' })).toBeNull()
    expect(approvalDetailOf('bash', { command: '' })).toBeNull()
    expect(approvalDetailOf('fetch', { url: 7 })).toBeNull()
    expect(approvalDetailOf('write', { path: 'a.txt', content: 'x' })).toBeNull()
    expect(approvalDetailOf('bash', null)).toBeNull()
  })
})

describe('resolveApprovalWorkspace（只用于审批记忆粒度，不是安全边界）', () => {
  const workspaces = [WS_A, WS_B]

  it('绝对路径：归一后按前缀找包含它的工作区（大小写 / 分隔符不敏感）', () => {
    expect(resolveApprovalWorkspace({ path: 'D:\\项目\\demo\\子\\a.txt' }, workspaces)).toBe(
      WS_A.path
    )
    expect(resolveApprovalWorkspace({ path: 'd:/项目/demo/a.txt' }, workspaces)).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ path: 'E:\\另一个\\b.txt' }, workspaces)).toBe(WS_B.path)
  })

  it('绝对路径但不在任何工作区里 → null', () => {
    expect(resolveApprovalWorkspace({ path: 'C:\\Windows\\evil.txt' }, workspaces)).toBeNull()
    // 前缀相同但不在目录边界上（demo2 不在 demo 里）
    expect(resolveApprovalWorkspace({ path: 'D:\\项目\\demo2\\a.txt' }, workspaces)).toBeNull()
  })

  it('相对路径：第一个工作区（与服务端 resolveTarget 的顺序一致）', () => {
    expect(resolveApprovalWorkspace({ path: 'a.txt' }, workspaces)).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ path: '子/a.txt' }, workspaces)).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ path: 'a.txt' }, [WS_B])).toBe(WS_B.path)
  })

  it('没有 path / 没有工作区 → null', () => {
    expect(resolveApprovalWorkspace({ anything: 1 }, workspaces)).toBeNull()
    expect(resolveApprovalWorkspace({ path: 'a.txt' }, [])).toBeNull()
  })

  it('bash：按 cwd 判（绝对路径进哪个工作区、相对路径归第一个）；cwd 在工作区外 → null', () => {
    expect(
      resolveApprovalWorkspace({ command: 'ls', cwd: 'D:\\项目\\demo\\src' }, workspaces, 'bash')
    ).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ command: 'ls', cwd: 'E:\\另一个' }, workspaces, 'bash')).toBe(
      WS_B.path
    )
    expect(resolveApprovalWorkspace({ command: 'ls', cwd: 'sub' }, workspaces, 'bash')).toBe(
      WS_A.path
    )
    expect(
      resolveApprovalWorkspace({ command: 'ls', cwd: 'C:\\Windows\\System32' }, workspaces, 'bash')
    ).toBeNull()
  })

  it('bash 没给 cwd：授权列表恰好一条绑它；多工作区判不出（与服务端 guard 同口径）', () => {
    expect(resolveApprovalWorkspace({ command: 'echo hi' }, [WS_A], 'bash')).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ command: 'echo hi' }, workspaces, 'bash')).toBeNull()
  })

  it('fetch：按 save_to 判；没给 save_to 时单工作区兜底、多工作区判不出', () => {
    expect(
      resolveApprovalWorkspace(
        { url: 'u', save_to: 'D:\\项目\\demo\\out.bin' },
        workspaces,
        'fetch'
      )
    ).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ url: 'u' }, [WS_A], 'fetch')).toBe(WS_A.path)
    expect(resolveApprovalWorkspace({ url: 'u' }, workspaces, 'fetch')).toBeNull()
  })

  it('MCP 名不冒充能力类：mcp__x__bash 的 cwd 不参与判定（只认 path）', () => {
    expect(
      resolveApprovalWorkspace({ command: 'ls', cwd: 'D:\\项目\\demo' }, workspaces, 'mcp__x__bash')
    ).toBeNull()
    expect(
      resolveApprovalWorkspace({ path: 'D:\\项目\\demo\\a.txt' }, workspaces, 'mcp__x__bash')
    ).toBe(WS_A.path)
  })

  it('单工作区兜底只给能力类：危险档 / 未知工具 / 没给工具名都没有兜底', () => {
    expect(resolveApprovalWorkspace({}, [WS_A], 'delete')).toBeNull()
    expect(resolveApprovalWorkspace({ anything: 1 }, [WS_A], 'mcp__x__do')).toBeNull()
    expect(resolveApprovalWorkspace({ command: 'ls' }, [WS_A])).toBeNull()
  })
})

describe('会话记忆（"本会话允许"）：粒度 = 对话（thread）+ 工具 + 工作区', () => {
  it('记下 thread-1 的 write + wsA：别的对话、别的工作区、别的工具都不放行', () => {
    allowForSession('thread-1', 'write', WS_A.path)

    expect(isAllowedForSession('thread-1', 'write', WS_A.path)).toBe(true)
    expect(isAllowedForSession('thread-2', 'write', WS_A.path)).toBe(false)
    expect(isAllowedForSession('thread-1', 'write', WS_B.path)).toBe(false)
    expect(isAllowedForSession('thread-1', 'edit', WS_A.path)).toBe(false)
  })

  it('写法归一后命中（大小写 / 分隔符）', () => {
    allowForSession('thread-1', 'write', 'D:\\项目\\demo')

    expect(isAllowedForSession('thread-1', ' WRITE ', 'd:/项目/demo')).toBe(true)
  })

  it('MCP 名按整名归一：不串到内置同名工具、也不串到别的 server（T12 重审）', () => {
    allowForSession('thread-1', 'mcp__fs__write', WS_A.path)

    expect(isAllowedForSession('thread-1', 'mcp__fs__write', WS_A.path)).toBe(true)
    expect(isAllowedForSession('thread-1', 'write', WS_A.path)).toBe(false)
    expect(isAllowedForSession('thread-1', 'mcp__other__write', WS_A.path)).toBe(false)
  })

  it('round 76：delete / move 的粒度与其它工具一模一样（允许就是永久允许）', () => {
    allowForSession('thread-1', 'delete', WS_A.path)
    const request = approvalRequestOf({
      type: 'tool-delete',
      toolCallId: 'c1',
      state: 'approval-requested',
      input: { path: 'D:\\项目\\demo\\a.txt' },
      approval: { id: 'run-1::c1' }
    })!

    // 区内目标 + 记过 → 这个对话里的同工具调用不再弹卡（与 write 同一条路）
    expect(isAllowedForSessionNow('thread-1', request, WS_A.path, [WS_A])).toBe(true)
    // 粒度没变：同一个对话里的 move 不吃 delete 的记忆，别的对话也不吃
    expect(isAllowedForSession('thread-1', 'move', WS_A.path)).toBe(false)
    expect(isAllowedForSession('thread-2', 'delete', WS_A.path)).toBe(false)
  })
})

describe('canResumeAfterApproval（审批续跑就绪判定，T13×T14）', () => {
  const assistant = (parts: unknown[]): ReadonlyArray<{ role?: unknown; parts?: unknown }> => [
    { role: 'assistant', parts }
  ]

  const responded = (toolCallId: string): Record<string, unknown> => ({
    type: 'tool-write',
    toolCallId,
    state: 'approval-responded',
    input: {},
    approval: { id: `run::${toolCallId}`, approved: true }
  })

  it('单条 approval-responded → true（与 AI SDK 内置判定同语义）', () => {
    expect(canResumeAfterApproval(assistant([responded('c1')]))).toBe(true)
  })

  it('还没回应的审批 → false；兄弟工具停在 input-available → true（round28 挂起形状放行）', () => {
    // 还有审批没回应：不替用户往前跑
    expect(
      canResumeAfterApproval(
        assistant([
          {
            type: 'tool-write',
            toolCallId: 'c1',
            state: 'approval-requested',
            input: {},
            approval: { id: 'run::c1' }
          }
        ])
      )
    ).toBe(false)
    // 一条已回应、另一条还没回应：等用户把决策都做完
    expect(
      canResumeAfterApproval(
        assistant([
          responded('c1'),
          {
            type: 'tool-write',
            toolCallId: 'c2',
            state: 'approval-requested',
            input: {},
            approval: { id: 'run::c2' }
          }
        ])
      )
    ).toBe(false)
    // round28 定位的真 bug：挂起时同一步"已经执行完"的兄弟工具结果面不会发出来，
    // part 停在 input-available —— 这正是要放行续跑的形状（服务端续跑那轮会把结果补上）
    expect(
      canResumeAfterApproval(
        assistant([
          responded('c1'),
          { type: 'tool-glob', toolCallId: 'r1', state: 'input-available' }
        ])
      )
    ).toBe(true)
    // 参数都还没流完（input-streaming）不算可续跑
    expect(
      canResumeAfterApproval(
        assistant([
          responded('c1'),
          { type: 'tool-glob', toolCallId: 'r2', state: 'input-streaming' }
        ])
      )
    ).toBe(false)
  })

  it('T13×T14 修复：同一步里带 input-available 的记忆工具 part 也会续跑', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          {
            type: 'tool-updateWorkingMemory',
            toolCallId: 'wm1',
            state: 'input-available',
            input: { memory: '# 用户信息' }
          },
          responded('c1')
        ])
      )
    ).toBe(true)
  })

  it('providerExecuted 的 part 同样被滤掉（结果不进 UI 消息）', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          {
            type: 'tool-web_search',
            toolCallId: 's1',
            state: 'input-available',
            providerExecuted: true
          },
          responded('c1')
        ])
      )
    ).toBe(true)
  })

  it('没有任何可等待的调用 / 没有 approval-responded / 末条不是助手消息 → false', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          {
            type: 'tool-updateWorkingMemory',
            toolCallId: 'wm1',
            state: 'input-available',
            input: {}
          }
        ])
      )
    ).toBe(false)
    expect(canResumeAfterApproval(assistant([{ type: 'text', text: '好' }]))).toBe(false)
    expect(
      canResumeAfterApproval([
        { role: 'assistant', parts: [responded('c1')] },
        { role: 'user', parts: [{ type: 'text', text: '补充' }] }
      ])
    ).toBe(false)
    expect(canResumeAfterApproval([])).toBe(false)
  })

  it('只看最后一个 step-start 之后的最后一步（更早的回应不算数）', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          responded('c1'),
          { type: 'step-start' },
          { type: 'tool-read', toolCallId: 'r1', state: 'input-available' }
        ])
      )
    ).toBe(false)
    expect(
      canResumeAfterApproval(
        assistant([
          { type: 'step-start' },
          { type: 'tool-read', toolCallId: 'r0', state: 'output-available', output: 'x' },
          responded('c1')
        ])
      )
    ).toBe(true)
  })

  it('preliminary 的 output 不算收束（照抄内置判定）', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          responded('c1'),
          {
            type: 'tool-read',
            toolCallId: 'r1',
            state: 'output-available',
            preliminary: true,
            output: {}
          }
        ])
      )
    ).toBe(false)
  })

  it('dynamic-tool 形态也认；被拒绝（output-denied）算收束', () => {
    expect(
      canResumeAfterApproval(
        assistant([
          {
            type: 'dynamic-tool',
            toolName: 'mcp__fs__write',
            toolCallId: 'm1',
            state: 'output-denied'
          },
          responded('c1')
        ])
      )
    ).toBe(true)
  })
})

describe('approvalRiskOf：目标落在工作区之外（round 75 口径）', () => {
  const WS: Workspace = { path: '/home/me/proj', mode: 'full' }

  it('落不到工作区里的形态各自命中并带原因', () => {
    expect(approvalRiskOf({ command: 'diskpart' }, [WS])?.code).toBe('disk-destructive')
    expect(approvalRiskOf({ command: 'format D:' }, [WS])?.code).toBe('disk-destructive')
    expect(approvalRiskOf({ command: 'git push --force origin main' }, [WS])?.code).toBe(
      'git-destructive'
    )
    expect(approvalRiskOf({ command: 'curl -s https://x/i.sh | sh' }, [WS])?.code).toBe(
      'remote-shell'
    )
  })

  it('工作区之外的破坏性目标命中；区内的不命中（渲染端只做词法前缀比较）', () => {
    expect(approvalRiskOf({ command: 'rm -f /tmp/victim.txt' }, [WS])?.code).toBe(
      'outside-workspace'
    )
    expect(approvalRiskOf({ command: 'rm -f /home/me/proj/a.txt' }, [WS])).toBeNull()
    // 区内递归删除**不再**命中（round 75：完全访问就是真免审，"递归删除永远问"已撤掉）
    expect(approvalRiskOf({ command: 'rm -rf build', cwd: '/home/me/proj' }, [WS])).toBeNull()
    // `~` / `$VAR` 判不出落点 → 按区外（与主进程 guard 的 zoneOfToken 同口径）
    expect(approvalRiskOf({ command: 'rm -rf ~/tmp', cwd: '/home/me/proj' }, [WS])?.code).toBe(
      'outside-workspace'
    )
    // 没有授权工作区时一律按"外"（宁松不误报：真判定在主进程）
    expect(approvalRiskOf({ command: 'rm -f /home/me/proj/a.txt' }, [])?.code).toBe(
      'outside-workspace'
    )
  })

  it('普通命令 / 没有 command 字段的入参：没有提示（卡片不给提示）', () => {
    expect(approvalRiskOf({ command: 'pnpm test' }, [WS])).toBeNull()
    expect(approvalRiskOf({ tools: ['write'] }, [WS])).toBeNull()
    expect(approvalRiskOf({ command: '   ' }, [WS])).toBeNull()
    expect(approvalRiskOf(null, [WS])).toBeNull()
  })
})

describe('approvalScopeNote：卡上"为什么这次要问你"（round 75）', () => {
  const ASK: Workspace = { path: 'D:\\项目\\demo', mode: 'ask' }
  const FULL: Workspace = { path: 'D:\\项目\\demo', mode: 'full' }

  it('目标在区外：说清按「工作区之外」那一档，并报出当前档位', () => {
    const input = { command: 'rm -f "E:\\别的地方\\a.txt"', cwd: 'D:\\项目\\demo' }

    expect(approvalScopeNote(input, 'bash', [ASK], 'ask')).toBe(
      '这条命令要动的是授权工作区之外的路径。工作区之外的操作按「工作区之外」那一档判定（现在是「每次询问」，可在「设置 → 工作区」里改）。'
    )
    expect(approvalScopeNote(input, 'bash', [ASK], 'full')).toContain('现在是「完全访问」')
  })

  it('区内的 ask 档：点名是哪个文件夹 + 去哪儿改成完全访问', () => {
    const note = approvalScopeNote({ path: 'a.txt' }, 'write', [ASK], 'ask')

    expect(note).toContain('「D:\\项目\\demo」这一档是「每次询问」')
    expect(note).toContain('设置 → 工作区')
  })

  it('区内 full / 判不出工作区：不解释（宁可不写，也不写一句可能不成立的话）', () => {
    expect(approvalScopeNote({ path: 'a.txt' }, 'write', [FULL], 'ask')).toBeNull()
    expect(approvalScopeNote({ anything: 1 }, 'mcp__a__do', [ASK], 'ask')).toBeNull()
    expect(approvalScopeNote({ path: 'a.txt' }, 'write', [], 'ask')).toBeNull()
  })
})

/**
 * round 75「渐进披露」：MCP 工具不再逐件注入，每台 server 只剩一个元工具
 * `mcp__<serverId>__meta`（`{action:'list'}` / `{action:'call', tool, args}`）。
 * 服务端闸门一直按**真名**工作；渲染端若不解包，审批卡与"本会话允许"的粒度就从
 * "某个工具"塌成"某个 server"（记成 `mcp__x__meta` → 之后这台 server 的任何调用都被
 * 客户端自动回灌放行），"永久允许"写下的规则也永不命中。这里钉的就是这两条。
 */
describe('元工具的审批粒度（round 75）：认的是真名与真入参', () => {
  const META = 'mcp__mcp-1__meta'

  function metaApproval(tool: string, args: unknown, toolCallId = 'c1'): Record<string, unknown> {
    return {
      type: 'dynamic-tool',
      toolName: META,
      toolCallId,
      state: 'approval-requested',
      input: { action: 'call', tool, args },
      approval: { id: `run-1::${toolCallId}` }
    }
  }

  /** 走一遍卡片与 ChatPage 共用的那把尺：这次调用算在哪个工作区 */
  function decideWorkspace(request: { input: unknown; toolName: string }): string | null {
    return resolveApprovalWorkspace(request.input, [WS_A], request.toolName)
  }

  it('请求带的是真名与真入参（卡片标题、目标、diff 才有得算）', () => {
    const request = approvalRequestOf(
      metaApproval('search', { path: 'D:\\项目\\demo\\a.md', query: 'kyclaw' })
    )

    expect(request?.toolName).toBe('mcp__mcp-1__search')
    expect(request?.input).toEqual({ path: 'D:\\项目\\demo\\a.md', query: 'kyclaw' })
    // 展示目标（approvalPath 的兜底顺序）：真入参里的 path
    expect(request?.path).toBe('D:\\项目\\demo\\a.md')
    expect(decideWorkspace(request!)).toBe(WS_A.path)

    // 静态 tool- 形态（历史消息经 message-map 回放时的形状）同样解包
    const restored = approvalRequestOf({
      type: 'tool-mcp__mcp-1__meta',
      toolCallId: 'c7',
      state: 'approval-requested',
      input: { action: 'call', tool: 'search', args: { path: 'D:\\项目\\demo\\a.md' } },
      approval: { id: 'run-1::c7' }
    })
    expect(restored?.toolName).toBe('mcp__mcp-1__search')
    expect(restored?.input).toEqual({ path: 'D:\\项目\\demo\\a.md' })
  })

  it('「本会话允许」记真名：允许 search 之后，同一 server 的另一个工具**不**被自动放行', () => {
    const search = approvalRequestOf(metaApproval('search', { path: 'D:\\项目\\demo\\a.md' }))!
    // 用户在卡上点「本会话允许」→ 记的就是 request.toolName
    allowForSession('thread-1', search.toolName, WS_A.path)

    expect(isAllowedForSession('thread-1', 'mcp__mcp-1__search', WS_A.path)).toBe(true)
    // 塌陷的旧行为：记成元工具名，这台 server 的任何调用都会命中
    expect(isAllowedForSession('thread-1', META, WS_A.path)).toBe(false)

    // 同一个 server 的另一个工具：不因为 search 被允许而放行
    const write = approvalRequestOf(metaApproval('write', { path: 'D:\\项目\\demo\\b.md' }, 'c2'))!
    expect(write.toolName).toBe('mcp__mcp-1__write')
    expect(isAllowedForSessionNow('thread-1', write, decideWorkspace(write), [WS_A])).toBe(false)

    // 同一个工具的下一次调用照旧命中（「本会话允许」本该有的效果）
    const again = approvalRequestOf(metaApproval('search', { path: 'D:\\项目\\demo\\c.md' }, 'c3'))!
    expect(isAllowedForSessionNow('thread-1', again, decideWorkspace(again), [WS_A])).toBe(true)
  })

  it('「永久允许」写下的是真名规则：同一 server 的另一个工具不吃这条规则', () => {
    const search = approvalRequestOf(metaApproval('search', { path: 'D:\\项目\\demo\\a.md' }))!
    const rules = withAllowedRule([], search.toolName, WS_A.path)

    expect(rules).toEqual([{ tool: 'mcp__mcp-1__search', workspace: WS_A.path, mode: 'allow' }])
    expect(isAllowedByRules(rules, 'mcp__mcp-1__search', WS_A.path)).toBe(true)
    // 塌陷的旧行为：写下的规则名与服务端按真名查的那把尺对不上（点了等于没点）
    expect(isAllowedByRules(rules, 'mcp__mcp-1__write', WS_A.path)).toBe(false)
    expect(isAllowedByRules(rules, META, WS_A.path)).toBe(false)
  })

  it('红线复算看的是真入参（元工具壳里的命令一样被看见）', () => {
    const request = approvalRequestOf(
      metaApproval('bash', { command: 'diskpart', cwd: 'D:\\项目\\demo' })
    )!

    expect(request.toolName).toBe('mcp__mcp-1__bash')
    expect(request.input).toEqual({ command: 'diskpart', cwd: 'D:\\项目\\demo' })
    // 不解包的话 input 里根本没有 command，这一条恒为 null（卡片也就说不清为什么问）
    expect(approvalRiskOf(request.input, [WS_A])?.code).toBe('disk-destructive')

    // 区外的目标同样被看见（与审批卡上那行"为什么问"同一把尺）
    const outside = approvalRequestOf(
      metaApproval('bash', { command: 'rm -f /tmp/victim.txt', cwd: 'D:\\项目\\demo' }, 'c2')
    )!
    expect(approvalRiskOf(outside.input, [WS_A])?.code).toBe('outside-workspace')
  })

  it('list 档 / 非元工具：请求原样（不认识就不猜）', () => {
    const list = approvalRequestOf({
      type: 'dynamic-tool',
      toolName: META,
      toolCallId: 'c9',
      state: 'approval-requested',
      input: { action: 'list' },
      approval: { id: 'run-1::c9' }
    })!
    expect(list.toolName).toBe(META)
    expect(list.input).toEqual({ action: 'list' })

    const plain = approvalRequestOf({
      type: 'tool-write',
      toolCallId: 'c8',
      state: 'approval-requested',
      input: { path: 'D:\\项目\\demo\\a.md' },
      approval: { id: 'run-1::c8' }
    })!
    expect(plain.toolName).toBe('write')
    expect(plain.input).toEqual({ path: 'D:\\项目\\demo\\a.md' })
  })
})
