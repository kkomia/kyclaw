// @vitest-environment node
/**
 * 审批策略的真服务用例（T13）：权限边界全部走**落盘的 settings.json**，不再靠测试注入。
 *
 * 覆盖 brief 的三个必查项里可以在服务端钉住的两条（第三条"挂起轮≠完成轮"在渲染端）：
 *   ② full 入口收紧：workspace:add 只以 ask 落盘；切 full 走 setMode（且只认已授权路径），
 *      切完服务端当轮就放行、切回来又开始问；
 *   ③ 跨会话 read 隔离：A 会话 read 过不算 B 会话的（"未读先改"按 agent 线程隔离）。
 * 另外把"永久允许"规则（settings.permissions.rules）的真服务行为钉住：命中就不弹审批。
 *
 * 服务器不注入 workspaces：main/agent/service 缺省从 dataDir/settings.json 现读 ——
 * 设置页（IPC handler）写的就是同一份，所以这里测的是"设置改了、下一轮生效"的真链路。
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../../agents/kyclaw'
import { threadMemoryBody } from '../../../shared/threads'
import { readSettings, settingsPath, updateSettings } from '../../../main/settings'

/** 主进程的 workspace:* handler（真件）：mock 掉 electron 的 ipcMain/dialog 就能直接调用 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn() }
}))

import { IPC_CHANNELS } from '../../../shared/ipc'
import { registerWorkspaceIpc } from '../../../main/ipc/workspace'

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

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

/** SSE 响应体 → 结构化 part 列表（跳过 [DONE] 终结行） */
function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

function pushWriteScript(toolCallId: string, path: string, content: string): void {
  scripts.push(() => toolCallScript(toolCallId, 'write', { path, content }))
  scripts.push(() => textScript('好，处理完了。'))
}

async function chat(
  messages: unknown[],
  threadId: string
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

function user(id: string, text: string): Record<string, unknown> {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function toolError(parts: Array<Record<string, unknown>>): string {
  const error = parts.find((part) => part.type === 'tool-output-error')
  return String(error?.errorText ?? '')
}

/** 当前落盘的授权列表（断言 IPC handler 真写盘了） */
function storedWorkspaces(): Array<{ path: string; mode: string }> {
  return readSettings(settingsPath(dir)).workspaces
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-approval-policy-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  writeFileSync(join(workspace, 'a.txt'), 'AAA\nBBB\n', 'utf8')

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-policy-mock',
    modelId: 'kyclaw-policy-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })

  // 不注入 workspaces / permissionRules：服务端现读 dataDir/settings.json（与 IPC handler 同一份）
  server = await startAgentServer({ dataDir: dir, model })
  registerWorkspaceIpc(dir)
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('full 入口收紧（T13）', () => {
  it('workspace:add 只以 ask 落盘 → 写类仍然弹审批；setMode full 之后当轮放行；切回来又弹', async () => {
    // 1. 经真 IPC handler 把目录加进授权列表（这正是设置页"添加文件夹"走的路）
    handlerOf(IPC_CHANNELS.workspace.add)(EVENT, workspace)
    expect(storedWorkspaces()).toEqual([{ path: workspace, mode: 'ask' }])

    scripts.length = 0
    pushWriteScript('call-ask', 'ask.txt', 'ask 模式')
    const asked = await chat([user('u-ask', '写一个文件')], 'thread-ask')
    expect(asked.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(workspace, 'ask.txt'))).toBe(false)

    // 2. 切 full（只认已授权路径）→ 服务端下一轮不再问
    handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, workspace, 'full')
    expect(storedWorkspaces()).toEqual([{ path: workspace, mode: 'full' }])

    scripts.length = 0
    pushWriteScript('call-full', 'full.txt', 'full 模式')
    const full = await chat([user('u-full', '写一个文件')], 'thread-full')
    expect(full.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(full.some((part) => part.type === 'tool-output-available')).toBe(true)
    expect(readFileSync(join(workspace, 'full.txt'), 'utf8')).toBe('full 模式')

    // 3. 切回 ask → 又开始问（切模式现读生效，不需要重启服务）
    handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, workspace, 'ask')
    scripts.length = 0
    pushWriteScript('call-ask2', 'ask2.txt', '又回 ask')
    const askedAgain = await chat([user('u-ask2', '写一个文件')], 'thread-ask2')
    expect(askedAgain.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(workspace, 'ask2.txt'))).toBe(false)
  }, 60_000)

  it('setMode 一个不在授权列表里的路径：被拒（不能借它加 full）', () => {
    expect(() =>
      handlerOf(IPC_CHANNELS.workspace.setMode)(EVENT, join(dir, '没授权'), 'full')
    ).toThrow(/不在授权列表/)
  })
})

describe('永久允许规则（settings.permissions.rules）', () => {
  it('命中规则的写类不再弹审批；规则只对匹配到的工具 + 工作区生效', async () => {
    // 审批卡点"永久允许"写的就是这一条（经 settings:update 的补丁；这里用同一份落盘函数）
    updateSettings(settingsPath(dir), {
      permissions: { rules: [{ tool: 'write', workspace, mode: 'allow' }] }
    })

    scripts.length = 0
    pushWriteScript('call-rule', 'rule.txt', '规则放行')
    const allowed = await chat([user('u-rule', '写一个文件')], 'thread-rule')
    expect(allowed.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(readFileSync(join(workspace, 'rule.txt'), 'utf8')).toBe('规则放行')

    // 换个工具（edit 没规则）→ 继续问
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('call-edit', 'edit', { path: 'a.txt', oldText: 'AAA', newText: 'X' })
    )
    scripts.push(() => textScript('改完了。'))
    const edit = await chat([user('u-edit', '改文件')], 'thread-edit')
    expect(edit.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('AAA\nBBB\n')

    // 清掉规则 → write 又开始问（规则现读）
    updateSettings(settingsPath(dir), { permissions: { rules: [] } })
    scripts.length = 0
    pushWriteScript('call-clean', 'clean.txt', '没规则')
    const again = await chat([user('u-clean', '写一个文件')], 'thread-clean')
    expect(again.some((part) => part.type === 'tool-approval-request')).toBe(true)
  }, 60_000)
})

describe('跨会话 read 隔离（"未读先改"按 agent 线程算）', () => {
  it('A 会话 read 过不算 B 会话的：B 直接 edit 被拒，B 自己 read 之后才改得动', async () => {
    // 让 edit 不弹审批，专注 read 记录：只给 edit 一条永久允许规则
    updateSettings(settingsPath(dir), {
      permissions: { rules: [{ tool: 'edit', workspace, mode: 'allow' }] }
    })

    // 会话 A：read（记进 A 的已读表）
    scripts.length = 0
    scripts.push(() => toolCallScript('a-read', 'read', { path: 'a.txt' }))
    scripts.push(() => textScript('看到了。'))
    const readA = await chat([user('a-1', '读 a.txt')], 'thread-A')
    expect(readA.some((part) => part.type === 'tool-output-available')).toBe(true)

    // 会话 A：edit —— 同一会话，改得动
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('a-edit', 'edit', { path: 'a.txt', oldText: 'AAA', newText: 'AAA1' })
    )
    scripts.push(() => textScript('改好了。'))
    const editA = await chat([user('a-2', '把 AAA 改成 AAA1')], 'thread-A')
    expect(toolError(editA)).toBe('')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('AAA1\nBBB\n')

    // 会话 B：直接 edit —— 没读过，被"未读先改"拒掉
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('b-edit', 'edit', { path: 'a.txt', oldText: 'AAA1', newText: 'BBB' })
    )
    scripts.push(() => textScript('改不动。'))
    const editB = await chat([user('b-1', '把 AAA1 改成 BBB')], 'thread-B')
    expect(toolError(editB)).toContain('未读先改')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('AAA1\nBBB\n')

    // 会话 B：read 之后再 edit —— 这次成功（记录记在 B 自己名下）
    scripts.length = 0
    scripts.push(() => toolCallScript('b-read', 'read', { path: 'a.txt' }))
    scripts.push(() =>
      toolCallScript('b-edit2', 'edit', { path: 'a.txt', oldText: 'AAA1', newText: 'BBB0' })
    )
    scripts.push(() => textScript('这次改好了。'))
    const editB2 = await chat([user('b-2', '先读再改')], 'thread-B')
    expect(toolError(editB2)).toBe('')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('BBB0\nBBB\n')

    // 会话 C 再试一次直接改：仍然被拒（隔离是双向的，不是"谁读过一次全体放行"）
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('c-edit', 'edit', { path: 'a.txt', oldText: 'BBB0', newText: 'CCC' })
    )
    scripts.push(() => textScript('也不给改。'))
    const editC = await chat([user('c-1', '直接改')], 'thread-C')
    expect(toolError(editC)).toContain('未读先改')

    updateSettings(settingsPath(dir), { permissions: { rules: [] } })
  }, 90_000)
})
