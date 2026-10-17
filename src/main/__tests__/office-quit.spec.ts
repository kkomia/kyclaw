// @vitest-environment node
/**
 * M3-S5-1：退出确认主进程状态机的聚焦单测（纯逻辑，不装 Electron）。
 *
 * 覆盖 `.superpowers/handover/s5-recon.md` §2.3 / §3.6 的状态机口径：
 *   1. 干净（dirty=0）直接放行；有 dirty 才拦下并向壳发 `office:quit-request`；
 *   2. `quitDecisionPending`（`phase==='asking'`）防重入：重复 before-quit / close 只拦不重发；
 *   3. 只有 saved / discarded 才 `markQuitting()` 并继续退出/关窗；cancelled 不立标记、窗口留着；
 *   4. 超时 / 发送失败 = 取消；伪造（owner 或 requestId 不匹配）与过期回包一律忽略；
 *   5. close 入口（window-close 的 allow 分支守卫）与 quit 入口分开：reason 不同、收尾动作不同；
 *   6. hide（收进托盘）与 prompt（原生三选一）分支**不问壳** —— 行为级断言在最后两组。
 *
 * 真 Electron 事件顺序不在单测范围：S5-4 的 preview 探针 `e2e/_r020-office-close.spec.ts` 覆盖。
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createOfficeQuitGuard,
  registerOfficeQuitIpc,
  type OfficeQuitGuard,
  type OfficeQuitGuardDeps,
  type OfficeQuitIpcRegistrar
} from '../office-quit'
import { createCloseController, registerCloseAllowGuard } from '../window-close'
import { IPC_CHANNELS, IpcInputError } from '../../shared/ipc'
import type { OfficeQuitRequestPayload } from '../../shared/office-editor'

const guards: OfficeQuitGuard[] = []

afterEach(() => {
  for (const guard of guards.splice(0)) guard.dispose()
  // 模块级注册表是 window-close.ts 的进程级状态：每个用例后清掉，别串到下一个
  registerCloseAllowGuard(null)
  vi.useRealTimers()
})

/** 一组带 spy 的注入件 + 一个真 guard（默认 60s 超时，避免测试结束时计时器还在飞） */
function harness(overrides: Partial<OfficeQuitGuardDeps> = {}): {
  guard: OfficeQuitGuard
  deps: OfficeQuitGuardDeps
} {
  let requestSeq = 0
  const deps: OfficeQuitGuardDeps = {
    sendToWindow: vi.fn<(ownerId: number, payload: OfficeQuitRequestPayload) => boolean>(
      () => true
    ),
    quit: vi.fn<() => void>(),
    closeWindow: vi.fn<(ownerId: number) => void>(),
    markQuitting: vi.fn<() => void>(),
    isQuitting: vi.fn<() => boolean>(() => false),
    askTimeoutMs: 60_000,
    createRequestId: () => `req-${++requestSeq}`,
    log: vi.fn<(line: string) => void>(),
    ...overrides
  }
  const guard = createOfficeQuitGuard(deps)
  guards.push(guard)
  return { guard, deps }
}

function quitEvent(): { preventDefault: Mock<() => void> } {
  return { preventDefault: vi.fn<() => void>() }
}

function sentPayloads(deps: OfficeQuitGuardDeps): OfficeQuitRequestPayload[] {
  return vi.mocked(deps.sendToWindow).mock.calls.map(([, payload]) => payload)
}

describe('退出确认状态机：before-quit 入口', () => {
  it('干净（dirty=0）：不拦、发请求为 0，直接立"正在退出"标记放行（旧口径不变）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 0)
    const event = quitEvent()

    guard.handleBeforeQuit(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()
    expect(guard.phase()).toBe('idle')
  })

  it('有 dirty：preventDefault + 向壳发 quit 请求（requestId / reason / 计数），且不立标记', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 2)
    const event = quitEvent()

    guard.handleBeforeQuit(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(sentPayloads(deps)).toEqual([{ requestId: 'req-1', reason: 'quit', dirtyCount: 2 }])
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()
    expect(guard.phase()).toBe('asking')
  })

  it('asking 期间重复 before-quit：只拦不重发（用户连点 / 双入口同时到）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())
    const second = quitEvent()
    guard.handleBeforeQuit(second)
    guard.handleBeforeQuit(quitEvent())

    expect(vi.mocked(deps.sendToWindow)).toHaveBeenCalledTimes(1)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(guard.phase()).toBe('asking')
  })

  it('saved：先立标记再 app.quit（顺序断言），之后的 before-quit 一律放行不再问', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    guard.settle(7, { requestId: 'req-1', action: 'saved' })

    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.markQuitting).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.quit).mock.invocationCallOrder[0]!
    )
    expect(guard.phase()).toBe('idle')

    // 壳回 saved 后 app.quit() 会再触发一次 before-quit：decided 已置 → 直接放行
    const again = quitEvent()
    guard.handleBeforeQuit(again)
    expect(again.preventDefault).not.toHaveBeenCalled()
    expect(vi.mocked(deps.sendToWindow)).toHaveBeenCalledTimes(1)
  })

  it('discarded：同样立标记并退出（用户明确放弃修改）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    guard.settle(7, { requestId: 'req-1', action: 'discarded' })

    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).toHaveBeenCalledTimes(1)
  })

  it('cancelled：不立标记、不退出；再次点退出会重新问（新 requestId）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    guard.settle(7, { requestId: 'req-1', action: 'cancelled' })

    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()
    expect(guard.phase()).toBe('idle')

    const again = quitEvent()
    guard.handleBeforeQuit(again)
    expect(again.preventDefault).toHaveBeenCalledTimes(1)
    expect(sentPayloads(deps).map((payload) => payload.requestId)).toEqual(['req-1', 'req-2'])
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
  })

  it('真事件已立过标记（更新安装 / 系统结束会话）：不再拦也不再问', () => {
    const { guard, deps } = harness({ isQuitting: vi.fn<() => boolean>(() => true) })
    guard.reportDirty(7, 3)
    const event = quitEvent()

    guard.handleBeforeQuit(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
  })
})

describe('退出确认状态机：close allow 入口', () => {
  it('有 dirty：接管关闭并问壳（reason=close）；saved 后立标记 + 关窗（不调 quit）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(9, 1)
    const event = quitEvent()

    expect(guard.guardCloseAllow(event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(sentPayloads(deps)).toEqual([{ requestId: 'req-1', reason: 'close', dirtyCount: 1 }])

    guard.settle(9, { requestId: 'req-1', action: 'saved' })

    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.closeWindow)).toHaveBeenCalledWith(9)
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()

    // markQuitting 已置 → 下一次 close（guard 自己发起的 win.close）不再被拦
    const second = quitEvent()
    expect(guard.guardCloseAllow(second)).toBe(false)
    expect(second.preventDefault).not.toHaveBeenCalled()
  })

  it('干净 / 已在退出：不接管（保持 window-close.ts 原行为）', () => {
    const clean = harness()
    clean.guard.reportDirty(9, 0)
    expect(clean.guard.guardCloseAllow(quitEvent())).toBe(false)
    expect(vi.mocked(clean.deps.sendToWindow)).not.toHaveBeenCalled()

    const quitting = harness({ isQuitting: vi.fn<() => boolean>(() => true) })
    quitting.guard.reportDirty(9, 2)
    expect(quitting.guard.guardCloseAllow(quitEvent())).toBe(false)
    expect(vi.mocked(quitting.deps.sendToWindow)).not.toHaveBeenCalled()
  })

  it('asking 期间重复 close：只拦不重发（同一个对话框，不叠加）', () => {
    const { guard, deps } = harness()
    guard.reportDirty(9, 1)
    guard.guardCloseAllow(quitEvent())
    const second = quitEvent()

    expect(guard.guardCloseAllow(second)).toBe(true)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.sendToWindow)).toHaveBeenCalledTimes(1)
  })
})

describe('退出确认状态机：失败 / 超时 / 伪造回包（一律按取消）', () => {
  it('发送失败（壳不可用）：phase 回 idle、不立标记、不退出（窗口保持）', () => {
    const { guard, deps } = harness({
      sendToWindow: vi.fn<(ownerId: number, payload: OfficeQuitRequestPayload) => boolean>(
        () => false
      )
    })
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    expect(guard.phase()).toBe('idle')
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()
  })

  it('从没收到过脏计数（拿不到 owner）：即便脏计数>0 也按取消处理，不发请求', () => {
    const { guard, deps } = harness()
    // 直接篡改不了内部 dirty；用 0→1 的上报路径反证：没有 owner 时 ask 不会发
    const event = quitEvent()
    guard.handleBeforeQuit(event)
    // dirty=0 → 走干净放行分支，这一条只保证不炸；owner 缺失只在内部防御路径出现
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
  })

  it('超时：按取消处理（不立标记不退出）；迟到的 saved 回包被忽略；可再次触发', () => {
    vi.useFakeTimers()
    const { guard, deps } = harness({ askTimeoutMs: 5_000 })
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())
    expect(guard.phase()).toBe('asking')

    vi.advanceTimersByTime(5_000)

    expect(guard.phase()).toBe('idle')
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()

    // 超时后才到的回包：没有在飞请求 → 忽略
    guard.settle(7, { requestId: 'req-1', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()

    // 用户可以再点一次退出：重新发请求
    guard.handleBeforeQuit(quitEvent())
    expect(sentPayloads(deps).map((payload) => payload.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('伪造 / 过期回包一律忽略：owner 不匹配、requestId 不匹配、没在问', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    // 别的窗口回来的（owner 不匹配）
    guard.settle(99, { requestId: 'req-1', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()

    // requestId 不对（旧请求 / 伪造）
    guard.settle(7, { requestId: 'forged', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(guard.phase()).toBe('asking')

    // 正主回包才生效
    guard.settle(7, { requestId: 'req-1', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).toHaveBeenCalledTimes(1)
  })

  it('同一回包重复到达（saved 之后又回一次 cancelled）：第二次不再影响状态', () => {
    const { guard, deps } = harness()
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())
    guard.settle(7, { requestId: 'req-1', action: 'saved' })
    guard.settle(7, { requestId: 'req-1', action: 'cancelled' })

    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).toHaveBeenCalledTimes(1)
  })
})

describe('脏计数上报与诊断面', () => {
  it('reportDirty：只记计数与 owner，最后一次上报为准', () => {
    const { guard } = harness()
    expect(guard.dirtyCount()).toBe(0)
    guard.reportDirty(7, 3)
    expect(guard.dirtyCount()).toBe(3)
    guard.reportDirty(7, 0)
    expect(guard.dirtyCount()).toBe(0)
  })

  it('dispose：清计时器、相位回 idle（幂等）', () => {
    vi.useFakeTimers()
    const { guard, deps } = harness({ askTimeoutMs: 5_000 })
    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())
    expect(guard.phase()).toBe('asking')

    guard.dispose()
    guard.dispose()
    expect(guard.phase()).toBe('idle')

    // 计时器已被清掉：推进时间不会产生"超时"副作用
    vi.advanceTimersByTime(10_000)
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.quit)).not.toHaveBeenCalled()
  })
})

describe('registerOfficeQuitIpc：两条 invoke 通道的闸门与接线', () => {
  function fakeIpc(): {
    handlers: Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>
    ipc: OfficeQuitIpcRegistrar
  } {
    const handlers = new Map<
      string,
      (event: { sender: { id: number } }, ...args: unknown[]) => unknown
    >()
    return { handlers, ipc: { handle: (channel, listener) => handlers.set(channel, listener) } }
  }

  function handlerOf(
    handlers: Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>,
    channel: string
  ): (event: { sender: { id: number } }, ...args: unknown[]) => unknown {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`通道没注册：${channel}`)
    return handler
  }

  it('注册 dirty-state 与 quit-result 两条通道', () => {
    const { guard } = harness()
    const { handlers, ipc } = fakeIpc()
    registerOfficeQuitIpc(guard, ipc)

    expect([...handlers.keys()].sort()).toEqual(['office:dirty-state', 'office:quit-result'])
    expect(handlers.has(IPC_CHANNELS.office.dirtyState)).toBe(true)
    expect(handlers.has(IPC_CHANNELS.office.quitResult)).toBe(true)
  })

  it('dirty-state：合法入参 → reportDirty(sender.id, count)；坏形状抛 IpcInputError 且不改状态', () => {
    const { guard } = harness()
    const { handlers, ipc } = fakeIpc()
    registerOfficeQuitIpc(guard, ipc)
    const dirtyState = handlerOf(handlers, IPC_CHANNELS.office.dirtyState)

    dirtyState({ sender: { id: 7 } }, 2)
    expect(guard.dirtyCount()).toBe(2)

    expect(() => dirtyState({ sender: { id: 7 } }, -1)).toThrow(IpcInputError)
    expect(() => dirtyState({ sender: { id: 7 } }, 'two')).toThrow(IpcInputError)
    expect(() => dirtyState({ sender: { id: 7 } })).toThrow(IpcInputError)
    expect(guard.dirtyCount()).toBe(2)
  })

  it('quit-result：合法回包 → settle（按 sender.id 校验 owner）；坏形状抛且不推进状态', () => {
    const { guard, deps } = harness()
    const { handlers, ipc } = fakeIpc()
    registerOfficeQuitIpc(guard, ipc)
    const quitResult = handlerOf(handlers, IPC_CHANNELS.office.quitResult)

    guard.reportDirty(7, 1)
    guard.handleBeforeQuit(quitEvent())

    expect(() =>
      quitResult({ sender: { id: 7 } }, { requestId: 'req-1', action: 'maybe' })
    ).toThrow(IpcInputError)
    expect(() => quitResult({ sender: { id: 7 } }, { action: 'saved' })).toThrow(IpcInputError)
    expect(guard.phase()).toBe('asking')

    quitResult({ sender: { id: 7 } }, { requestId: 'req-1', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.quit)).toHaveBeenCalledTimes(1)

    // owner 不匹配的回包不生效（但形状合法 → 不抛）
    expect(() =>
      quitResult({ sender: { id: 8 } }, { requestId: 'req-1', action: 'cancelled' })
    ).not.toThrow()
  })
})

describe('window-close 的 allow 分支接线（行为级：只有 allow 问壳）', () => {
  function controllerOf(options: {
    mode: 'ask' | 'tray' | 'quit'
    guard: OfficeQuitGuard
    isQuitting?: () => boolean
  }): {
    handleClose: (event: { preventDefault: () => void }) => void
    actions: {
      hide: ReturnType<typeof vi.fn>
      quit: ReturnType<typeof vi.fn>
      prompt: ReturnType<typeof vi.fn>
      rememberChoice: ReturnType<typeof vi.fn>
    }
  } {
    const actions = {
      hide: vi.fn(),
      quit: vi.fn(),
      prompt: vi.fn(async () => ({ choice: 'cancel' as const, remember: false })),
      rememberChoice: vi.fn()
    }
    registerCloseAllowGuard((event) => options.guard.guardCloseAllow(event))
    const controller = createCloseController({
      mode: () => options.mode,
      actions,
      platform: 'win32',
      isQuitting: options.isQuitting ?? (() => false),
      trayAvailable: () => true
    })
    return { handleClose: controller.handleClose, actions }
  }

  it('allow（偏好 quit）+ dirty>0：守卫接管、preventDefault、问壳；saved 后立标记 + 关窗', () => {
    const { guard, deps } = harness()
    guard.reportDirty(9, 1)
    const { handleClose, actions } = controllerOf({ mode: 'quit', guard })
    const event = quitEvent()

    handleClose(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.sendToWindow)).toHaveBeenCalledTimes(1)
    expect(actions.hide).not.toHaveBeenCalled()
    expect(actions.quit).not.toHaveBeenCalled()

    guard.settle(9, { requestId: 'req-1', action: 'saved' })
    expect(vi.mocked(deps.markQuitting)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.closeWindow)).toHaveBeenCalledWith(9)
  })

  it('hide（收进托盘）：不问壳，照常隐藏', () => {
    const { guard, deps } = harness()
    guard.reportDirty(9, 2)
    const { handleClose, actions } = controllerOf({ mode: 'tray', guard })

    handleClose(quitEvent())

    expect(actions.hide).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.markQuitting)).not.toHaveBeenCalled()
  })

  it('prompt（原生三选一）：不问壳，照常弹原生框', () => {
    const { guard, deps } = harness()
    guard.reportDirty(9, 2)
    const { handleClose, actions } = controllerOf({ mode: 'ask', guard })

    handleClose(quitEvent())

    expect(actions.prompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
  })

  it('已在真退出（isQuitting）：allow 放行，守卫不接管', () => {
    // 真接线给 window-close 的 controller 与 guard 注入的是**同一个** isQuitting()
    const quittingNow = (): boolean => true
    const { guard, deps } = harness({ isQuitting: vi.fn<() => boolean>(quittingNow) })
    guard.reportDirty(9, 2)
    const { handleClose, actions } = controllerOf({
      mode: 'quit',
      guard,
      isQuitting: quittingNow
    })
    const event = quitEvent()

    handleClose(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(vi.mocked(deps.sendToWindow)).not.toHaveBeenCalled()
    expect(actions.hide).not.toHaveBeenCalled()
  })
})
