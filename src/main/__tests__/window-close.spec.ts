// @vitest-environment node
/**
 * 关闭主窗口的策略（0.1.3 托盘驻留）：判定矩阵（三档偏好 ask/tray/quit）+ 弹窗结果（选择 + 记住）
 * + 真退出放行 + 托盘不可用回退。
 *
 * 这里不 import electron：window-close.ts 的判定与执行都靠注入（真接线在 window.ts / tray.ts /
 * index.ts——那三处的**源码级钉子**在 window-close-wiring.spec.ts；真窗口/真托盘/真聊天流由
 * e2e 探针 e2e/_r013-tray-close-probe.spec.ts 覆盖）。
 */
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { CloseToTrayMode } from '../../shared/settings'
import {
  CLOSE_PROMPT_BUTTONS,
  CLOSE_PROMPT_CHECKBOX,
  closeChoiceOf,
  closePromptOptions,
  closePromptResultOf,
  createCloseController,
  decideClose,
  parseScriptedClosePrompt,
  scriptedClosePromptFor,
  type CloseController,
  type CloseControllerActions,
  type ClosePromptResult
} from '../window-close'

/**
 * 假动作：弹窗回给定的结果（或按错误抛）；hide / quit / rememberChoice 都是 spy。
 * 显式写 `Mock<...>` 而不是 `ReturnType<typeof vi.fn>`：后者在 vitest 5 里是
 * `Mock<Procedure | Constructable>`（带构造签名）——赋给 `() => void` 这类签名会过不了 tsc。
 */
interface FakeActions extends CloseControllerActions {
  hide: Mock<() => void>
  quit: Mock<() => void>
  prompt: Mock<() => Promise<ClosePromptResult>>
  rememberChoice: Mock<(mode: 'tray' | 'quit') => void>
}

function fakeActions(
  result: ClosePromptResult | Error = { choice: 'tray', remember: false }
): FakeActions {
  return {
    hide: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
    prompt: vi.fn<() => Promise<ClosePromptResult>>(async () => {
      if (result instanceof Error) throw result
      return result
    }),
    rememberChoice: vi.fn<(mode: 'tray' | 'quit') => void>()
  }
}

interface ControllerOptions {
  mode?: () => CloseToTrayMode
  isQuitting?: () => boolean
  trayAvailable?: () => boolean
  platform?: NodeJS.Platform
  actions: FakeActions
}

/** 薄包装：单测默认"Windows + 托盘可用 + 没在退出 + 每次询问" */
function controllerOf(options: ControllerOptions): CloseController {
  return createCloseController({
    platform: options.platform ?? 'win32',
    mode: options.mode ?? (() => 'ask'),
    isQuitting: options.isQuitting ?? (() => false),
    trayAvailable: options.trayAvailable ?? (() => true),
    actions: options.actions
  })
}

function closeEvent(): { preventDefault: Mock<() => void> } {
  return { preventDefault: vi.fn<() => void>() }
}

/**
 * 弹窗收尾（写偏好 + hide/quit）挂在弹窗那条 promise 链上：等一拍（setTimeout 0）
 * 才能看到结果。与 updater.spec.ts 的 `flush` 同一口径（不依赖微任务的精确层数）。
 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('decideClose：关闭判定矩阵（三档偏好）', () => {
  const base = {
    platform: 'win32' as NodeJS.Platform,
    isQuitting: false,
    trayAvailable: true,
    mode: 'ask' as CloseToTrayMode
  }

  it('Windows/Linux + 托盘可用 + 没在退出：ask → 弹提示；tray → 隐藏；quit → 放行（正常关闭）', () => {
    expect(decideClose(base)).toEqual({ kind: 'prompt' })
    expect(decideClose({ ...base, mode: 'tray' })).toEqual({ kind: 'hide' })
    expect(decideClose({ ...base, mode: 'quit' })).toEqual({ kind: 'allow' })
    expect(decideClose({ ...base, platform: 'linux', mode: 'tray' })).toEqual({ kind: 'hide' })
  })

  it('真退出（app.quit / 更新安装 / 系统结束会话）→ 一律放行，三档都不例外', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      expect(decideClose({ ...base, mode, isQuitting: true })).toEqual({ kind: 'allow' })
    }
  })

  it('托盘不可用 → 一律放行（tray 档也不能把窗口藏到没有入口的后台）', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      expect(decideClose({ ...base, mode, trayAvailable: false })).toEqual({ kind: 'allow' })
    }
  })

  it('macOS 不参与（沿用 Dock 现状：窗口关掉、应用留着），三档都放行', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      expect(decideClose({ ...base, mode, platform: 'darwin' })).toEqual({ kind: 'allow' })
    }
  })
})

describe('createCloseController：ask 档的弹窗选择（选择 + 记住）', () => {
  it('ask 档：当场拦下（preventDefault）再弹提示；选「最小化到托盘」不勾选 = 只这一次——隐藏、不写偏好', async () => {
    const actions = fakeActions({ choice: 'tray', remember: false })
    const event = closeEvent()

    controllerOf({ mode: () => 'ask', actions }).handleClose(event)

    // close 事件是同步的：必须当场 preventDefault（窗口才不会销毁），弹窗随后异步来
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.prompt).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()

    await flush()
    // 隐藏 = 只有 hide 这一个动作（窗口与 webContents 都留着）：没有退出、没有销毁
    expect(actions.hide).toHaveBeenCalledTimes(1)
    expect(actions.quit).not.toHaveBeenCalled()
    // 没勾"记住" = 只这一次：不写偏好（下次还会问）
    expect(actions.rememberChoice).not.toHaveBeenCalled()
  })

  it('ask 档：选「退出 kyclaw」不勾选 = 只这一次——退出、不写偏好', async () => {
    const actions = fakeActions({ choice: 'quit', remember: false })
    const event = closeEvent()

    controllerOf({ mode: () => 'ask', actions }).handleClose(event)
    await flush()

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.quit).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.rememberChoice).not.toHaveBeenCalled()
  })

  it('ask 档：明确选「最小化到托盘」且勾选 → 先落偏好 tray，再隐藏', async () => {
    const actions = fakeActions({ choice: 'tray', remember: true })
    const event = closeEvent()

    controllerOf({ mode: () => 'ask', actions }).handleClose(event)
    await flush()

    expect(actions.rememberChoice).toHaveBeenCalledTimes(1)
    expect(actions.rememberChoice).toHaveBeenCalledWith('tray')
    expect(actions.hide).toHaveBeenCalledTimes(1)
    expect(actions.quit).not.toHaveBeenCalled()
  })

  it('ask 档：明确选「退出 kyclaw」且勾选 → 先落偏好 quit，再退出', async () => {
    const actions = fakeActions({ choice: 'quit', remember: true })

    controllerOf({ mode: () => 'ask', actions }).handleClose(closeEvent())
    await flush()

    expect(actions.rememberChoice).toHaveBeenCalledWith('quit')
    expect(actions.quit).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()
  })

  it('ask 档：取消（就算勾了框）→ 保留当前窗口，既不退也不藏、**不写偏好**', async () => {
    const actions = fakeActions({ choice: 'cancel', remember: true })
    const event = closeEvent()

    controllerOf({ mode: () => 'ask', actions }).handleClose(event)
    await flush()

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
    expect(actions.rememberChoice).not.toHaveBeenCalled()
  })

  it('ask 档：取消之后再点关闭仍然会问（偏好还是 ask）', async () => {
    const actions = fakeActions({ choice: 'cancel', remember: false })
    let mode: CloseToTrayMode = 'ask'
    const controller = controllerOf({
      mode: () => mode,
      actions
    })

    controller.handleClose(closeEvent())
    await flush()
    expect(actions.prompt).toHaveBeenCalledTimes(1)

    controller.handleClose(closeEvent())
    await flush()
    expect(actions.prompt).toHaveBeenCalledTimes(2)
    expect(actions.hide).not.toHaveBeenCalled()

    // 之后用户明确选了隐藏并勾了记住（这里模拟主进程落盘）：再点关闭直接收进托盘
    mode = 'tray'
    controller.handleClose(closeEvent())
    expect(actions.prompt).toHaveBeenCalledTimes(2)
    expect(actions.hide).toHaveBeenCalledTimes(1)
  })

  it('弹窗弹不出来（prompt 抛错）：按取消处理——不藏不退、不写偏好，也不冒出未处理拒绝', async () => {
    const actions = fakeActions(new Error('dialog unavailable'))

    controllerOf({ mode: () => 'ask', actions }).handleClose(closeEvent())
    await flush()

    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
    expect(actions.rememberChoice).not.toHaveBeenCalled()
  })

  it('落偏好写盘失败：这次的动作照常执行，只记日志（不冒充"已记住"）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const actions = fakeActions({ choice: 'tray', remember: true })
    actions.rememberChoice.mockImplementation(() => {
      throw new Error('磁盘满了')
    })

    controllerOf({ mode: () => 'ask', actions }).handleClose(closeEvent())
    await flush()

    // 动作照常（用户这次的选择有效）；日志如实（下次还会问）
    expect(actions.hide).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('弹窗还在飞的时候再点关闭（用户连点 / 程序性关闭）：只拦不重复弹', async () => {
    let resolvePrompt: ((result: ClosePromptResult) => void) | undefined
    const actions = fakeActions()
    actions.prompt.mockImplementation(
      () =>
        new Promise<ClosePromptResult>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const controller = controllerOf({ mode: () => 'ask', actions })

    const first = closeEvent()
    const second = closeEvent()
    controller.handleClose(first)
    controller.handleClose(second)

    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    // 第二次同样拦下（窗口不能在这时候真关掉），但不该弹第二个弹窗
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.prompt).toHaveBeenCalledTimes(1)

    resolvePrompt?.({ choice: 'tray', remember: false })
    await flush()
    expect(actions.hide).toHaveBeenCalledTimes(1)
  })

  it('弹窗期间应用开始真退出：这次选择（连同"记住"）作废——不改偏好、不隐藏、不重复退', async () => {
    let quitting = false
    let resolvePrompt: ((result: ClosePromptResult) => void) | undefined
    const actions = fakeActions()
    actions.prompt.mockImplementation(
      () =>
        new Promise<ClosePromptResult>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const controller = controllerOf({
      mode: () => 'ask',
      isQuitting: () => quitting,
      actions
    })

    controller.handleClose(closeEvent())
    quitting = true
    resolvePrompt?.({ choice: 'tray', remember: true })
    await flush()

    expect(actions.rememberChoice).not.toHaveBeenCalled()
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
  })

  /**
   * 主控 146 复审收口：弹窗是异步的，托盘可能在这中间失效（对象被销毁 / 探针翻 false）。
   * 这时用户选「最小化到托盘」已经无处可收 —— 按**取消**处理：保留窗口、也**不**记偏好
   * （勾了"记住"也不能落盘，否则下次会直接藏到没有入口的后台）。判定必须在 rememberChoice 之前。
   */
  it('弹窗期间托盘失效：选「最小化到托盘 + 记住」→ 保留窗口、不隐藏、偏好一个字节都不写', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let trayAlive = true
    let resolvePrompt: ((result: ClosePromptResult) => void) | undefined
    const actions = fakeActions()
    actions.prompt.mockImplementation(
      () =>
        new Promise<ClosePromptResult>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const controller = controllerOf({
      mode: () => 'ask',
      trayAvailable: () => trayAlive,
      actions
    })

    controller.handleClose(closeEvent())
    // 弹窗开着的时候托盘没了（isDestroyed / 探针翻 false）
    trayAlive = false
    resolvePrompt?.({ choice: 'tray', remember: true })
    await flush()

    expect(actions.rememberChoice).not.toHaveBeenCalled()
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
    // 按取消处理要有留痕（用户看得见的是窗口还在；日志如实）
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('弹窗期间托盘失效只影响「收进托盘」：选「退出 kyclaw + 记住」照常退出并记账', async () => {
    let trayAlive = true
    let resolvePrompt: ((result: ClosePromptResult) => void) | undefined
    const actions = fakeActions()
    actions.prompt.mockImplementation(
      () =>
        new Promise<ClosePromptResult>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const controller = controllerOf({
      mode: () => 'ask',
      trayAvailable: () => trayAlive,
      actions
    })

    controller.handleClose(closeEvent())
    trayAlive = false
    resolvePrompt?.({ choice: 'quit', remember: true })
    await flush()

    // 退出不需要托盘：照常退；偏好也照记（下次启动就是 quit）
    expect(actions.rememberChoice).toHaveBeenCalledWith('quit')
    expect(actions.quit).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()
  })
})

describe('createCloseController：偏好分档与放行', () => {
  it('tray 档：点关闭直接隐藏，不弹提示（每次都不弹）', () => {
    const actions = fakeActions()
    const controller = controllerOf({ mode: () => 'tray', actions })

    const first = closeEvent()
    const second = closeEvent()
    controller.handleClose(first)
    controller.handleClose(second)

    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(actions.hide).toHaveBeenCalledTimes(2)
    expect(actions.prompt).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
  })

  it('quit 档：放行（preventDefault 都不调，交给正常关闭 → window-all-closed 退出），不弹不藏', () => {
    const actions = fakeActions()
    const event = closeEvent()

    controllerOf({ mode: () => 'quit', actions }).handleClose(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(actions.prompt).not.toHaveBeenCalled()
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()
  })

  it('托盘不可用：三档都放行（放行关闭 → 关窗退出；绝不藏到没有入口的后台）', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      const actions = fakeActions()
      const event = closeEvent()
      controllerOf({ mode: () => mode, trayAvailable: () => false, actions }).handleClose(event)
      expect(event.preventDefault, mode).not.toHaveBeenCalled()
      expect(actions.prompt, mode).not.toHaveBeenCalled()
      expect(actions.hide, mode).not.toHaveBeenCalled()
    }
  })

  it('正在退出（真退出事件已立标记）：三档都放行，不拦不藏（安装不会被吞）', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      const actions = fakeActions()
      const event = closeEvent()
      controllerOf({ mode: () => mode, isQuitting: () => true, actions }).handleClose(event)
      expect(event.preventDefault, mode).not.toHaveBeenCalled()
      expect(actions.prompt, mode).not.toHaveBeenCalled()
      expect(actions.hide, mode).not.toHaveBeenCalled()
    }
  })

  it('托盘可用性每次现问：启动后托盘失效（isDestroyed）→ 再点关闭就放行，不再藏窗口', () => {
    let trayAlive = true
    const actions = fakeActions()
    const controller = controllerOf({
      mode: () => 'tray',
      trayAvailable: () => trayAlive,
      actions
    })

    // 托盘还活着：收进托盘
    controller.handleClose(closeEvent())
    expect(actions.hide).toHaveBeenCalledTimes(1)

    // 托盘对象没了：同一次会话里再点关闭必须放行（藏起来就找不回来了）
    trayAlive = false
    const event = closeEvent()
    controller.handleClose(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(actions.hide).toHaveBeenCalledTimes(1)
  })

  it('偏好每次现读（用户刚在设置页改过 / 刚勾了记住：以当下那份为准）', () => {
    const actions = fakeActions()
    let reads = 0
    const controller = controllerOf({
      mode: () => {
        reads += 1
        return 'tray'
      },
      actions
    })

    controller.handleClose(closeEvent())

    expect(reads).toBe(1)
    expect(actions.prompt).not.toHaveBeenCalled()
    expect(actions.hide).toHaveBeenCalledTimes(1)
  })

  it('macOS：放行（Dock 现状），三档都不弹不藏', () => {
    for (const mode of ['ask', 'tray', 'quit'] as const) {
      const actions = fakeActions()
      const event = closeEvent()
      controllerOf({ mode: () => mode, platform: 'darwin', actions }).handleClose(event)
      expect(event.preventDefault, mode).not.toHaveBeenCalled()
      expect(actions.prompt, mode).not.toHaveBeenCalled()
      expect(actions.hide, mode).not.toHaveBeenCalled()
    }
  })
})

describe('关闭弹窗的形状与响应映射', () => {
  it('按钮三项 + 默认落在托盘 + 取消落在最后；复选框默认不勾（只这一次）', () => {
    const options = closePromptOptions()

    expect(options.buttons).toEqual(['最小化到托盘', '退出 kyclaw', '取消'])
    expect(options.buttons).toEqual([...CLOSE_PROMPT_BUTTONS])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(2)
    expect(options.type).toBe('question')
    expect(options.noLink).toBe(true)
    // 复选框文案是用户可见口径；默认**不勾**（不勾 = 只这一次）
    expect(options.checkboxLabel).toBe(CLOSE_PROMPT_CHECKBOX)
    expect(options.checkboxChecked).toBe(false)
  })

  it('响应映射：0=托盘、1=退出、2=取消；认不出的响应（Esc / 关掉弹窗）一律当取消——保留窗口', () => {
    expect(closeChoiceOf(0)).toBe('tray')
    expect(closeChoiceOf(1)).toBe('quit')
    expect(closeChoiceOf(2)).toBe('cancel')
    // 关掉弹窗 / Esc 落到的就是取消按钮（cancelId），映射必须是取消——绝不能默认退出
    expect(closeChoiceOf(closePromptOptions().cancelId ?? -1)).toBe('cancel')
    for (const unknown of [-1, 3, 99, Number.NaN]) {
      expect(closeChoiceOf(unknown), String(unknown)).toBe('cancel')
    }
  })

  it('弹窗返回 → {choice, remember}：勾选状态如实回传；缺省 = 不勾', () => {
    expect(closePromptResultOf({ response: 0, checkboxChecked: true })).toEqual({
      choice: 'tray',
      remember: true
    })
    expect(closePromptResultOf({ response: 1, checkboxChecked: false })).toEqual({
      choice: 'quit',
      remember: false
    })
    expect(closePromptResultOf({ response: 2, checkboxChecked: true })).toEqual({
      choice: 'cancel',
      remember: true
    })
    // checkboxChecked 缺省（老形状/异常形状）：当不勾
    expect(closePromptResultOf({ response: 0 })).toEqual({ choice: 'tray', remember: false })
  })

  it('脚本化弹窗（探针注入）：只认 tray/quit/cancel[:remember]，其余当"没注入"', () => {
    expect(parseScriptedClosePrompt('tray')).toEqual({ choice: 'tray', remember: false })
    expect(parseScriptedClosePrompt('TRAY:REMEMBER')).toEqual({ choice: 'tray', remember: true })
    expect(parseScriptedClosePrompt('quit:remember')).toEqual({ choice: 'quit', remember: true })
    expect(parseScriptedClosePrompt('cancel')).toEqual({ choice: 'cancel', remember: false })
    // 未注入 / 空白 / 认不出的取值：按"没注入"走原生弹窗
    for (const raw of [undefined, '', '   ', 'always', 'tray:maybe', 'tray:remember:extra']) {
      expect(parseScriptedClosePrompt(raw), String(raw)).toBeNull()
    }
  })

  it('脚本化弹窗只在开发态生效：打包生产（is.dev=false）忽略 KYCLAW_CLOSE_PROMPT', () => {
    expect(scriptedClosePromptFor(true, 'tray:remember')).toEqual({
      choice: 'tray',
      remember: true
    })
    expect(scriptedClosePromptFor(true, 'cancel')).toEqual({ choice: 'cancel', remember: false })
    // 生产：同一个环境变量一律不认（不能静默改偏好 / 触发退出），走真弹窗
    for (const raw of ['tray:remember', 'quit', 'cancel', undefined, 'always']) {
      expect(scriptedClosePromptFor(false, raw), String(raw)).toBeNull()
    }
  })
})

describe('退出标记与托盘可用性（模块级状态：给 index.ts / window.ts / tray.ts 用的两个开关）', () => {
  it('退出标记缺省 false；markQuitting 是单向闩（立起来不撤销——所以只能由真退出事件调）', async () => {
    vi.resetModules()
    const fresh = await import('../window-close')

    expect(fresh.isQuitting()).toBe(false)
    fresh.markQuitting()
    expect(fresh.isQuitting()).toBe(true)
    // 再立一次还是 true；没有"撤销"的出口（接口面只有 mark/is 一对）
    fresh.markQuitting()
    expect(fresh.isQuitting()).toBe(true)
  })

  it('托盘可用性：没注册探针 = 不可用（保守）；注册后现问现答，销毁/抛错都立刻反映', async () => {
    vi.resetModules()
    const fresh = await import('../window-close')

    // 启动早期还没建托盘：按"不可用"算（放行关闭）
    expect(fresh.isTrayAvailable()).toBe(false)

    let destroyed = false
    fresh.registerTrayAvailability(() => !destroyed)
    expect(fresh.isTrayAvailable()).toBe(true)
    // 托盘对象后来失效：同一个探针立刻翻成 false（关闭策略下次判定就放行）
    destroyed = true
    expect(fresh.isTrayAvailable()).toBe(false)

    // 探针自己坏了：也按"不可用"处理（宁可关窗退出，也不藏到说不清有没有入口的后台）
    fresh.registerTrayAvailability(() => {
      throw new Error('tray probe exploded')
    })
    expect(fresh.isTrayAvailable()).toBe(false)
  })
})
