// @vitest-environment node
/**
 * B2：内核启动计划 + feature flag。
 * **只断言参数，不 spawn 任何进程**（POC 已验过真启动，B2 不重复起内核）。
 */
import { describe, expect, it } from 'vitest'
import { isKernelPortEnabled, KERNEL_PORT_ENV } from '../feature-flag'
import { DSH_KERNEL_ARGS, planKernelLaunch } from '../kernel-entry'

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

describe('feature flag：默认关（B2 不改现有行为）', () => {
  it('未设 / 非 1 一律 false；只有 KYCLAW_KERNEL_PORT=1 才开', () => {
    expect(isKernelPortEnabled({})).toBe(false)
    expect(isKernelPortEnabled({ [KERNEL_PORT_ENV]: '0' })).toBe(false)
    expect(isKernelPortEnabled({ [KERNEL_PORT_ENV]: 'true' })).toBe(false)
    expect(isKernelPortEnabled({ [KERNEL_PORT_ENV]: '1' })).toBe(true)
  })
})
