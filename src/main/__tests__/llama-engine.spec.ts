// @vitest-environment node
/**
 * 模块 3B：本机嵌入引擎（子进程）的生命周期测试 —— 用**假二进制**（fixtures/llama-server-stub.mjs）
 * 起真进程，打四件事：spawn / 健康检查 / 空闲 kill / 崩溃自动重拉一次。
 *
 * 为什么用真进程而不是 mock：这几条正是"进程管理"唯一值得测的东西（起得来、等得到、杀得掉、
 * 崩了能自救），mock 掉 spawn 就等于什么都没测。假二进制那侧照抄了 pinned llama.cpp 的接口形状
 * （`/health` 的 200/503、`/v1/embeddings` 的 OpenAI 兼容回包、`--api-key` 的鉴权）。
 *
 * Windows 上不能直接 spawn 一个 `.mjs`，所以引擎给了 `extraArgs`（只给测试用的脚手架）：
 * `node <stub.mjs> -m ...` 就是"二进制 + 参数"的形状。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLlamaEngine, IDLE_DETAIL, type LlamaEngine } from '../llama/engine'

const STUB = resolve(__dirname, '../../../fixtures/llama-server-stub.mjs')

interface Harness {
  engine: LlamaEngine
  dir: string
  modelPath: string
  logFile: string
  lines: () => string[]
  cleanup: () => Promise<void>
}

const live: Harness[] = []

function harness(options: {
  idleMs?: () => number
  idlePollMs?: number
  startupTimeoutMs?: number
  env?: Record<string, string>
  modelPath?: string
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-engine-'))
  const modelPath = options.modelPath ?? join(dir, 'model.gguf')
  const logFile = join(dir, 'requests.log')
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value
  process.env.STUB_LOG_FILE = logFile
  const engine = createLlamaEngine({
    binaryPath: process.execPath,
    extraArgs: [STUB],
    modelPath,
    modelId: 'stub-model',
    apiKey: 'stub-key',
    startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.idlePollMs === undefined ? {} : { idlePollMs: options.idlePollMs }),
    log: () => undefined
  })
  const created: Harness = {
    engine,
    dir,
    modelPath,
    logFile,
    lines: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []),
    cleanup: async () => {
      await engine.dispose()
      for (const key of Object.keys(options.env ?? {})) delete process.env[key]
      delete process.env.STUB_LOG_FILE
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
  live.push(created)
  return created
}

/** 直接问引擎的嵌入端点（不经过网关；网关另有测试） */
async function embed(engine: LlamaEngine, text: string): Promise<number[]> {
  const ended = engine.begin()
  try {
    const { port } = await engine.ensureStarted()
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer stub-key' },
      body: JSON.stringify({ model: 'stub', input: [text] })
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ embedding: number[] }> }
    return body.data[0]?.embedding ?? []
  } finally {
    ended()
  }
}

/** 记下"这个端口上还有没有我们的假引擎在监听"（kill 之后必须没了） */
function portAlive(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = spawn(process.execPath, [
      '-e',
      `require('net').connect({port:${port},host:'127.0.0.1'}).on('connect',()=>{console.log('yes');process.exit(0)}).on('error',()=>{console.log('no');process.exit(0)})`
    ])
    let out = ''
    probe.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    probe.on('exit', () => resolveProbe(out.includes('yes')))
  })
}

afterEach(async () => {
  while (live.length > 0) await live.pop()?.cleanup()
})

describe('本机嵌入引擎：起停与健康检查', () => {
  it('按需 spawn：第一次 ensureStarted 才起进程，监听之后才回；状态是 running', async () => {
    const h = harness({})
    expect(h.engine.status().phase).toBe('stopped')

    const vector = await embed(h.engine, '你好')
    expect(vector).toHaveLength(8)
    expect(h.engine.status()).toMatchObject({ phase: 'running', modelId: 'stub-model' })
    expect(h.lines().some((line) => line.startsWith('embed'))).toBe(true)
  }, 30_000)

  it('模型还在加载（/health 回 503）时等它就绪，不把加载期当失败', async () => {
    const h = harness({ env: { STUB_HEALTH_DELAY_MS: '700' } })
    const started = Date.now()
    const vector = await embed(h.engine, '等待就绪')
    expect(vector).toHaveLength(8)
    expect(Date.now() - started).toBeGreaterThanOrEqual(600)
  }, 30_000)

  it('引擎文件不存在：ensureStarted 抛人话（不挂半截进程）', async () => {
    const engine = createLlamaEngine({
      binaryPath: join(tmpdir(), 'kyclaw-根本没有这个文件.exe'),
      modelPath: join(tmpdir(), 'm.gguf'),
      modelId: 'x',
      apiKey: 'k',
      startupTimeoutMs: 5_000,
      log: () => undefined
    })
    live.push({
      engine,
      dir: tmpdir(),
      modelPath: '',
      logFile: '',
      lines: () => [],
      cleanup: async () => engine.dispose()
    })
    await expect(engine.ensureStarted()).rejects.toThrow()
    expect(['error', 'stopped']).toContain(engine.status().phase)
  }, 30_000)
})

describe('本机嵌入引擎：空闲回收', () => {
  it('超过 idleMs 没有请求就杀掉进程（端口没了），下次请求自动重新起来', async () => {
    const h = harness({ idleMs: () => 400, idlePollMs: 100 })
    await embed(h.engine, '第一条')
    const port = (await h.engine.ensureStarted()).port
    expect(await portAlive(port)).toBe(true)

    // 等空闲回收（idleMs 400ms + 轮询 100ms，给足余量）
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))
    expect(h.engine.status()).toMatchObject({ phase: 'stopped', detail: IDLE_DETAIL })
    expect(await portAlive(port)).toBe(false)

    // 下一次请求把它拉回来（可能换端口；对 embedder 是透明的，同网关那一层）
    const vector = await embed(h.engine, '第二条')
    expect(vector).toHaveLength(8)
    expect(h.engine.status().phase).toBe('running')
    expect(h.lines().filter((line) => line.startsWith('listening')).length).toBe(2)
  }, 30_000)

  it('idleMs = 0 表示不回收（进程一直活着）', async () => {
    const h = harness({ idleMs: () => 0, idlePollMs: 100 })
    const port = (await h.engine.ensureStarted()).port
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(h.engine.status().phase).toBe('running')
    expect(await portAlive(port)).toBe(true)
  }, 30_000)
})

describe('本机嵌入引擎：崩溃与自救', () => {
  it('第一次启动就崩：自动重拉一次并恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-engine-crash-'))
    const marker = join(dir, 'crashed-once')
    const h = harness({
      modelPath: join(dir, 'model.gguf'),
      env: { STUB_CRASH_ONCE: marker }
    })
    try {
      // 起进程 → 假引擎第一次直接退出 → 引擎记 error + 按额度重拉
      const vector = await embed(h.engine, '崩了也要活')
      expect(vector).toHaveLength(8)
      expect(existsSync(marker)).toBe(true)
      expect(h.engine.status().phase).toBe('running')
    } finally {
      await h.cleanup()
      live.pop()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 30_000)

  it('起不来时状态带着原因（人话里能看出是引擎那边的问题）', async () => {
    const h = harness({ startupTimeoutMs: 300 })
    // 让健康检查永远不通过：STUB_HEALTH_DELAY_MS 比 startupTimeout 长
    process.env.STUB_HEALTH_DELAY_MS = '5000'
    try {
      await expect(h.engine.ensureStarted()).rejects.toThrow(/没有就绪/)
      expect(h.engine.status().phase).toBe('error')
      expect(h.engine.status().detail).toContain('没有就绪')
    } finally {
      delete process.env.STUB_HEALTH_DELAY_MS
    }
  }, 30_000)
})
