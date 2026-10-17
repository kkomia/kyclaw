/**
 * 退出确认的主进程状态机（M3-S5-1 plumbing）。
 *
 * 为什么需要两个入口（结论来自 `.superpowers/handover/s5-recon.md` §2.1，已按现有代码核对）：
 *   1. **`before-quit`**（托盘「退出」/ `app.quit()` / 窗口关完后的第二次进入）：覆盖 P1/P3，
 *      `app.quit()` 时窗口还活着，**能问**壳；
 *   2. **窗口 `close` 的 allow 分支**（`window-close.ts` 的 `registerCloseAllowGuard`）：用户点 X
 *      且偏好 `quit`（或托盘不可用）时，Electron 先关窗、再 `window-all-closed → app.quit()`，
 *      到 `before-quit` 那一步 renderer 已经销毁，**问不了** → 必须在 close 放行前拦。
 *   托盘隐藏（`kind==='hide'`）不问：窗口不销毁，iframe / 编辑器 / 未保存内容都还在内存里。
 *
 * 这个模块是**纯状态机 + 可注入副作用**（不 import electron，单测直接驱动；仿 window-close.ts
 * 的"纯逻辑 + 接线在 index.ts"分层）。真接线在 `index.ts` 的 `app.on('before-quit', …)` 与
 * `registerCloseAllowGuard(…)`。
 *
 * 三条硬口径（`.superpowers/handover/s5-recon.md` §2.4 / §5-R1）：
 *   1. **`markQuitting()` 只在放行分支调用**：① before-quit 时脏计数为 0；② 壳回 `saved` /
 *      `discarded`。取消 / 超时 / 发送失败 / 伪造回包**绝不**立标记 —— 标记是单向的
 *      （`window-close.ts` 文件头第 1 条），提前立起来会让之后的点 X 绕过托盘策略。
 *      两条放行分支都只经 `markAllowedQuit` 这一处（源码钉子按"唯一落点 + 两个调用点"钉）。
 *   2. **超时 / 拿不到壳 = 取消**：应用保持打开（宁可让用户再点一次，也不静默丢内容），
 *      与 `window-close.ts` 的"弹窗弹不出来按取消"同口径。
 *   3. **回包要双匹配**：`sender.id === 上报脏计数的那个 webContents` 且 `requestId` 等于本次
 *      请求（伪造 / 串窗口 / 过期回包一律忽略）。
 */
import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS, parseIpcArgs } from '../shared/ipc'
import {
  officeDirtyStateArgsSchema,
  officeQuitResultArgsSchema,
  type OfficeQuitRequestPayload,
  type OfficeQuitResult
} from '../shared/office-editor'

/** 这次要问壳的是哪条入口：`quit` = 真退出；`close` = 点 X 要真的关窗（见文件头） */
export type OfficeQuitReason = 'quit' | 'close'

/** guard 自己的相位：idle = 没在问；asking = 已发退出确认请求、等壳回包 */
export type OfficeQuitPhase = 'idle' | 'asking'

/** close / before-quit 事件只要这么一点面（Electron 的 Event / preventDefault 天然满足） */
export interface OfficeQuitEvent {
  preventDefault(): void
}

/**
 * 壳对退出确认请求的应答动作（与 `shared/office-editor.ts` 的 `OfficeQuitAction` 同义）。
 * 这里不重复定义类型，直接用共享合同里的 `OfficeQuitResult`。
 */
export interface OfficeQuitGuardDeps {
  /**
   * 把退出确认请求发给**最后一次上报脏计数**的那个 webContents。
   * 返回 false = 找不到 / 已销毁（拿不到壳）→ 按取消处理。
   */
  sendToWindow(ownerId: number, payload: OfficeQuitRequestPayload): boolean
  /** 决策为 saved / discarded 后继续退出（`app.quit()`） */
  quit(): void
  /**
   * 决策为 saved / discarded 后继续关窗（close 入口）。
   * 调用前已 `markQuitting()`，所以下一次 close 会直接放行、不会再被 guard 拦。
   */
  closeWindow(ownerId: number): void
  /** 只在"允许退出/关闭"的分支里调用（顺序见文件头第 1 条；window-close.ts 的 markQuitting） */
  markQuitting(): void
  /** 真事件已经立过"正在退出"标记（更新安装 / 系统结束会话 / 上一次放行）：不再拦 */
  isQuitting(): boolean
  /** 壳应答超时（默认 5s；超时 = 取消） */
  askTimeoutMs?: number
  /** 测试注入：生成 requestId（默认 randomUUID） */
  createRequestId?: () => string
  /** 测试/诊断用日志出口（默认 console.warn） */
  log?: (line: string) => void
}

export interface OfficeQuitGuard {
  /** 壳推送脏计数（ownerId = 发送它的 webContents.id） */
  reportDirty(ownerId: number, count: number): void
  /** `app.on('before-quit', …)` 的处理器 */
  handleBeforeQuit(event: OfficeQuitEvent): void
  /**
   * `window-close.ts` 的 allow 分支守卫：返回 true = 已接管（已 preventDefault、稍后异步收尾），
   * 调用方不要再放行。返回 false = 不接管（干净直接关 / 已在退出）。
   */
  guardCloseAllow(event: OfficeQuitEvent): boolean
  /** 壳回包（index.ts 的 IPC handler 校验完形状后调用；这里再校验 owner + requestId） */
  settle(ownerId: number, response: OfficeQuitResult): void
  /** 快速判空用的脏计数 */
  dirtyCount(): number
  /** 测试/诊断：`idle` 还是 `asking` */
  phase(): OfficeQuitPhase
  /** 收尾：清掉在飞的超时计时器（应用退出/单测清理用，幂等） */
  dispose(): void
}

/** 壳应答退出确认的超时（超时 = 取消：应用保持打开） */
export const OFFICE_QUIT_ASK_TIMEOUT_MS = 5_000

export function createOfficeQuitGuard(deps: OfficeQuitGuardDeps): OfficeQuitGuard {
  const askTimeoutMs = deps.askTimeoutMs ?? OFFICE_QUIT_ASK_TIMEOUT_MS
  const newRequestId = deps.createRequestId ?? ((): string => randomUUID())
  const log = deps.log ?? ((line: string): void => console.warn(`[kyclaw] ${line}`))

  /** 最后一次上报脏计数的 webContents（S5 只有单一主窗口，仍按 owner 校验） */
  let ownerId: number | null = null
  /** 壳推来的未保存文档数快照（只用于快速判空；壳的应答才是权威） */
  let dirty = 0
  let phase: OfficeQuitPhase = 'idle'
  /** 壳已回 saved / discarded：之后的所有 before-quit / close 一律放行 */
  let decided = false
  /** 在飞的那一次请求（回包必须同时匹配 ownerId 与 requestId） */
  let pending: { requestId: string; reason: OfficeQuitReason; ownerId: number } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 允许退出/关窗的**唯一收口**：置"正在退出"标记后继续。
   * 只被两条放行路径调用（源码钉子钉住这两个调用点，多一处就该有人解释）：
   *   ① before-quit 时脏计数为 0（真退出事件已发生，保持旧口径）；
   *   ② 壳回 `saved` / `discarded`。
   * 取消 / 超时 / 发送失败 / 伪造回包**一律不经过这里**。
   */
  const markAllowedQuit = (): void => {
    deps.markQuitting()
  }

  /** 发一次退出确认请求；发送失败或拿不到 owner 时按取消处理（调用方已经 preventDefault） */
  const ask = (reason: OfficeQuitReason): void => {
    if (ownerId === null) {
      log('还没有收到过壳的脏计数上报（拿不到窗口）→ 按取消处理，应用保持打开')
      return
    }
    phase = 'asking'
    const requestId = newRequestId()
    pending = { requestId, reason, ownerId }
    const sent = deps.sendToWindow(ownerId, { requestId, reason, dirtyCount: dirty })
    if (!sent) {
      phase = 'idle'
      pending = null
      log('壳不可用（窗口已销毁或找不到）→ 按取消处理，应用保持打开')
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (phase !== 'asking') return
      phase = 'idle'
      pending = null
      log(`壳 ${String(askTimeoutMs)}ms 内没有应答退出确认 → 按取消处理，应用保持打开`)
    }, askTimeoutMs)
  }

  return {
    reportDirty: (senderId, count) => {
      ownerId = senderId
      dirty = count
    },

    handleBeforeQuit: (event) => {
      // 已经允许退出（壳回 saved/discarded），或真事件已立过标记（更新安装 / 系统结束会话）：
      // 一律放行，别再拦（否则会把退出卡死）
      if (decided || deps.isQuitting()) return
      if (phase === 'asking') {
        // 正在问：重复触发（用户连点 / 关窗与退出同时到）只拦下，不重复发请求
        event.preventDefault()
        return
      }
      if (dirty === 0) {
        // 干净：真退出事件已经发生，按旧口径立标记后放行（close 事件见到一律 allow）
        markAllowedQuit()
        return
      }
      event.preventDefault()
      ask('quit')
    },

    guardCloseAllow: (event) => {
      // 正在退出 / 已决定放行：不接管，交给原来的关闭策略（此时 isQuitting 为真 → allow）
      if (decided || deps.isQuitting()) return false
      // 干净：不接管，照常关闭（保持 window-close.ts 的原行为）
      if (dirty === 0) return false
      if (phase === 'asking') {
        // 已经在问：把重复的关窗也拦下（同一个对话框，不叠加）
        event.preventDefault()
        return true
      }
      event.preventDefault()
      ask('close')
      return true
    },

    settle: (senderId, response) => {
      // 没在问 / 已经结束：过期回包（含超时后才到的）忽略
      if (phase !== 'asking' || pending === null) return
      // 双匹配：发送方必须是上报脏计数的那个 webContents，且必须是这一次的 requestId
      if (senderId !== pending.ownerId || response.requestId !== pending.requestId) return
      clearTimer()
      const { reason, ownerId: target } = pending
      phase = 'idle'
      pending = null
      if (response.action === 'cancelled') {
        log('壳回取消：窗口保持原样（应用不退出、不关窗）')
        return
      }
      // saved / discarded：唯一允许立标记的分支（见文件头第 1 条）
      decided = true
      markAllowedQuit()
      if (reason === 'quit') deps.quit()
      else deps.closeWindow(target)
    },

    dirtyCount: () => dirty,
    phase: () => phase,

    dispose: () => {
      clearTimer()
      phase = 'idle'
      pending = null
    }
  }
}

/** IPC handler 只要这么一点面（`ipcMain` 天然满足；单测用假件） */
export interface OfficeQuitIpcEvent {
  sender: { id: number }
}

export interface OfficeQuitIpcRegistrar {
  handle(
    channel: string,
    listener: (event: OfficeQuitIpcEvent, ...args: unknown[]) => unknown
  ): void
}

/**
 * 注册 S5 的两条 invoke 通道（`office:dirty-state` / `office:quit-result`）。
 *
 * 为什么在这而不住 `ipc/office.ts`：S5-1 的写域把主进程改动收在 `office-quit.ts` + `index.ts`
 * （`ipc/office.ts` 由 S3 收口、本轮不动）；通道名 / 入参形状仍在 `shared/office-editor.ts`，
 * 行为与"注册在 ipc/office.ts 里"完全一致。将来若挪进 `ipc/office.ts`，把这两个 handler 搬过去、
 * index.ts 改一行注册即可。
 */
export function registerOfficeQuitIpc(guard: OfficeQuitGuard, ipc: OfficeQuitIpcRegistrar): void {
  ipc.handle(IPC_CHANNELS.office.dirtyState, (event, ...args) => {
    // 渲染端是不可信侧：坏形状直接抛（IpcInputError），不碰 guard 状态
    const [count] = parseIpcArgs(officeDirtyStateArgsSchema, args, IPC_CHANNELS.office.dirtyState)
    guard.reportDirty(event.sender.id, count)
    return undefined
  })
  ipc.handle(IPC_CHANNELS.office.quitResult, (event, ...args) => {
    const [result] = parseIpcArgs(officeQuitResultArgsSchema, args, IPC_CHANNELS.office.quitResult)
    guard.settle(event.sender.id, result)
    return undefined
  })
}
