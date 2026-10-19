// @vitest-environment node
/**
 * PB-021 · E2E kernel stub ↔ 宿主编排契约（**离线、无 Electron、无真内核快照、CI 可复跑**）
 *
 * 验的是什么：`e2e/kernel-stub/kernel-stub.cjs` 长在"真内核入口"的位置上时，
 * 产品侧 `startKernelAdapter` 能不能按**真协议**把它跑起来并拿到与 0.1.6 参考帧逐字段一致的 SSE。
 * 也就是说：stub 不是在 e2e 里绕过旧 mock，它替换的是"内核进程"这一层，走的是
 *   就绪行 → /connect 换 cookie → 一元 /api RPC → WS mux follow → snapshot opening →
 *   assistant-stream 帧 → turn/end 结算（completed/cancelled/error）
 * 全链路（消费方：kernel-process/kernel-auth/kernel-rpc/ws-mux/kernel-adapter/sse-map）。
 *
 * 契约字段来源（只认代码，不认设计稿）：
 *   - `src/main/kernel/kernel-process.ts:34` READY_PATTERN
 *   - `src/main/kernel/kernel-auth.ts:26-62`（302 + set-cookie + Location）
 *   - `src/main/kernel/kernel-rpc.ts:19-52`（client-request/server-response 信封）
 *   - `src/main/kernel/kernel-adapter.ts:225-413`（openFollow / snapshot / item / error / turn 结算）
 *   - `src/main/kernel/sse-map.ts:88-247`（帧映射与顺序）
 *   - 参考基准 `__tests__/fixtures/renderer-sse-kyclaw-0.1.6.json`
 *
 * 跑法：`pnpm vitest run src/main/kernel/__tests__/nia-kernel-stub-contract.spec.ts`
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import { defaultKernelRoot, resolveKernelLayout, KERNEL_ROOT_ENV } from '../kernel-layout'
import { InteractionHub, feedKernelEvent } from '../interaction-hub'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const STUB_SOURCE = join(repoRoot, 'e2e', 'kernel-stub', 'kernel-stub.cjs')
const REFERENCE = fileURLToPath(
  new URL('./fixtures/renderer-sse-kyclaw-0.1.6.json', import.meta.url)
)
const ELECTRON = join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const ELECTRON_AVAILABLE = existsSync(ELECTRON)
const STUB_VERSION = 'e2e-stub'
const REF_TEXT = '字段级等价参考文本。'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 与 `e2e/kernel-stub/launcher.ts` 同构的最小内核树（布局：current.json + <version>/node_modules/...） */
function materializeStub(rootDir: string): { kernelRoot: string; versionDir: string; entry: string } {
  const versionDir = join(rootDir, STUB_VERSION)
  const entryDir = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entryDir, { recursive: true })
  writeFileSync(
    join(rootDir, 'current.json'),
    `${JSON.stringify({ version: '0.2.1-e2e-stub', path: STUB_VERSION, sha256: 'e2e-stub-offline' }, null, 2)}\n`
  )
  writeFileSync(join(versionDir, 'SNAPSHOT.json'), '{}\n')
  writeFileSync(
    join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-e2e-stub', private: true }, null, 2)}\n`
  )
  const entry = join(entryDir, 'bin.js')
  copyFileSync(STUB_SOURCE, entry)
  return { kernelRoot: rootDir, versionDir, entry }
}

interface StubAdapterHandle {
  adapter: KernelAdapter
  logFile: string
  stop: () => Promise<void>
}

interface StubAdapterHooks {
  onSessionEvent?: (threadId: string, event: { type?: string; seq?: number; data?: Record<string, unknown> }) => void
}

async function startStubAdapter(
  extraEnv: Record<string, string> = {},
  executable: string = process.execPath,
  turnTimeoutMs = 20_000,
  hooks: StubAdapterHooks = {}
): Promise<StubAdapterHandle> {
  const rootDir = tempDir('kyclaw-stub-kernel-')
  const { versionDir } = materializeStub(rootDir)
  const dataDir = tempDir('kyclaw-stub-data-')
  const logFile = join(rootDir, 'stub.log')
  const adapter = await startKernelAdapter({
    electronExecutable: executable,
    asarPath: versionDir,
    appDataDir: dataDir,
    extraEnv: { KYCLAW_STUB_LOG: logFile, KYCLAW_STUB_CHUNK_DELAY_MS: '0', ...extraEnv },
    readyTimeoutMs: 20_000,
    turnTimeoutMs,
    ...(hooks.onSessionEvent === undefined ? {} : { onSessionEvent: hooks.onSessionEvent })
  })
  return {
    adapter,
    logFile,
    stop: async () => {
      await adapter.stop()
    }
  }
}

function readStubLog(logFile: string): Array<Record<string, unknown>> {
  const text = readFileSync(logFile, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 去掉随机值，只比字段名与结构（与 sse-reference.spec.ts 同一口径） */
function normalizeFrames(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.messageId === 'string') clone.messageId = '<message-id>'
    if (typeof clone.id === 'string') clone.id = '<id>'
    return clone
  })
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] stub contract temp cleanup deferred', dir)
    }
  }
})

describe('PB-021 · kernel stub 布局/注入 seam（defaultKernelRoot + resolveKernelLayout）', () => {
  it('KYCLAW_KERNEL_ROOT 覆盖打包态/开发态默认值（e2e 注入就靠这一条）', () => {
    const override = tempDir('kyclaw-stub-seam-')
    expect(
      defaultKernelRoot({
        isPackaged: false,
        resourcesPath: join('C:', 'resources'),
        appPath: join('C:', 'app'),
        env: { [KERNEL_ROOT_ENV]: override }
      })
    ).toBe(override)
    expect(
      defaultKernelRoot({ isPackaged: true, resourcesPath: join('C:', 'res'), appPath: '', env: {} })
    ).toBe(join('C:', 'res', 'kernel'))
    expect(
      defaultKernelRoot({ isPackaged: false, resourcesPath: '', appPath: join('C:', 'app'), env: {} })
    ).toBe(join('C:', 'app', 'resources', 'kernel'))
  })

  it('布局解析把 stub 认成 kernel-tree（入口 = <version>/node_modules/@deepseek-ai/dsh/lib/bin.js）', () => {
    const rootDir = tempDir('kyclaw-stub-layout-')
    const { entry } = materializeStub(rootDir)
    const layout = resolveKernelLayout({ kernelRoot: rootDir })
    expect(layout.ok).toBe(true)
    if (!layout.ok) return
    expect(layout.kind).toBe('kernel-tree')
    expect(layout.scriptPath).toBe(entry)
  })
})

describe('PB-021 · stub ↔ adapter 全链路（node 进程，离线）', () => {
  let handle: StubAdapterHandle

  beforeAll(async () => {
    handle = await startStubAdapter({
      KYCLAW_STUB_CHUNKS: JSON.stringify([REF_TEXT]),
      KYCLAW_STUB_CHUNK_DELAY_MS: '0'
    })
  }, 60_000)

  afterAll(async () => {
    await handle?.stop()
  })

  it('启动就绪：拿到随机端口/pid，且 stub 日志证明这轮真走了它', async () => {
    expect(handle.adapter.port).toBeGreaterThan(0)
    expect(typeof handle.adapter.sessionId).toBe('string')
    const log = readStubLog(handle.logFile)
    expect(log.some((item) => item.event === 'ready')).toBe(true)
    expect(log.some((item) => item.event === 'connect')).toBe(true)
  })

  it('一轮文本：映射出的 renderer SSE 帧与 0.1.6 参考逐字段一致（start→…→finish）', async () => {
    const result = await handle.adapter.startTurn('say hi')
    expect(result.text).toBe(REF_TEXT)
    const reference = JSON.parse(readFileSync(REFERENCE, 'utf8')) as Record<string, unknown>[]
    expect(normalizeFrames(result.frames as unknown as Record<string, unknown>[])).toEqual(
      normalizeFrames(reference)
    )
    const log = readStubLog(handle.logFile)
    expect(log.some((item) => item.event === 'session-prompt')).toBe(true)
  })

  it('重试（PB-013 reset-step）：前 N 次 attempt 的正文从有效帧剔除，实时流照旧发 reset-step', async () => {
    const handle = await startStubAdapter({
      KYCLAW_STUB_RETRY_ATTEMPTS: '2',
      KYCLAW_STUB_CHUNKS: JSON.stringify(['最终正文。']),
      KYCLAW_STUB_CHUNK_DELAY_MS: '0'
    })
    try {
      const live: string[] = []
      const result = await handle.adapter.startTurn('重试轮', {
        onFrame: (frame) => {
          live.push(frame.type)
        }
      })
      // 有效帧：只留最终 attempt 的正文；每次重试一条 reset-step
      expect(result.frames.filter((frame) => frame.type === 'reset-step')).toHaveLength(2)
      expect(
        result.frames.flatMap((frame) =>
          frame.type === 'text-delta' && typeof frame.delta === 'string' ? [frame.delta] : []
        )
      ).toEqual(['最终正文。'])
      expect(JSON.stringify(result.frames)).not.toContain('被作废的正文')
      // 实时流：reset-step 真的发给了 renderer（UI 靠它丢旧正文）
      expect(live.filter((type) => type === 'reset-step')).toHaveLength(2)
      expect(result.text).toBe('最终正文。')
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('会话面：session/list 能看到该会话；reattach 拿到 opening cursor 后还能再跑一轮', async () => {
    const sessions = await handle.adapter.listKernelSessions()
    expect(sessions.map((item) => item.sessionId)).toContain(handle.adapter.sessionId)
    const opening = await handle.adapter.reattach(handle.adapter.sessionId)
    expect(typeof opening.cursor).toBe('number')
    const second = await handle.adapter.startTurn('第二轮', {
      threadId: handle.adapter.sessionId
    })
    expect(second.text).toBe(REF_TEXT)
  })
})

describe('PB-021 · stub 的 cancel / error / tool 帧', () => {
  it('取消：turn/end cancelled 结算，已交付文本保留且不再增长', async () => {
    const handle = await startStubAdapter({
      KYCLAW_STUB_CHUNKS: JSON.stringify(['第一段', '第二段', '第三段']),
      KYCLAW_STUB_CHUNK_DELAY_MS: '400'
    })
    try {
      let releaseFirst: (() => void) | undefined
      const sawFirstDelta = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const turn = handle.adapter.startTurn('先别急着答', {
        onFrame: (frame) => {
          if (frame.type === 'text-delta') releaseFirst?.()
        }
      })
      await sawFirstDelta
      await handle.adapter.cancelTurn()
      const result = await turn
      expect(result.cancelled).toBe(true)
      expect(result.text).toBe('第一段')
      expect(result.frames.some((frame) => frame.type === 'error')).toBe(false)
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('错误轮：error 帧追加在已交付文本之后，result.error 带内核错误码', async () => {
    const handle = await startStubAdapter({
      KYCLAW_STUB_SCENARIO: 'error',
      KYCLAW_STUB_CHUNKS: JSON.stringify(['先交付这句。']),
      KYCLAW_STUB_ERROR: JSON.stringify({ code: 'TRANSPORT', message: 'stub 脚本化错误' })
    })
    try {
      const result = await handle.adapter.startTurn('出个错')
      expect(result.text).toBe('先交付这句。')
      expect(result.error?.code).toBe('TRANSPORT')
      const last = result.frames.at(-1)
      expect(last).toEqual({ type: 'error', errorText: '[TRANSPORT] stub 脚本化错误' })
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('负向控制：stub 首段后不发 turn/end（hang）→ 宿主必须超时 reject，不许假绿', async () => {
    const handle = await startStubAdapter(
      {
        KYCLAW_STUB_SCENARIO: 'hang',
        KYCLAW_STUB_CHUNKS: JSON.stringify(['只有第一段']),
        KYCLAW_STUB_CHUNK_DELAY_MS: '0'
      },
      process.execPath,
      1_500
    )
    try {
      await expect(handle.adapter.startTurn('hang 场景')).rejects.toThrow(/turn timed out/)
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('工具帧：tool/call + tool/result 映射成 tool-input-available / tool-output-available（只回放事件，不执行工具）', async () => {
    const handle = await startStubAdapter({
      KYCLAW_STUB_CHUNKS: JSON.stringify(['我来查一下。']),
      KYCLAW_STUB_TOOL: JSON.stringify({
        name: 'read',
        input: { path: 'note.txt' },
        result: { content: 'hello' }
      })
    })
    try {
      const result = await handle.adapter.startTurn('读文件')
      const toolInput = result.frames.find((frame) => frame.type === 'tool-input-available')
      const toolOutput = result.frames.find((frame) => frame.type === 'tool-output-available')
      expect(toolInput).toEqual({
        type: 'tool-input-available',
        toolCallId: expect.any(String),
        toolName: 'read',
        input: { path: 'note.txt' }
      })
      expect(toolOutput).toEqual({
        type: 'tool-output-available',
        toolCallId: expect.any(String),
        output: { content: 'hello' }
      })
    } finally {
      await handle.stop()
    }
  }, 60_000)
})

describe('PB-021 · 审批事件（PB-004 stub 侧骨架：只发事件，不应答/不执行工具）', () => {
  it('approval/asked → InteractionHub 出现挂起审批；没有 decided 就保持挂起', async () => {
    const hub = new InteractionHub()
    const seen: string[] = []
    const handle = await startStubAdapter(
      {
        KYCLAW_STUB_APPROVAL: JSON.stringify({
          id: 'ap-1',
          toolName: 'write',
          callId: 'call-1',
          reason: '写工作区文件'
        })
      },
      process.execPath,
      20_000,
      {
        onSessionEvent: (threadId, event) => {
          if (typeof event.type === 'string') seen.push(event.type)
          feedKernelEvent(hub, threadId, event)
        }
      }
    )
    try {
      await handle.adapter.startTurn('写文件')
      expect(seen).toContain('approval/asked')
      const snapshot = hub.snapshot(handle.adapter.sessionId)
      expect(snapshot.approvals.pending).toHaveLength(1)
      expect(snapshot.approvals.pending[0]).toMatchObject({
        id: 'ap-1',
        toolName: 'write',
        callId: 'call-1',
        reason: '写工作区文件'
      })
      expect(snapshot.approvals.results).toHaveLength(0)
    } finally {
      await handle.stop()
    }
  }, 60_000)

  it('approval/asked + approval/decided → 挂起清空、结果行 outcome=allowed-once（四态之一）', async () => {
    const hub = new InteractionHub()
    const handle = await startStubAdapter(
      {
        KYCLAW_STUB_APPROVAL: JSON.stringify({
          id: 'ap-2',
          toolName: 'write',
          callId: 'call-2',
          decision: { id: 'ap-2', outcome: 'allowed-once' }
        })
      },
      process.execPath,
      20_000,
      {
        onSessionEvent: (threadId, event) => {
          feedKernelEvent(hub, threadId, event)
        }
      }
    )
    try {
      await handle.adapter.startTurn('写文件')
      const snapshot = hub.snapshot(handle.adapter.sessionId)
      expect(snapshot.approvals.pending).toHaveLength(0)
      expect(snapshot.approvals.results).toHaveLength(1)
      expect(snapshot.approvals.results[0]?.outcome).toBe('allowed-once')
      expect(snapshot.approvals.results[0]?.id).toBe('ap-2')
    } finally {
      await handle.stop()
    }
  }, 60_000)
})

describe('PB-021 · Electron-as-node 真启动路径（app 里就是这么 spawn 的）', () => {
  it.skipIf(!ELECTRON_AVAILABLE)(
    '用 electron.exe + ELECTRON_RUN_AS_NODE 跑一轮（不需要真内核快照）',
    async () => {
    const handle = await startStubAdapter(
      {
        KYCLAW_STUB_CHUNKS: JSON.stringify([REF_TEXT]),
        KYCLAW_STUB_CHUNK_DELAY_MS: '0'
      },
      ELECTRON
    )
    try {
      const result = await handle.adapter.startTurn('say hi')
      expect(result.text).toBe(REF_TEXT)
    } finally {
      await handle.stop()
    }
  }, 60_000)
})
