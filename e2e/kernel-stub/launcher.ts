/**
 * E2E kernel stub launcher（PB-021）：把 `kernel-stub.cjs` 装成**一次启动专用的内核树**。
 *
 * 为什么要"树"：产品侧 `kernel-layout.ts` 按真实布局解析内核（`current.json` → `<path>/node_modules/@deepseek-ai/dsh/lib/bin.js`），
 * `kernel-process.ts` 再按这个入口 spawn（Electron-as-node）。stub 不绕过这条路径——它就长在真入口的位置上，
 * 所以 e2e 跑的是**产品自己的启动/鉴权/WS/映射全链路**，只是把"内核进程"换成了一个按协议回放的脚本。
 *
 * 注入方式：只写 `KYCLAW_KERNEL_ROOT`（`kernel-layout.ts:defaultKernelRoot` 的覆盖口）+ stub 自己的行为 env；
 * 不改产品代码、不碰 `resources/kernel/**`、不依赖真内核快照。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STUB_KERNEL_VERSION = 'e2e-stub'
export const STUB_KERNEL_ROOT_ENV = 'KYCLAW_KERNEL_ROOT'

export interface StubKernelScript {
  /** assistant 文本分片（默认 = 旧 mock 三段原文，见 mock-reply.ts） */
  chunks?: readonly string[]
  /** 分片间隔 ms（默认 250；chat/sessions 的时序断言依赖它） */
  chunkDelayMs?: number
  /** default | error | hang（默认 default；hang=首段后停住等 cancel） */
  scenario?: 'default' | 'error' | 'hang'
  /** 文本后补一次 tool/call + tool/result（**只发事件，不执行产品工具**） */
  tool?: { name: string; input?: unknown; result?: unknown; isError?: boolean }
}

export interface StubKernelOptions extends StubKernelScript {
  /** 本次启动专用的内核根目录（harness 用 `<userData>/kernel-stub`，随 userData 一起清） */
  rootDir: string
  /** stub 的 JSONL 事件日志（证据：证明这一轮确实走了 stub） */
  logFile?: string
}

export interface StubKernelLaunch {
  kernelRoot: string
  entryPath: string
  env: Record<string, string>
}

/** 在 rootDir 下铺出 `current.json` + `<version>/SNAPSHOT.json` + 入口 bin.js；返回要注入的环境变量 */
export function materializeStubKernel(options: StubKernelOptions): StubKernelLaunch {
  const kernelRoot = options.rootDir
  const versionDir = join(kernelRoot, STUB_KERNEL_VERSION)
  const entryDir = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(entryDir, { recursive: true })

  writeFileSync(
    join(kernelRoot, 'current.json'),
    `${JSON.stringify(
      { version: '0.2.1-e2e-stub', path: STUB_KERNEL_VERSION, sha256: 'e2e-stub-offline' },
      null,
      2
    )}\n`,
    'utf8'
  )
  writeFileSync(join(versionDir, 'SNAPSHOT.json'), '{}\n', 'utf8')
  writeFileSync(
    join(versionDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    `${JSON.stringify(
      { name: '@deepseek-ai/dsh', version: '0.2.1-e2e-stub', private: true },
      null,
      2
    )}\n`,
    'utf8'
  )
  const entryPath = join(entryDir, 'bin.js')
  copyFileSync(join(__dirname, 'kernel-stub.cjs'), entryPath)

  const env: Record<string, string> = { [STUB_KERNEL_ROOT_ENV]: kernelRoot }
  if (options.chunks !== undefined) env.KYCLAW_STUB_CHUNKS = JSON.stringify(options.chunks)
  if (options.chunkDelayMs !== undefined)
    env.KYCLAW_STUB_CHUNK_DELAY_MS = String(options.chunkDelayMs)
  if (options.scenario !== undefined) env.KYCLAW_STUB_SCENARIO = options.scenario
  if (options.tool !== undefined) env.KYCLAW_STUB_TOOL = JSON.stringify(options.tool)
  if (options.logFile !== undefined) env.KYCLAW_STUB_LOG = options.logFile
  return { kernelRoot, entryPath, env }
}
