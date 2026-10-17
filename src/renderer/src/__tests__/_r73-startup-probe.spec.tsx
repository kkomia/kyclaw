import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STARTUP_FINAL_MARK } from '@renderer/lib/startup-timing'
import { clearKyclawBridge, installKyclawBridge } from './kyclaw-bridge'

/**
 * round 73 探针：**冷启动到"可输入"**这条链的分解（渲染端一侧）。
 *
 * 这是测量工具，不是回归用例。跑法：
 *
 *   node_modules/.bin/vitest run src/renderer/src/__tests__/_r73-startup-probe.spec.tsx
 *
 * ## 它量的是什么（以及量不到什么）
 *
 * 口径要求不起桌面客户端，所以这里把**真入口**（`@renderer/main` → App → 壳 → 对话页 → 输入卡）
 * 挂在一份假桥上跑，读的是线上同一份打点（`lib/startup-timing.ts`）。量得到：
 *   - 渲染端这条链的**顺序与串行关系**（谁是前置、谁在等谁）—— 这是"找阻塞项"的依据；
 *   - 渲染端 JS 自身开销的量级（首屏提交 / 外壳挂载 / 输入卡挂载之间那几笔）；
 *   - "端点就绪 / 会话列表 / 历史回灌"这些**等待**在链上的位置与叠加方式。
 * 量不到（必须在真机上取，见主进程 index.ts 与渲染端各处的打点行）：
 *   - Electron 自身启动、窗口创建/可见、渲染端 bundle 解析——jsdom 里没有这些；
 *   - 真 IPC / 真 HTTP 的往返耗时——这里用注入的延迟代替（这正是"各占多少"里最大的两块）。
 */

const DELAY = vi.hoisted(() => ({ endpointMs: 0, threadsMs: 0, historyMs: 0 }))
/** 端点就绪那一刻（performance.now()）——线程 API 的每一次调用都要先拿到它（见下） */
const READY = vi.hoisted(() => ({ endpointReadyAt: 0 }))

/**
 * 等端点就绪。**这一步是保真的关键**：真机上 `fetchThreads` / `fetchThreadMessages` 都先走
 * `window.kyclaw.agent.endpoint()`（threads-api 的 authorized）再发 HTTP —— 服务没起来时那一下
 * 直接抛。所以这两次取数不是"与端点并行"，而是**排在端点之后**的串行等待。
 */
async function waitEndpoint(): Promise<void> {
  const remaining = READY.endpointReadyAt - performance.now()
  if (remaining > 0) await sleep(remaining)
}

vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => {
    await waitEndpoint()
    await sleep(DELAY.threadsMs)
    return []
  }),
  fetchThreadMessages: vi.fn(async () => {
    await waitEndpoint()
    await sleep(DELAY.historyMs)
    return []
  }),
  createThread: vi.fn(async (id: string) => ({ id, title: null, updatedAt: '' })),
  renameThread: vi.fn(async () => {}),
  deleteThread: vi.fn(async () => {}),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

interface BootResult {
  marks: Array<{ name: string; at: number }>
  /** 每一笔相对上一笔的增量 */
  steps: Array<{ name: string; delta: number; total: number }>
}

/** 起一次"冷启动"：真入口 + 假桥（端点/列表/历史各自可注入延迟） */
async function boot(latencies: {
  endpointMs: number
  threadsMs: number
  historyMs: number
}): Promise<BootResult> {
  DELAY.endpointMs = latencies.endpointMs
  DELAY.threadsMs = latencies.threadsMs
  DELAY.historyMs = latencies.historyMs

  READY.endpointReadyAt = 0
  document.body.innerHTML = '<div id="root"></div>'
  installKyclawBridge()
  // 端点这一口挂上延迟：真机里它等的是"内嵌 Mastra 服务起来"（libsql + 路由 + 监听）。
  // 第一次问就是"服务就绪"那一刻，后面的调用都等同一个时刻（模拟一次性就绪）。
  const api = window.kyclaw as unknown as { agent: { endpoint: () => Promise<unknown> } }
  api.agent.endpoint = async () => {
    if (READY.endpointReadyAt === 0) {
      READY.endpointReadyAt = performance.now() + latencies.endpointMs
    }
    await waitEndpoint()
    return { baseUrl: 'http://127.0.0.1:1', token: 'probe-token' }
  }

  // 真入口重新执行一次（模块级状态随之重置，等价于"又一次冷启动"）。
  // 打点模块要在 resetModules **之后**重新 import：否则读的是上一个模块实例的那份 marks。
  vi.resetModules()
  const timing = await import('@renderer/lib/startup-timing')
  timing.resetStartupMarks()
  await import('@renderer/main')

  await waitFor(
    () => {
      expect(document.querySelector('[data-testid="composer-input"]')).not.toBeNull()
    },
    { timeout: 10_000 }
  )
  /**
   * round 76：**输入卡不再排在链尾** —— 它随外壳一起出来（可输入 < 服务端点就绪），所以"等到
   * 输入卡"不再等于"链跑完了"。这里再等链尾那几笔（端点 → 会话列表 → 历史回灌）落定，
   * 否则取到的 marks 只有前半截（下面那张表要看的正是整条链的分段）。
   */
  await waitFor(
    () => {
      expect(timing.startupMarks().some((mark) => mark.name === '历史回灌')).toBe(true)
    },
    { timeout: 10_000 }
  )

  const marks = timing.startupMarks()
  return {
    marks,
    steps: marks.map((mark, index) => {
      const previous = marks[index - 1]?.at ?? 0
      return { name: mark.name, delta: mark.at - previous, total: mark.at }
    })
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function scenarioRow(
  name: string,
  latencies: { endpointMs: number; threadsMs: number; historyMs: number },
  result: BootResult
): Record<string, string | number> {
  const at = (markName: string): number =>
    result.marks.find((mark) => mark.name === markName)?.at ?? 0
  return {
    场景: name,
    '注入·端点': `${latencies.endpointMs}ms`,
    '注入·会话列表': `${latencies.threadsMs}ms`,
    '注入·历史': `${latencies.historyMs}ms`,
    首屏已提交: round(at('首屏已提交')),
    外壳挂载: round(at('外壳挂载')),
    服务端点就绪: round(at('服务端点就绪')),
    会话列表就绪: round(at('会话列表就绪')),
    历史回灌: round(at('历史回灌')),
    可输入: round(at(STARTUP_FINAL_MARK)),
    // 链上"最后一段"的成本：历史回灌 → 输入卡挂上 DOM
    '末段(历史→可输入)': round(at(STARTUP_FINAL_MARK) - at('历史回灌'))
  }
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.style.removeProperty('--ui-scale')
})

afterEach(() => {
  clearKyclawBridge()
})

describe('探针：冷启动到可输入的分解（round 73）', () => {
  it('全部瞬时：渲染端这条链自身要多久（不含任何等待）', async () => {
    const latencies = { endpointMs: 0, threadsMs: 0, historyMs: 0 }
    const result = await boot(latencies)

    // 链的顺序被钉住：外壳 → 可输入（round 76：输入卡先出来，不再等端点/列表/历史）
    // → 端点 → 会话列表 → 历史回灌
    const names = result.marks.map((mark) => mark.name)
    expect(names).toContain('首屏已提交')
    expect(names).toContain('外壳挂载')
    expect(names).toContain(STARTUP_FINAL_MARK)
    expect(names.indexOf('外壳挂载')).toBeLessThan(names.indexOf('服务端点就绪'))
    expect(names.indexOf(STARTUP_FINAL_MARK)).toBeLessThan(names.indexOf('服务端点就绪'))
    expect(names.indexOf('历史回灌')).toBeGreaterThan(names.indexOf(STARTUP_FINAL_MARK))
    for (let index = 1; index < result.marks.length; index += 1) {
      expect((result.marks[index]?.at ?? 0) >= (result.marks[index - 1]?.at ?? 0)).toBe(true)
    }

    console.log('[r73-startup] 冷启动链（渲染端，jsdom，无等待）')
    console.table([scenarioRow('全部瞬时', latencies, result)])
    console.table(
      result.steps.map((step) => ({
        打点: step.name,
        距上一笔: round(step.delta),
        自导航开始: round(step.total)
      }))
    )
  })

  it('真机形状：端点等 800ms（= 等服务起来）、列表 40ms、历史 30ms', async () => {
    const latencies = { endpointMs: 800, threadsMs: 40, historyMs: 30 }
    const result = await boot(latencies)

    console.log('[r73-startup] 冷启动链（渲染端，jsdom，注入真机形状的等待）')
    console.table([scenarioRow('真机形状', latencies, result)])

    const at = (name: string): number => result.marks.find((mark) => mark.name === name)?.at ?? 0
    const shellAt = at('外壳挂载')
    const endpointAt = at('服务端点就绪')
    const historyAt = at('历史回灌')
    const finalAt = at(STARTUP_FINAL_MARK)

    // 端点的 800ms 真等到了（按"外壳挂载 → 端点就绪"这一段算，别拿绝对时刻比）
    expect(endpointAt - shellAt).toBeGreaterThanOrEqual(790)
    // round 76（本轮要的观感）：**输入卡不再排在端点后面** —— 它跟外壳一起出来，
    // 端点/列表/历史那三段在它之后照旧串行（链没变短，只是不再挡着"能输入"）
    expect(finalAt).toBeLessThan(endpointAt)
    expect(historyAt).toBeGreaterThanOrEqual(endpointAt)
  }, 30_000)
})
