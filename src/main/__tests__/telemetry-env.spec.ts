// @vitest-environment node
/**
 * R18：本地优先姿态 —— Mastra 遥测（PostHog 打点）必须在应用启动时先关掉。
 *
 * 为什么是源码级断言：`src/main/index.ts` 依赖 electron（app/whenReady/单实例锁），
 * 在 vitest 里 import 不进来（会直接炸），所以这里守两件事：
 *   1. 赋值语句存在且是 `MASTRA_TELEMETRY_DISABLED = 'true'`；
 *   2. 它出现在 `startAgentServer(...)`（真正动态 import mastra 的地方）之前。
 * 真实产物里的顺序另有实机核对（构建产物 + dev 冒烟）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('MASTRA_TELEMETRY_DISABLED（R18）', () => {
  it('在加载 mastra 之前显式关掉遥测', () => {
    const assignment = source.indexOf("process.env.MASTRA_TELEMETRY_DISABLED = 'true'")
    const loadsMastra = source.indexOf('startAgentServer(')

    expect(assignment).toBeGreaterThan(-1)
    expect(loadsMastra).toBeGreaterThan(-1)
    expect(assignment).toBeLessThan(loadsMastra)
  })
})
