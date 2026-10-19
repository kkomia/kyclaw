import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  KernelApprovalRespondOutcome,
  KernelApprovalResult,
  KernelInteractionSnapshot,
  KernelQuestionAnswer
} from '@shared/kernel-interactions'
import {
  KernelInteractionError,
  fetchKernelInteractions,
  isStaleInteractionError,
  respondKernelApproval,
  respondKernelQuestion
} from './kernel-interactions-api'

/**
 * PB-026：内核交互快照 + 应答（renderer 唯一写入口）。
 *
 * 刷新策略（Bao 契约：先按需 GET，暂无 SSE）：
 *   - 挂载/换会话/enabled 变 → 拉一次；
 *   - `active`（本轮在跑）期间每 2s 拉一次——审批/提问在 turn 内到达，没有 SSE 时只能靠轮询；
 *   - 窗口 focus → 拉一次；
 *   - 每次应答成功 → 拉一次（以服务端快照为准，不本地猜状态）。
 *
 * 错误口径：409/404 = 已处理/已过期 → 提示 + 刷新，不重试；其它错误保留挂起卡、显示可重试错误。
 */
const POLL_INTERVAL_MS = 2_000

export interface KernelInteractionsState {
  snapshot: KernelInteractionSnapshot | null
  error: string | null
  notice: string | null
  submittingEventId: string | null
  refresh: () => Promise<void>
  respondApproval: (eventId: string, outcome: KernelApprovalRespondOutcome) => Promise<void>
  respondQuestion: (eventId: string, answers: readonly KernelQuestionAnswer[]) => Promise<void>
  clearNotice: () => void
}

export function useKernelInteractions(options: {
  threadId: string
  enabled: boolean
  /** 本会话是否在跑（submitted/streaming）：只在跑的时候轮询 */
  active: boolean
}): KernelInteractionsState {
  const { threadId, enabled, active } = options
  const [snapshot, setSnapshot] = useState<KernelInteractionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submittingEventId, setSubmittingEventId] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) return
    try {
      const next = await fetchKernelInteractions(threadId)
      if (!alive.current) return
      setSnapshot(next)
      setError(null)
    } catch (cause) {
      if (!alive.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [enabled, threadId])

  useEffect(() => {
    // disabled 时不发请求；消费方（ChatPage）只在 kernelMode+真会话下渲染本 hook 的结果。
    // 写成 promise 回调里的 setState（effect 里同步 setState 会踩 react-hooks/set-state-in-effect）。
    if (!enabled) return
    let cancelled = false
    void fetchKernelInteractions(threadId).then(
      (next) => {
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, threadId])

  useEffect(() => {
    if (!enabled || !active) return
    const timer = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, active, refresh])

  useEffect(() => {
    if (!enabled) return
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, refresh])

  const respond = useCallback(
    async (eventId: string, action: () => Promise<unknown>): Promise<void> => {
      setSubmittingEventId(eventId)
      setError(null)
      setNotice(null)
      try {
        await action()
        await refresh()
      } catch (cause) {
        // Bao 2231395：409 带终态 → 直接把结果行并入快照，不再拉一次；
        // result=null（decided 还没到）才刷新。
        if (
          cause instanceof KernelInteractionError &&
          cause.code === 'already-settled' &&
          cause.result !== null
        ) {
          const result: KernelApprovalResult = cause.result
          setSnapshot((previous) =>
            previous === null
              ? previous
              : {
                  ...previous,
                  approvals: {
                    ...previous.approvals,
                    results: [
                      ...previous.approvals.results.filter((item) => item.id !== result.id),
                      result
                    ]
                  }
                }
          )
          setNotice('这次审批已在别处处理，结果已显示在消息流。')
        } else if (isStaleInteractionError(cause)) {
          setNotice('这次交互已在别处处理（或已过期），已为你刷新最新状态。')
          await refresh()
        } else {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (alive.current) setSubmittingEventId(null)
      }
    },
    [refresh]
  )

  const respondApproval = useCallback(
    (eventId: string, outcome: KernelApprovalRespondOutcome): Promise<void> =>
      respond(eventId, () => respondKernelApproval(eventId, outcome)),
    [respond]
  )

  const respondQuestion = useCallback(
    (eventId: string, answers: readonly KernelQuestionAnswer[]): Promise<void> =>
      respond(eventId, () => respondKernelQuestion(eventId, answers)),
    [respond]
  )

  return {
    snapshot,
    error,
    notice,
    submittingEventId,
    refresh,
    respondApproval,
    respondQuestion,
    clearNotice: () => setNotice(null)
  }
}
