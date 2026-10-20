// @vitest-environment node
/**
 * PB-051 真内核聚焦集成（默认 skip，`KYCLAW_KERNEL_E2E=1` 才跑）：**每次启动不再新增空会话**。
 *
 * 现场口径（与 PB-051 证据同口径）：数 `dsh-home/sessions/<project>/<session>/session.v4.jsonl.zstd`
 * 的文件数（外加 `storages/session_projcache/sessions/*.json`）。
 *
 * 红→绿：
 *   - 旧实现（adapter 启动 `createSession()` 不带 id）→ 第 2 次启动现场 **+1** 个空会话（红）；
 *   - 现实现（稳定 id + list-first）→ 第 2 次启动 0 增（绿）。
 *
 * 顺带不回归：
 *   - `listCommands()`（无 threadId = renderer 启动时拉的 `/api/kernel/catalog`）仍是读路径，不建会话；
 *   - 默认会话在内核里仍 `blank=true`（PB-030 过滤依据），PB-024 的 defaultSessionId 过滤仍把它挡在
 *     `/api/threads` 外；用户自己建的空会话也仍被 blank 过滤挡住。
 *
 * 开启（PowerShell，隔离 profile，不碰真实 %APPDATA%）：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   & "$env:APPDATA\npm\pnpm.cmd" --config.verify-deps-before-run=false exec vitest run `
 *     src/main/kernel/__tests__/pb051-no-new-blank-session.integration.spec.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKernelSessionOpsForAdapter } from '../kernel-session-ops'
import { maybeStartKernelAdapter } from '../kernel-bootstrap'
import type { KernelAdapter } from '../kernel-adapter'
import { createKernelThreadsRouter } from '../../threads/kernel-threads'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'

/** 默认内核可执行文件：仓库内 electron 优先（开发机），否则沿用既有 spec 的本机 DSH 路径 */
function defaultElectron(): string {
  const fromEnv = process.env.KYCLAW_KERNEL_ELECTRON
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  const repoElectron = resolve('node_modules/electron/dist/electron.exe')
  return existsSync(repoElectron) ? repoElectron : 'F:\\deepseekharness\\DeepSeek Harness.exe'
}

const ELECTRON = defaultElectron()
/** 仓库内核快照（rc.2）；集成测试注入用 */
const KERNEL_DIR = process.env.KYCLAW_KERNEL_ASAR ?? resolve('resources/kernel/rc.2')

function listFiles(root: string): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true }) as import('node:fs').Dirent[]
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out.sort()
}

/** PB-051 现场目录：`sessions/` 下所有 session 持久文件 + `session_projcache` 条目数 */
function siteOf(dshHome: string): { sessionFiles: string[]; projcacheFiles: number } {
  const sessionFiles = listFiles(join(dshHome, 'sessions')).filter((path) =>
    path.endsWith('session.v4.jsonl.zstd')
  )
  const projcacheFiles = listFiles(join(dshHome, 'storages', 'session_projcache')).filter((path) =>
    path.endsWith('.json')
  ).length
  return { sessionFiles, projcacheFiles }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * 等落盘稳定（内核 persistence 是异步 flush：`session/create` 之后 ~1s 文件才出现），
 * 连续两次采样一致才算稳定；最多 12s。返回稳定后的现场口径。
 */
async function settledSite(
  dshHome: string
): Promise<{ sessionFiles: string[]; projcacheFiles: number }> {
  let last = siteOf(dshHome)
  for (let attempt = 0; attempt < 48; attempt += 1) {
    await sleep(250)
    const next = siteOf(dshHome)
    if (
      next.sessionFiles.length === last.sessionFiles.length &&
      next.projcacheFiles === last.projcacheFiles &&
      next.sessionFiles.join('|') === last.sessionFiles.join('|')
    ) {
      return next
    }
    last = next
  }
  return last
}

describe.runIf(ENABLED)('PB-051 每次启动不再新增空会话（真内核）', () => {
  it(
    '两次启动现场文件数不增；catalog/blank/default 过滤行为不回退',
    { timeout: 300_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kyclaw-pb051-it-'))
      const dshHome = join(root, 'dsh-home')
      const workspace = join(root, 'workspace')
      const appData = join(root, 'appdata')
      mkdirSync(workspace, { recursive: true })
      mkdirSync(appData, { recursive: true })
      let first: KernelAdapter | undefined
      let second: KernelAdapter | undefined
      const boot = async (): Promise<KernelAdapter> =>
        maybeStartKernelAdapter({
          electronExecutable: ELECTRON,
          asarPath: KERNEL_DIR,
          appDataDir: appData,
          dshHome,
          resolveCwd: () => workspace,
          readyTimeoutMs: 60_000,
          turnTimeoutMs: 60_000
        })
      try {
        // ================= 启动 1（新 profile） =================
        first = await boot()
        const defaultId = first.defaultSessionId
        const afterBoot1 = await settledSite(dshHome)
        // 新 profile 只有这 1 个隐藏默认会话（旧实现同名断言也过，区别在第 2 次启动）
        expect(afterBoot1.sessionFiles).toHaveLength(1)
        expect(afterBoot1.projcacheFiles).toBe(1)
        console.warn(
          `[PB-051] boot1: sessions=${String(afterBoot1.sessionFiles.length)} projcache=${String(afterBoot1.projcacheFiles)}`
        )

        // renderer 启动即拉 `/api/kernel/catalog` → adapter.listCommands()（无 threadId）：
        // 命令目录必须可用，且这是读路径——不能因此新增会话
        const catalog = await first.listCommands()
        expect(catalog.length).toBeGreaterThan(0)
        const afterCatalog1 = await settledSite(dshHome)
        expect(afterCatalog1.sessionFiles).toHaveLength(afterBoot1.sessionFiles.length)
        expect(afterCatalog1.projcacheFiles).toBe(afterBoot1.projcacheFiles)

        await first.stop()
        first = undefined
        await sleep(400)

        // ================= 启动 2（同一 dshHome = 重启） =================
        second = await boot()
        const afterBoot2 = await settledSite(dshHome)
        // ★ PB-051 红→绿断言：旧实现这里 2 个文件（每次启动 +1）；新实现 0 增
        expect(afterBoot2.sessionFiles).toHaveLength(afterBoot1.sessionFiles.length)
        expect(afterBoot2.projcacheFiles).toBe(afterCatalog1.projcacheFiles)
        console.warn(
          `[PB-051] boot2(restart): sessions=${String(afterBoot2.sessionFiles.length)} projcache=${String(afterBoot2.projcacheFiles)} (boot1 was sessions=${String(afterCatalog1.sessionFiles.length)} projcache=${String(afterCatalog1.projcacheFiles)})`
        )
        // 默认会话是「每个 cwd 一个稳定 id」且跨重启不变，不是每次启动 mint 的 `session-<uuid>`
        expect(second.defaultSessionId).toBe(defaultId)
        expect(defaultId).toMatch(/^kyclaw-default-[0-9a-f]{16}$/u)

        // 默认会话在内核里仍是 blank（PB-030 的过滤依据，不能变成"看起来像用户会话"）
        const listed = await second.listKernelSessions()
        const defaultInKernel = listed.find((item) => item.sessionId === defaultId)
        expect(defaultInKernel?.blank).toBe(true)

        // 第 2 次启动的 catalog 仍零新增
        await second.listCommands()
        const afterCatalog2 = await settledSite(dshHome)
        expect(afterCatalog2.sessionFiles).toHaveLength(afterBoot2.sessionFiles.length)
        expect(afterCatalog2.projcacheFiles).toBe(afterBoot2.projcacheFiles)

        // ================= 过滤不回退 =================
        // 用户自己建的一个"空会话"（显式 id，非默认）：落盘 +1 是用户行为，但 blank 过滤不许进侧栏
        await second.rpcCall('session/create', {
          request: { cwd: workspace, sessionId: 'pb051-user-blank' }
        })
        const afterUserBlank = await settledSite(dshHome)
        expect(afterUserBlank.sessionFiles.length).toBe(afterCatalog2.sessionFiles.length + 1)

        const ops = createKernelSessionOpsForAdapter(second)
        const threads = createKernelThreadsRouter({
          ops,
          defaultCwd: workspace,
          defaultSessionId: second.defaultSessionId
        })
        const listedThreads = await threads.request('/')
        expect(listedThreads.status).toBe(200)
        const ids = (
          (await listedThreads.json()) as { threads: Array<{ id: string }> }
        ).threads.map((thread) => thread.id)
        // PB-024：adapter 的默认会话不是用户 thread
        expect(ids).not.toContain(second.defaultSessionId)
        // PB-030：blank（没发过消息）的内核会话不进侧栏
        expect(ids).not.toContain('pb051-user-blank')

        // ================= 启动 3：现场已有其它会话时，重启仍然 0 新增 =================
        await second.stop()
        second = undefined
        await sleep(400)
        const third = await boot()
        try {
          expect(third.defaultSessionId).toBe(defaultId)
          const afterBoot3 = await settledSite(dshHome)
          // 已有 2 个会话（默认 + 用户 blank）的现场，重启后文件数不变
          expect(afterBoot3.sessionFiles).toHaveLength(afterUserBlank.sessionFiles.length)
          expect(afterBoot3.projcacheFiles).toBe(afterUserBlank.projcacheFiles)
          console.warn(
            `[PB-051] boot3(restart with 2 sessions): sessions=${String(afterBoot3.sessionFiles.length)} projcache=${String(afterBoot3.projcacheFiles)} (+0)`
          )
        } finally {
          await third.stop().catch(() => undefined)
        }
      } finally {
        await first?.stop().catch(() => undefined)
        await second?.stop().catch(() => undefined)
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        } catch {
          console.warn('[kyclaw] PB-051 integration cleanup deferred', root)
        }
      }
    }
  )
})
