/**
 * 关闭主窗口的策略（0.1.3 托盘驻留）：Windows / Linux 按**三档偏好**处理"点关闭"——
 *   - `ask`（默认）：弹原生三选一（最小化到托盘 / 退出 kyclaw / 取消），弹窗里有
 *     「记住我的选择，下次不再询问」复选框（默认不勾）；
 *   - `tray`：直接收进托盘（窗口与 webContents 都留着，后台任务照跑，从托盘 / 再起一次应用找回）；
 *   - `quit`：放行正常关闭（window-all-closed → 退出应用）。
 * macOS 照既有 Dock 口径（窗口关掉、应用不退），托盘不可用时一律放行（不能藏到没有入口的后台）。
 *
 * 判定与执行都收在这个模块里：**不 import electron 运行时**（`MessageBoxOptions` 只是类型），
 * 单测注入假动作就能跑全（见 main/__tests__/window-close.spec.ts）；真接线在
 * window.ts（close 事件 + 弹窗 + hide + 落偏好）、tray.ts（可用性探针）、index.ts（真退出事件标记），
 * 那三处接线的口径另有源码级钉子（main/__tests__/window-close-wiring.spec.ts）。
 *
 * 三条硬口径：
 *   1. **只有真退出事件才立标记**。`markQuitting()` 是**单向**的（进程确实在退出，没有撤销）：
 *      提前立起来会把之后的关闭全部放行（用户再点 X 就直接退出应用）。所以只在
 *      `app` 的 `before-quit`、更新安装的 `before-quit-for-update`、Windows 会话结束的
 *      `session-end` 这三处真事件上立——安装失败 / 静默没退 / 重复点安装都不会立
 *      （见 window.ts / index.ts 的注释与接线钉子）。
 *   2. **托盘不可用一定放行**。托盘是"关到后台"这套行为**唯一**的找回入口，可用性由 tray.ts
 *      注册的探针**现问现答**（含 `isDestroyed()`——启动后失效立刻反映）。
 *   3. **判定同步、动作异步**。close 事件必须当场决定拦不拦（Electron 的契约），弹窗是异步的：
 *      先在 close 里 preventDefault，再按结果执行 hide / quit / 不动作。
 *
 * 弹窗结果 = `{choice, remember}`：**只有明确选了 tray / quit 且勾了「记住」**才写偏好
 * （`closeToTrayMode`），下次点关闭就按它走；不勾 = 只这一次，什么都不写。取消（含 Esc /
 * 直接关掉弹窗）、弹不出来、以及**弹窗期间应用已开始真退出**，都不写偏好、也不改窗口状态。
 * 写偏好失败：这次的选择照常生效，只记日志（不冒充"已记住"，下次还会问）。
 */
import type { MessageBoxOptions } from 'electron'
import type { CloseToTrayMode } from '../shared/settings'

/** 弹窗里用户选了什么（取消 = 保留当前窗口，既不退也不藏） */
export type CloseChoice = 'tray' | 'quit' | 'cancel'

/** 能被"记住"的偏好：弹窗里只有这两个明确选择（取消不是偏好，ask 是默认值） */
export type RememberedCloseMode = 'tray' | 'quit'

/** 弹窗的完整返回值：选择 + 有没有勾「记住我的选择」 */
export interface ClosePromptResult {
  choice: CloseChoice
  remember: boolean
}

/** 退出开始了吗（显式 quit / 更新安装 / 系统结束会话）——close 事件见到它一律放行 */
let quitting = false

/** 标记"正在退出"：只在真退出事件上调（`before-quit` / `before-quit-for-update` / `session-end`） */
export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/**
 * 托盘可用性探针（tray.ts 注册；共享注册函数，避免 tray.ts 与 window.ts 互相 import 成环）。
 * 现问现答：托盘对象后来没了（`isDestroyed()`）会立刻反映到判定里。
 */
let trayAvailability: (() => boolean) | null = null

export function registerTrayAvailability(probe: () => boolean): void {
  trayAvailability = probe
}

/**
 * 没注册探针 = 不可用（保守：启动早期还没建托盘时点关闭也不会被吞）；
 * 探针自己抛 = 也不可用（宁可关窗退出，也不能把窗口藏到一个说不清有没有入口的后台）。
 */
export function isTrayAvailable(): boolean {
  try {
    return trayAvailability?.() ?? false
  } catch {
    return false
  }
}

/** 判定一次关闭要拿的四个事实 */
export interface CloseContext {
  platform: NodeJS.Platform
  isQuitting: boolean
  trayAvailable: boolean
  /** 用户偏好（现读设置：设置页刚改过 / 弹窗刚勾过"记住"都以当下那份为准） */
  mode: CloseToTrayMode
}

/**
 * 关闭的下场：allow = 放行（窗口照常销毁）；hide = 拦下收进托盘；prompt = 拦下并弹三选一。
 * 只有 win32 / linux 且非退出、托盘可用时才可能有后两种（macOS 与托盘不可用都放行）。
 */
export type CloseDecision = { kind: 'allow' } | { kind: 'hide' } | { kind: 'prompt' }

export function decideClose(context: CloseContext): CloseDecision {
  if (context.isQuitting) return { kind: 'allow' }
  if (context.platform !== 'win32' && context.platform !== 'linux') return { kind: 'allow' }
  if (!context.trayAvailable) return { kind: 'allow' }
  if (context.mode === 'quit') return { kind: 'allow' }
  return context.mode === 'tray' ? { kind: 'hide' } : { kind: 'prompt' }
}

/** 弹窗按钮（顺序即响应序号；取消在最后） */
export const CLOSE_PROMPT_BUTTONS = ['最小化到托盘', '退出 kyclaw', '取消'] as const

/** 取消按钮的下标（Esc / 直接关掉弹窗也落在这里） */
export const CLOSE_PROMPT_CANCEL_ID = 2

/** 「记住我的选择」复选框的文案（用户可见口径） */
export const CLOSE_PROMPT_CHECKBOX = '记住我的选择，下次不再询问'

/**
 * 关闭弹窗（window.ts 拿它调 dialog.showMessageBox）。
 * 默认落在「最小化到托盘」（0）；`cancelId` 落在「取消」——**取消保留当前窗口**，绝不误退；
 * 复选框**默认不勾**（不勾 = 只这一次，不写偏好）。
 */
export function closePromptOptions(): MessageBoxOptions {
  return {
    type: 'question',
    title: '关闭窗口',
    message: '关闭窗口后 kyclaw 会在后台继续运行',
    detail: '正在跑的任务不会中断，可以从托盘图标重新打开窗口。要结束应用请选「退出 kyclaw」。',
    buttons: [...CLOSE_PROMPT_BUTTONS],
    defaultId: 0,
    cancelId: CLOSE_PROMPT_CANCEL_ID,
    noLink: true,
    checkboxLabel: CLOSE_PROMPT_CHECKBOX,
    checkboxChecked: false
  }
}

/** 弹窗响应 → 选择；认不出的响应（含 Esc / 关掉弹窗）一律当取消：保留窗口，既不退也不藏 */
export function closeChoiceOf(response: number): CloseChoice {
  if (response === 0) return 'tray'
  if (response === 1) return 'quit'
  return 'cancel'
}

/**
 * dialog 的返回 → `{choice, remember}`（勾选状态如实回传；缺省 = 不勾）。
 * "勾选只有配明确选择才算数"那一条由控制器把关（取消时记住也作废，见 applyPromptResult）。
 */
export function closePromptResultOf(result: {
  response: number
  checkboxChecked?: boolean
}): ClosePromptResult {
  return { choice: closeChoiceOf(result.response), remember: result.checkboxChecked === true }
}

/**
 * 脚本化弹窗（隔离探针注入，`KYCLAW_CLOSE_PROMPT`）：原生模态弹窗点不到，探针用
 * `<choice>[:remember]`（tray / quit / cancel）驱动**真实的** close → 落盘 → hide/quit 路径。
 * 认不出的取值/空串一律回 null（= 走真弹窗）。
 */
export function parseScriptedClosePrompt(raw: string | undefined): ClosePromptResult | null {
  const text = (raw ?? '').trim().toLowerCase()
  if (text === '') return null
  const parts = text.split(':')
  if (parts.length > 2) return null
  const [choice, modifier] = parts
  if (choice !== 'tray' && choice !== 'quit' && choice !== 'cancel') return null
  if (modifier !== undefined && modifier !== 'remember') return null
  return { choice, remember: modifier === 'remember' }
}

/**
 * 探针注入的**唯一入口**：只有开发态（`is.dev`）才认 `KYCLAW_CLOSE_PROMPT`，
 * 打包生产一律回 null —— 环境变量不能静默改偏好 / 触发退出，生产永远走真弹窗。
 * 判定收成纯函数，这一条在单测里直接钉（不必去打包件里试）。
 */
export function scriptedClosePromptFor(
  isDev: boolean,
  raw: string | undefined
): ClosePromptResult | null {
  return isDev ? parseScriptedClosePrompt(raw) : null
}

/** 控制器要执行的三件真事（window.ts 里绑真窗口；单测里是假件） */
export interface CloseControllerActions {
  /** 收进托盘（窗口留着：不 close、不 destroy，webContents 与后台任务都在） */
  hide: () => void
  quit: () => void
  /** 弹三选一（ask 档）；抛错 = 弹不出来，按取消处理（保留窗口，绝不误退） */
  prompt: () => Promise<ClosePromptResult>
  /** 记下"以后就按这个来"（只有明确选择 + 勾选时调；写 settings，失败抛给控制器记日志） */
  rememberChoice: (mode: RememberedCloseMode) => void
}

export interface CloseControllerOptions {
  /** 当前偏好（现读设置——用户中途改过、弹窗刚勾过"记住"都以落盘为准） */
  mode: () => CloseToTrayMode
  actions: CloseControllerActions
  /** 注入点（单测用）；缺省 = 运行平台 / 模块级退出与托盘状态 */
  platform?: NodeJS.Platform
  isQuitting?: () => boolean
  trayAvailable?: () => boolean
  /**
   * allow 分支的额外守卫（M3-S5 退出确认）：返回 true = 已接管（它自己 preventDefault、
   * 稍后异步放行或保持窗口），调用方不要再放行。**只在 allow 分支执行**——hide（收进托盘）
   * 不销毁窗口、内容还在内存里，不需要问；prompt 分支自己会弹原生框。
   * 缺省 = `index.ts` 通过 `registerCloseAllowGuard` 注册的那一个（单测可直接注入这里）。
   */
  allowGuard?: CloseAllowGuard
}

/** close 事件只要这么一点面（Electron 的 Event 天然满足） */
export interface WindowCloseEvent {
  preventDefault: () => void
}

/**
 * "真要关窗/退出"之前的额外守卫（M3-S5 退出确认）：
 * 返回 true = 已接管（它自己 `preventDefault()`，稍后由壳的退出确认结果决定放行还是保持窗口）。
 *
 * 为什么只有 allow 分支有、hide 分支没有：收进托盘**不销毁窗口**（webContents / iframe /
 * 未保存内容都还活着，随时能从托盘回来保存），没有"丢数据"的可能，也就不该弹保存框；
 * prompt 分支自己会弹原生三选一。只有 allow = 窗口真的要销毁 → 才需要先问壳。
 *
 * 用注册表而不是构造参数接线：注册方是 `index.ts`（guard 用 webContents / BrowserWindow
 * 定位窗口），window.ts 完全不需要知道 S5 的存在；与上面的 `registerTrayAvailability` 同风格。
 */
export type CloseAllowGuard = (event: WindowCloseEvent) => boolean

/** 模块级注册的 allow 守卫（index.ts 注册；缺省 null = 不拦截，保持 0.1.3 原行为） */
let registeredAllowGuard: CloseAllowGuard | null = null

export function registerCloseAllowGuard(guard: CloseAllowGuard | null): void {
  registeredAllowGuard = guard
}

export interface CloseController {
  /** 挂在窗口的 close 事件上；判定为拦下时先 preventDefault，再异步收尾 */
  handleClose: (event: WindowCloseEvent) => void
}

export function createCloseController(options: CloseControllerOptions): CloseController {
  const platform = options.platform ?? process.platform
  const quittingNow = options.isQuitting ?? isQuitting
  const trayOk = options.trayAvailable ?? isTrayAvailable
  /** 弹窗在飞：期间的重复 close（用户连点、程序性关闭）只拦不重复弹 */
  let prompting = false

  const applyPromptResult = (result: ClosePromptResult): void => {
    // 弹窗期间应用可能已经开始真退出（托盘退出 / 系统结束会话）：这次选择（连同"记住"）作废
    if (quittingNow()) return
    // 弹窗期间托盘失效（对象被销毁 / 探针翻 false）："收进托盘"已经无处可收 —— 按取消处理：
    // 保留窗口、也**不**记偏好（绝不能把"以后都收进托盘"写进设置，更不能藏到没有入口的后台）。
    // 必须在 rememberChoice **之前**判：勾了"记住"也不落盘。用户选「退出 kyclaw」不受影响
    // （退出不需要托盘，照常走）。
    if (result.choice === 'tray' && !trayOk()) {
      console.warn('[kyclaw] 托盘在弹窗期间失效：这次按取消处理（保留窗口，也不记偏好）')
      return
    }
    if (result.choice !== 'cancel' && result.remember) {
      try {
        options.actions.rememberChoice(result.choice)
      } catch (error) {
        // 写盘失败：这次的选择照常生效，但**不能**冒充"已记住"（下次还会问）
        console.warn('[kyclaw] 记住关闭偏好失败（这次的选择照常生效，下次还会再问）', error)
      }
    }
    try {
      if (result.choice === 'quit') options.actions.quit()
      else if (result.choice === 'tray') options.actions.hide()
      // cancel：窗口保持原样（不关、不藏）
    } catch (error) {
      console.warn('[kyclaw] 关闭动作执行失败（窗口保持原样）', error)
    }
  }

  /**
   * 弹一次提示（同步发起——close 事件那一刻就弹；异步只体现在等用户选择）。
   * `prompt()` 自己同步抛（少见）时翻成拒绝，统一走下面的"按取消处理"。
   */
  const promptOnce = (): Promise<ClosePromptResult> => {
    try {
      return options.actions.prompt()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const askOnce = (): void => {
    if (prompting) return
    prompting = true
    promptOnce()
      .then(applyPromptResult)
      .catch((error: unknown) => {
        // 弹不出来当取消：窗口保持打开（比"默默退出 / 默默藏起来"都安全），也不写任何偏好
        console.warn('[kyclaw] 关闭提示弹不出来，按取消处理（窗口保持打开）', error)
      })
      .finally(() => {
        prompting = false
      })
  }

  return {
    handleClose: (event) => {
      const decision = decideClose({
        platform,
        isQuitting: quittingNow(),
        // 现问现答：托盘对象后来失效（isDestroyed）会立刻反映到这一次判定里
        trayAvailable: trayOk(),
        // 偏好也是现读：设置页刚改过 / 上一次勾了"记住"立刻生效
        mode: options.mode()
      })
      if (decision.kind === 'allow') {
        // M3-S5：真退出 / 真关窗之前的最后一道守卫（有未保存文档 → 拦下先问壳）。
        // 优先用构造参数（单测注入），否则用 index.ts 注册的那一个；没注册 = 不拦截（原行为）。
        const allowGuard = options.allowGuard ?? registeredAllowGuard
        if (allowGuard !== null && allowGuard(event)) return
        return
      }
      event.preventDefault()
      if (decision.kind === 'hide') {
        options.actions.hide()
        return
      }
      askOnce()
    }
  }
}
