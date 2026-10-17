/**
 * chat 顶部右侧的状态 mascot（设计稿 §5.2 / D-32）。
 *
 * 为什么在这里**推导**状态而不是从 ChatPage 传 prop：本任务的写域只有 ChatHeader 与
 * features/brand（ChatPage 不在写域），所以状态从两个**已有的稳定可观察信号**来：
 *   1. `thread-run-store`（010 起就是"哪些会话在跑"的单一数据源；submitted/streaming = true）；
 *   2. 消息区里正在运行的工具卡 `[data-testid="tool-card"][data-state="input-available|input-streaming"]`
 *      （ToolCard 的既有 DOM 契约；仅有审批卡挂起时按"等用户"算 think）。
 * 映射（设计稿 §5.2）：idle → idle；跑着（无工具在跑）→ think；有工具在跑 → type；
 * 本轮结束后 **1.2s** 回 idle。合并规则：同屏只一只、用户在等审批时显示 think（不是 type）。
 *
 * 后续若允许动 ChatPage：更干净的做法是 ChatPage 直接传 `activity` prop（消息/状态都在它手里），
 * 这个 hook 可整段删除 —— 见实现报告「与设计规范的差异 / 迁移建议」。
 *
 * React 纪律：不在 effect 体内同步 setState（本项目 react-hooks/set-state-in-effect 是 error）——
 * 状态派生走 render 期条件更新（React 文档认可的 adjust-state-during-render），effect 只做订阅
 * 与定时器。
 */
import { useEffect, useState } from 'react'
import { useThreadRunStore } from '@renderer/features/chat/thread-run-store'
import type { ChatMascotState } from './otter-states'

/** 工具"正在跑"的 DOM 判据（input-available = 调用了还没回执；input-streaming = 参数还在流） */
const RUNNING_TOOL_SELECTOR =
  '[data-testid="tool-card"][data-state="input-available"], [data-testid="tool-card"][data-state="input-streaming"]'
/** 等用户处理的挂起交互：这时不是"干活"，显示 think */
const WAITING_INTERACTION_SELECTOR =
  '[data-testid="approval-card"], [data-testid="ask-user-card"], [data-testid="plan-approval-dock"]'

function hasRunningTool(): boolean {
  if (typeof document === 'undefined') return false
  if (document.querySelector(WAITING_INTERACTION_SELECTOR) !== null) return false
  return document.querySelector(RUNNING_TOOL_SELECTOR) !== null
}

/** busy 结束后回落 idle 的延迟（设计稿 §5.2：1.2s） */
export const MASCOT_IDLE_FALLBACK_MS = 1200

export function useChatMascotState(threadId: string): ChatMascotState {
  const running = useThreadRunStore((state) => state.running[threadId] === true)
  const [toolRunning, setToolRunning] = useState(false)
  const [shown, setShown] = useState<ChatMascotState>('idle')

  // 跑完立刻清工具态（render 期派生，不等 effect —— 避免"停了一帧还显示 type"）
  if (!running && toolRunning) setToolRunning(false)

  const active: ChatMascotState = running ? (toolRunning ? 'type' : 'think') : 'idle'

  // 只在这一轮在跑时观察工具卡 DOM；busy 结束就断开（回落计时见下）
  useEffect(() => {
    if (!running) return
    const inspect = (): void => setToolRunning(hasRunningTool())
    inspect()
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(inspect)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state']
    })
    return () => observer.disconnect()
  }, [running])

  // 跑起来时立即切 think/type（render 期派生）；idle 的回落由下面的 1.2s 定时器负责
  if (active !== 'idle' && shown !== active) setShown(active)

  useEffect(() => {
    if (active !== 'idle') return
    // 这一轮刚结束：再保持 think/type 1.2s 才回 idle（不让状态灯"啪"一下灭）
    const timer = setTimeout(() => setShown('idle'), MASCOT_IDLE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [active])

  return shown
}
