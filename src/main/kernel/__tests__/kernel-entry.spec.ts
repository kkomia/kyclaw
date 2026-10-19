// @vitest-environment node
/**
 * B2：内核启动计划 + feature flag。
 * **只断言参数，不 spawn 任何进程**（POC 已验过真启动，B2 不重复起内核）。
 *
 * B4 / PB-006：双布局（旧 asar / 新内核树）**只看实际存在**——existence 由调用方注入，
 * 这里用假 exists 钉选择顺序与"都找不到时"的可诊断错误。
 */
import { describe, expect, it } from 'vitest'
import {
  DSH_KERNEL_ARGS,
  chooseKernelScript,
  planKernelLaunch,
  type KernelScriptCandidates
} from '../kernel-entry'
import { KernelStartupError } from '../kernel-startup'

describe('kernel-entry：启动计划（B1.5 实测口径）', () => {
  it('入口 = asar 内 dsh/lib/bin.js web；Electron-as-node + 隔离 DSH_HOME', () => {
    const plan = planKernelLaunch({
      electronExecutable: 'F:\\deepseekharness\\DeepSeek Harness.exe',
      asarPath: 'F:\\deepseekharness\\resources\\app.asar',
      dshHome: 'C:\\lmstudio-temp\\dsh-poc\\home'
    })
    expect(plan.scriptPath).toBe(
      'F:\\deepseekharness\\resources\\app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
    expect(plan.executable).toContain('DeepSeek Harness.exe')
    expect(plan.args).toEqual(['--expose-internals', plan.scriptPath, ...DSH_KERNEL_ARGS])
    expect(plan.args.slice(2)).toEqual(['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
    expect(plan.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: 'C:\\lmstudio-temp\\dsh-poc\\home'
    })
  })

  it('extraEnv 可覆盖（例如测试用 DEEPSEEK_BASE_URL），但不改核心参数', () => {
    const plan = planKernelLaunch({
      electronExecutable: 'electron.exe',
      asarPath: 'app.asar',
      dshHome: 'D:\\tmp\\home',
      extraEnv: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234' }
    })
    expect(plan.env.DEEPSEEK_BASE_URL).toBe('http://127.0.0.1:1234')
    expect(plan.args).toContain('web')
  })
})

describe('B4：双布局按实际存在选入口（不靠版本号/flag 猜）', () => {
  const asarPath = 'C:\\app\\resources\\app.asar'
  const kernelRoot = 'C:\\app\\resources\\kernel\\rc.2'

  it('旧 asar 布局存在 → 用 asar 内入口（开发/集成测试行为不变）', () => {
    const choice = chooseKernelScript({
      asarPath,
      exists: (path) => path === `${asarPath}/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
    })
    expect(choice.kind).toBe('asar-layout')
    expect(choice.scriptPath).toContain('/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  })

  it('只有内核树入口存在 → 用内核树（打包态）', () => {
    const choice = chooseKernelScript({
      asarPath: 'C:\\app\\resources\\kernel\\rc.2',
      exists: (path) =>
        path === 'C:\\app\\resources\\kernel\\rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
    })
    expect(choice.kind).toBe('kernel-tree')
    expect(choice.scriptPath).toBe(
      'C:\\app\\resources\\kernel\\rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
  })

  it('显式给 kernelRoot 时优先内核树（即使旧 asar 也在）', () => {
    const choice = chooseKernelScript({
      asarPath,
      kernelRoot,
      exists: () => true
    })
    expect(choice.kind).toBe('kernel-tree')
    expect(choice.scriptPath.startsWith(kernelRoot)).toBe(true)
  })

  it('`.asar` 根在 plain Node 下 existsSync=false 时仍按 asar 布局放行（回归：不能误判缺件）', () => {
    const choice = chooseKernelScript({
      asarPath: 'F:\\deepseekharness\\resources\\app.asar',
      // 真实 plain Node 看不见 asar 内部：这里显式模拟"什么都探测不到"
      exists: () => false
    })
    expect(choice.kind).toBe('asar-layout')
    expect(choice.scriptPath).toBe(
      'F:\\deepseekharness\\resources\\app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
  })

  it('两个候选都不存在（非 .asar 根）→ KERNEL_ENTRY_MISSING，消息列出两个候选与各自是否存在', () => {
    let failure: unknown
    try {
      chooseKernelScript({
        asarPath: 'C:\\app\\resources\\kernel\\does-not-exist',
        exists: () => false
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(KernelStartupError)
    const error = failure as KernelStartupError
    expect(error.code).toBe('KERNEL_ENTRY_MISSING')
    expect(error.message).toContain('候选 1（旧 asar 布局）')
    expect(error.message).toContain('候选 2（内核树布局）')
    expect(error.message).toContain('不存在')
  })

  it('planKernelLaunch 支持显式 scriptPath（调用方已解析）', () => {
    const plan = planKernelLaunch({
      electronExecutable: 'electron.exe',
      asarPath: 'C:\\app\\resources\\app.asar',
      scriptPath: 'C:\\app\\resources\\kernel\\rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      dshHome: 'D:\\home'
    })
    expect(plan.args[1]).toBe(
      'C:\\app\\resources\\kernel\\rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
    )
  })

  it('候选路径的形状（旧布局 dsh/…；新布局 node_modules/…）', () => {
    const candidates: KernelScriptCandidates = chooseKernelScript({
      asarPath: 'C:\\x\\app.asar',
      exists: (path) => path === 'C:\\x\\app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    }).candidates
    expect(candidates.asarLayout.endsWith('/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(
      true
    )
    expect(candidates.kernelTree.endsWith('/node_modules/@deepseek-ai/dsh/lib/bin.js')).toBe(true)
  })
})
