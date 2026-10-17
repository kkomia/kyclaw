/**
 * 会话运行态（010）："哪些会话正在跑（submitted / streaming）"的轻量表 —— 侧栏灰圈的唯一数据源。
 *
 * 谁写：`features/chat/thread-chats.ts` 在常驻 Chat 实例就绪时挂 `~registerStatusCallback`
 * （@ai-sdk/react@4.0.140 的状态订阅回调；SDK 的 status setter 在值没变时直接返回，所以
 * 只在 submitted / streaming / ready / error **跳变**时来 —— 正文逐 token 走的是 messages 回调，
 * 不经过这里："侧栏不跟着打字栅格化"是订阅面的性质，不是本 store 的自觉）。
 * 谁读：SessionsController / ProjectsSection 订阅后转成 Set 传给 SessionList（两个分组的每一行
 * 共用同一槽位——灰圈盖在完成点那个位置）。
 *
 * 为什么不并进 sessions-store：sessions-store 依赖 thread-chats（删除会话要 dropThreadChat），
 * 而 thread-chats 要写这里 —— 放进去就成环。这一枚**谁都不依赖**，只被写、被读。
 *
 * 写入纪律：值没变时**原样返回旧 state**（zustand 不再通知订阅者）—— 同一会话的
 * submitted → streaming 不算跳变，不会白刷一遍侧栏。
 */
import { create } from 'zustand'

export interface ThreadRunState {
  /** 正在跑的会话：只存 true；没在跑的不进表（`running[id] !== true` 即"不在跑"） */
  running: Record<string, true>
  /** 写入（thread-chats 的状态订阅调；测试与组件接线也走它）。值没变不产生新对象、不通知 */
  setRunning: (threadId: string, running: boolean) => void
}

export const useThreadRunStore = create<ThreadRunState>()((set) => ({
  running: {},

  setRunning: (threadId, running) => {
    set((state) => {
      if ((state.running[threadId] === true) === running) return state
      if (running) return { running: { ...state.running, [threadId]: true } }
      const next = { ...state.running }
      delete next[threadId]
      return { running: next }
    })
  }
}))

/** 测试用：清空运行态（模块级 store 不随 render 重置；`resetThreadChats` 也会把它扫一遍） */
export function resetThreadRunStore(): void {
  useThreadRunStore.setState({ running: {} })
}
