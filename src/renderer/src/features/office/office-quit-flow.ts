/**
 * 退出确认的壳侧**纯逻辑**（M3-S5-2）：保存全部流程 + 壳内"退出请求"状态。
 *
 * 分工（主进程 plumbing 见 `src/main/office-quit.ts`，契约见 `s5-main-report.md` §7）：
 *   - 主进程只在"真退出 / 真关窗 + 有未保存文档"时向壳推 `office:quit-request`；
 *   - 壳收到后弹三态对话框（`OfficeQuitDialog`）：保存全部 / 放弃修改 / 取消；
 *   - **保存全部 = 按 store 顺序逐个 `saveOfficeTab(tab)` 串行**（不并发：同时 generate 会叠加
 *     wasm 内存，S4 报告 §10 已点名）；任一失败就停在失败项、回 `cancelled`（不假装成功）；
 *   - 用户放弃 → `discarded`；取消 → `cancelled`（主进程看到 cancelled 就保持窗口不动）。
 *
 * 本文件不 import React / 不直接调 preload（保存动作与回包都由调用方注入），单测直接驱动。
 * 唯一的"状态"是 `useOfficeQuitStore`：主进程推来的那条待决请求（AppShell 据此条件渲染对话框，
 * AppTabBar 据此避让标签级脏三态 —— 两个对话框互斥，S4 报告 §10 的建议）。
 */
import { create } from 'zustand'
import type { OfficeQuitAction, OfficeQuitRequestPayload } from '@shared/office-editor'
import type { OfficeTab } from './office-tabs-store'

/** 一次保存全部的过程量（对话框显示"正在保存 2/3：方案.docx"） */
export interface QuitFlowProgress {
  /** 已完成的保存数（当前要保存的这一项之前完成了多少） */
  done: number
  /** 本次要保存的总数（只算"脏且非只读"的标签） */
  total: number
  /** 正在保存的标签 id / 标题（全部完成时缺省） */
  currentId?: string
  currentTitle?: string
}

/** 保存失败的那一项（停在这里，不继续后面的；也不自动放弃） */
export interface QuitFlowFailure {
  id: string
  title: string
  /** 给用户看的人话（不吞错误细节） */
  message: string
}

/** 退出三态在壳侧的决策结果（与主进程 `saved | discarded | cancelled` 一一对应） */
export type QuitOutcome =
  { result: 'saved' } | { result: 'discarded' } | { result: 'cancelled'; failure?: QuitFlowFailure }

/** 决策 → 回包给主进程的动作（`office:quit-result` 的 action） */
export function officeQuitActionOf(outcome: QuitOutcome): OfficeQuitAction {
  return outcome.result
}

/**
 * 本次退出要保存哪些标签：**脏且非只读**，顺序 = store 里的标签顺序（用户看到的顺序）。
 * 只读标签不可能有未保存修改（编辑器只读直通，保存按钮不启用）；即便投影脏了也不去保存它
 * （主进程会按 write-locked / readonly 拒掉，反而把退出卡死）。
 */
export function quitSaveTargets(tabs: readonly OfficeTab[]): OfficeTab[] {
  return tabs.filter((tab) => tab.dirty && !tab.readOnly)
}

export interface SaveAllBeforeQuitOptions {
  /** 当前标签列表（顺序即保存顺序） */
  tabs: readonly OfficeTab[]
  /** 保存一个标签的运行时（壳里 = office-actions 的 saveOfficeTab）；返回是否写盘/commit 成功 */
  saveTab: (tab: OfficeTab) => Promise<boolean>
  /** 进度事件（每开始一项一次 + 全部完成一次） */
  onProgress?: (progress: QuitFlowProgress) => void
}

/**
 * 串行保存全部脏标签。
 *   - 全成功 → `{ result: 'saved' }`；
 *   - 任一项返回 false / 抛错 → **停在失败项**，`{ result: 'cancelled', failure }`（后面的不再保存）。
 * 不在这里改 store 的 dirty（由 save-machine 的保存成功 commit 驱动）；调用方据此决定是否清请求。
 */
export async function saveAllBeforeQuit(options: SaveAllBeforeQuitOptions): Promise<QuitOutcome> {
  const targets = quitSaveTargets(options.tabs)
  const total = targets.length
  for (let index = 0; index < total; index += 1) {
    const tab = targets[index]
    if (tab === undefined) continue
    options.onProgress?.({
      done: index,
      total,
      currentId: tab.id,
      currentTitle: tab.title
    })
    let saved = false
    try {
      saved = await options.saveTab(tab)
    } catch {
      saved = false
    }
    if (!saved) {
      return {
        result: 'cancelled',
        failure: {
          id: tab.id,
          title: tab.title,
          message: `「${tab.title}」保存失败，修改还在编辑器里——可以重试、放弃修改或取消退出`
        }
      }
    }
  }
  options.onProgress?.({ done: total, total })
  return { result: 'saved' }
}

/** 用户点「放弃修改」（直接执行；退出框不叠第二层确认） */
export function discardQuitOutcome(): QuitOutcome {
  return { result: 'discarded' }
}

/** 用户取消（或 Esc / 点蒙层） */
export function cancelQuitOutcome(failure?: QuitFlowFailure): QuitOutcome {
  return failure === undefined ? { result: 'cancelled' } : { result: 'cancelled', failure }
}

export interface OfficeQuitState {
  /** 主进程推来的待决退出请求；null = 没有退出确认在飞 */
  request: OfficeQuitRequestPayload | null
  setRequest: (request: OfficeQuitRequestPayload | null) => void
}

/**
 * 壳内退出请求（**唯一来源**）：
 *   - `useOfficeDirtyReporter()` 订阅 preload 的 `onQuitRequest` 后写进来；
 *   - `AppShell` 据此条件渲染 `OfficeQuitDialog`；
 *   - `AppTabBar` 据此避让标签级脏三态（两框互斥）；`isOfficeQuitInFlight()` 是同一件事的命令式读法。
 */
export const useOfficeQuitStore = create<OfficeQuitState>()((set) => ({
  request: null,
  setRequest: (request) => set({ request })
}))

/** 当前待决请求（命令式；事件处理里用） */
export function pendingOfficeQuitRequest(): OfficeQuitRequestPayload | null {
  return useOfficeQuitStore.getState().request
}

export function setPendingOfficeQuitRequest(request: OfficeQuitRequestPayload | null): void {
  useOfficeQuitStore.getState().setRequest(request)
}

/** 退出确认流程是否在进行（对话框开着 / 正在保存）：标签级脏三态与快捷键据此避让 */
export function isOfficeQuitInFlight(): boolean {
  return useOfficeQuitStore.getState().request !== null
}

/** 测试用：回到初始状态（模块级 store 不随 render 重置） */
export function resetOfficeQuitFlowForTest(): void {
  useOfficeQuitStore.setState({ request: null })
}
