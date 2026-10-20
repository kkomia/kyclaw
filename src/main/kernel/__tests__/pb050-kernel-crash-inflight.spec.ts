// @vitest-environment node
/**
 * PB-050：内核**运行期崩溃** · **in-flight**（慢速流说到一半）也必须给可诊断详情。
 *
 * 已知证据（`.superpowers/dev-verify/20261020-0.2.1/bao/pb050-evidence.jsonl`）：
 *   - 场景 A（空闲态杀内核）：8/8 文案 =「内核进程已退出（exitCode=1）…日志：<绝对路径>」；
 *   - 场景 B（in-flight 慢速流中杀内核）：4/4 退化成「连接中断：请检查网络或本地服务后重试。」，
 *     原始错误 =「内核路径失败：read ECONNRESET」，卡片拿不到 exitCode / 日志路径。
 *
 * 根因（本 spec 钉住的链路）：内核进程被杀 → mux socket 先报 `read ECONNRESET` →
 * `kernel-adapter` 的 `ws.onClose` 把**连接层错误**直接 settle 给 in-flight 那一轮，
 * 完全不看 `kernelExit`（空闲态能拿详情，是因为下一次 `startTurn` 开头有 PB-043 的
 * `kernelExitMessage` 判断，而流已经在跑时根本走不到那里）。
 *
 * 本 spec 用 e2e 的 kernel stub 起**真 adapter 全链路**（node 进程、离线、无需真内核快照）：
 *   1. 慢速流中途 kill → reject 文案必须是崩溃详情（exitCode/signal + kernel.log 绝对路径 +
 *      「请重启应用」），不能是裸的 read ECONNRESET；
 *   2. 负向控制：内核**没退**的普通错误轮（stub `scenario=error`）→ 错误原样保留，
 *      不得被改写成「内核崩溃」。
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createKernelChatHandler } from '../kernel-chat'
import { kernelLossFailure, startKernelAdapter, type KernelAdapter } from '../kernel-adapter'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const STUB_SOURCE = join(repoRoot, 'e2e', 'kernel-stub', 'kernel-stub.cjs')
const STUB_VERSION = 'e2e-stub'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 与 `e2e/kernel-stub/launcher.ts` 同构的最小内核树（布局：current.json + <version>/node_modules/...） */
function materializeStub(rootDir: string): { versionDir: string; entry: string } {
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
  return { versionDir, entry }
}

interface StubHarness {
  adapter: KernelAdapter
  /** 传给 adapter 的 kernel.log 绝对路径（与 bootstrap 同口径；崩溃文案必须带出它） */
  logFile: string
  /** adapter 上报的运行期退出（bootstrap 据此写 kernel.crashed） */
  exits: Array<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  stop: () => Promise<void>
}

async function startStubHarness(extraEnv: Record<string, string>): Promise<StubHarness> {
  const rootDir = tempDir('kyclaw-pb050-kernel-')
  const { versionDir } = materializeStub(rootDir)
  const dataDir = tempDir('kyclaw-pb050-data-')
  const logFile = join(rootDir, 'logs', 'kernel.log')
  const stubLogFile = join(rootDir, 'stub.jsonl')
  const exits: StubHarness['exits'] = []
  const adapter = await startKernelAdapter({
    electronExecutable: process.execPath,
    asarPath: versionDir,
    appDataDir: dataDir,
    logFile,
    extraEnv: {
      KYCLAW_STUB_LOG: stubLogFile,
      KYCLAW_STUB_CHUNK_DELAY_MS: '0',
      ...extraEnv
    },
    readyTimeoutMs: 20_000,
    turnTimeoutMs: 20_000,
    onKernelExit: (info) => {
      exits.push(info)
    }
  })
  return {
    adapter,
    logFile,
    exits,
    stop: async () => {
      await adapter.stop()
    }
  }
}

function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** kernel-chat 的 SSE 文本 → `data:` 帧（renderer 读到的就是这些） */
function parseSseFrames(text: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((value) => value.startsWith('data:'))
    if (line === undefined) continue
    try {
      frames.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>)
    } catch {
      // 非 JSON 的 data 行忽略（kernel-chat 只写 JSON 帧）
    }
  }
  return frames
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] PB-050 temp cleanup deferred', dir)
    }
  }
})

describe('PB-050 · 连接层错误 × 内核退出事实（归类纯函数 kernelLossFailure）', () => {
  const LOG = 'C:\\Users\\me\\AppData\\Roaming\\kyclaw\\logs\\kernel.log'

  it('内核已退出：即使连接层错误是 read ECONNRESET，也改用崩溃详情（exitCode/日志/重启建议）', () => {
    const failure = kernelLossFailure(
      new Error('read ECONNRESET'),
      { exitCode: 1, signal: null },
      LOG
    )
    expect(failure.message).toContain('内核进程已退出（exitCode=1）')
    expect(failure.message).toContain(LOG)
    expect(failure.message).toContain('请重启应用')
    expect(failure.message).not.toContain('ECONNRESET')
  })

  it('内核没退出：原样返回连接层错误（普通网络错误文案保持原样）', () => {
    const original = new Error('read ECONNRESET')
    expect(kernelLossFailure(original, undefined, LOG)).toBe(original)
  })

  it('signal 退出（exitCode=null）：文案用 signal 名，不写成 exitCode=null', () => {
    const failure = kernelLossFailure(undefined, { exitCode: null, signal: 'SIGKILL' }, LOG)
    expect(failure.message).toContain('signal SIGKILL')
    expect(failure.message).not.toContain('exitCode=null')
  })

  it('内核没退且没有原始错误：兜底 mux closed，不误报内核崩溃', () => {
    const failure = kernelLossFailure(undefined, undefined, LOG)
    expect(failure.message).toBe('kernel adapter: mux socket closed')
    expect(failure.message).not.toContain('内核进程已退出')
  })
})

describe('PB-050 · in-flight 杀内核：错误文案必须是内核崩溃详情', () => {
  it('慢速流中途 kill → reject 文案含 exitCode/signal + kernel.log 绝对路径，不是 read ECONNRESET', async () => {
    const harness = await startStubHarness({
      KYCLAW_STUB_CHUNKS: JSON.stringify(['第一段。', '第二段。', '第三段。']),
      KYCLAW_STUB_CHUNK_DELAY_MS: '400'
    })
    try {
      let sawFirstDelta: (() => void) | undefined
      const firstDelta = new Promise<void>((resolve) => {
        sawFirstDelta = resolve
      })
      const live: string[] = []
      const turn = harness.adapter.startTurn('长回答：说到一半我要杀掉内核', {
        onFrame: (frame) => {
          if (frame.type === 'text-delta') {
            live.push(frame.delta)
            sawFirstDelta?.()
          }
        }
      })
      // 等到第一段正文真正流出来（证明 kill 发生在 in-flight，而不是空闲态）
      await firstDelta
      expect(live.join('')).toContain('第一段。')
      const pid = harness.adapter.pid
      expect(typeof pid).toBe('number')

      process.kill(pid as number, 'SIGKILL')

      const failure = await turn.then(
        () => undefined,
        (cause: unknown) => errorOf(cause)
      )
      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      // 内核崩溃详情：进程已退出 + 退出码/signal + 日志绝对路径 + 重启建议
      expect(message).toContain('内核进程已退出')
      expect(message).toMatch(/exitCode=\d+|signal (SIGKILL|SIGTERM|SIGINT|unknown)/)
      expect(message).toContain(harness.logFile)
      expect(message).toContain('请重启应用')
      // 不能是连接层原文（那会被 renderer 的 ErrorCard 归类成「连接中断」）
      expect(message).not.toContain('ECONNRESET')

      // 运行期退出信息确实上报给了上层（bootstrap 据此写 kernel.crashed，日志里才有事实）
      await vi.waitFor(
        () => {
          expect(harness.exits).toHaveLength(1)
        },
        { timeout: 5_000 }
      )
    } finally {
      await harness.stop()
    }
  }, 60_000)

  it('HTTP /chat 链路：流中途杀内核 → renderer 收到的 SSE error 帧 = 内核崩溃详情', async () => {
    const harness = await startStubHarness({
      KYCLAW_STUB_CHUNKS: JSON.stringify(['第一段。', '第二段。', '第三段。']),
      KYCLAW_STUB_CHUNK_DELAY_MS: '400'
    })
    try {
      const app = new Hono()
      app.post('/chat/kyclaw', createKernelChatHandler(harness.adapter))
      const response = await app.request('/chat/kyclaw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: '长回答：说到一半杀内核' }] }]
        })
      })
      expect(response.status).toBe(200)
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      if (reader === undefined) return
      const decoder = new TextDecoder()
      let body = ''
      let killed = false
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        body += decoder.decode(chunk.value, { stream: true })
        // 等第一段正文真的写进 SSE（in-flight），再杀内核
        if (!killed && body.includes('"type":"text-delta"')) {
          killed = true
          process.kill(harness.adapter.pid as number, 'SIGKILL')
        }
      }
      const frames = parseSseFrames(body)
      const errorFrame = frames.filter((frame) => frame.type === 'error').at(-1)
      expect(errorFrame).toBeDefined()
      const errorText = String(errorFrame?.errorText ?? '')
      // renderer 的 ErrorCard 收到的就是 errorText；必须是崩溃详情
      expect(errorText).toContain('内核进程已退出')
      expect(errorText).toContain(harness.logFile)
      expect(errorText).toContain('请重启应用')
      expect(errorText).not.toContain('ECONNRESET')
      // 已交付文本帧仍在（流没被错误帧整体吃掉）
      const text = frames
        .flatMap((frame) =>
          frame.type === 'text-delta' && typeof frame.delta === 'string' ? [frame.delta] : []
        )
        .join('')
      expect(text).toContain('第一段。')
    } finally {
      await harness.stop()
    }
  }, 60_000)

  it('负向控制：内核没退的普通错误轮 → 错误原样保留，不被改写成「内核崩溃」', async () => {
    const harness = await startStubHarness({
      KYCLAW_STUB_SCENARIO: 'error',
      KYCLAW_STUB_CHUNKS: JSON.stringify(['先交付这句。']),
      KYCLAW_STUB_ERROR: JSON.stringify({ code: 'TRANSPORT', message: 'stub 脚本化错误' })
    })
    try {
      const result = await harness.adapter.startTurn('出个错')
      // 内核还活着：普通错误（含连接类 code 也一样）不允许被内核崩溃文案覆盖
      expect(result.error?.code).toBe('TRANSPORT')
      expect(result.error?.message).toBe('stub 脚本化错误')
      expect(harness.exits).toHaveLength(0)
    } finally {
      await harness.stop()
    }
  }, 60_000)
})
