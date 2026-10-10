import { afterEach, describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/settings'
import {
  allowForSession,
  approvalPath,
  approvalRequestOf,
  hasPendingApproval,
  isAllowedForSession,
  pendingApprovals,
  resetSessionApprovals,
  resolveApprovalWorkspace
} from '../approval'

/**
 * 审批 part 的读取与记忆（T13）：part → 待审批请求、工作区判定、会话记忆的粒度。
 * 粒度这条是 brief 点名的验收点：允许 write + wsA 不能顺带放过 write + wsB 或 edit + wsA。
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
})

describe('会话记忆（"本会话允许"）：粒度 = 工具 + 工作区', () => {
  it('记下 write + wsA：write + wsB 与 edit + wsA 都不放行', () => {
    allowForSession('write', WS_A.path)

    expect(isAllowedForSession('write', WS_A.path)).toBe(true)
    expect(isAllowedForSession('write', WS_B.path)).toBe(false)
    expect(isAllowedForSession('edit', WS_A.path)).toBe(false)
  })

  it('写法归一后命中（大小写 / 分隔符 / MCP 前缀）', () => {
    allowForSession('write', 'D:\\项目\\demo')

    expect(isAllowedForSession('mcp__fs__write', 'd:/项目/demo')).toBe(true)
  })

  it('MCP 名按最后一段归一（与 classify 的工具身份同一口径；T12 接入时再重审）', () => {
    allowForSession('mcp__fs__write', WS_A.path)

    expect(isAllowedForSession('write', WS_A.path)).toBe(true)
    expect(isAllowedForSession('mcp__other__write', WS_A.path)).toBe(true)
  })
})
