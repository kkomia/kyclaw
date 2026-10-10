import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * CSP 护栏：Electron 的 preload 跑在渲染端 CSP（`script-src 'self'`，没有 'unsafe-eval'）下。
 *
 * T5 实机踩到的坑：zod 4 在首次 parse 时动态生成校验函数（`Doc.compile` → `new Function`），
 * 在那个 realm 里抛 `EvalError: Code generation from strings disallowed for this context`，
 * 于是 preload 的结构校验静默失效——`settings:get` 回退默认值、重启后外观回到默认。
 *
 * 那个时序精确定位很难（能力探测过了、真正生成校验函数被拦），所以这里按实测形态模拟：
 * **短代码生成放行、长代码被拦**。护栏要求 shared 的 schema 把 jitless 关在构造之前（shared/zod.ts）。
 */
const RealFunction = globalThis.Function

function stubDynamicCodeGeneration(policy: (body: string) => boolean): void {
  const guard = (args: unknown[]): void => {
    const body = String(args[args.length - 1] ?? '')
    if (policy(body)) {
      throw new EvalError('Code generation from strings disallowed for this context')
    }
  }

  globalThis.Function = new Proxy(RealFunction, {
    apply: (target, thisArg, args: unknown[]) => {
      guard(args)
      return Reflect.apply(target, thisArg, args)
    },
    construct: (target, args: unknown[]) => {
      guard(args)
      return Reflect.construct(target, args)
    }
  }) as unknown as FunctionConstructor
}

afterEach(() => {
  globalThis.Function = RealFunction
  vi.resetModules()
})

describe('CSP 护栏：shared schema 解析不进 JIT', () => {
  it('生成代码被拦时，settings 与 ipc 的 schema 仍能正常解析与拒绝', async () => {
    stubDynamicCodeGeneration((body) => body.length > 32)
    vi.resetModules()

    const { appSettingsSchema, appSettingsPatchSchema, DEFAULT_SETTINGS } =
      await import('../settings')
    const { windowStateSchema } = await import('../ipc')

    expect(appSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'blue' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: true }).success).toBe(true)
    expect(windowStateSchema.safeParse({ maximized: 'yes' }).success).toBe(false)
  })
})
