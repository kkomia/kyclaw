/**
 * 轨迹取数与投影（渲染端的唯一入口）。
 *
 * 三样原料并行取（都是幂等读，互不依赖）：
 *   - 存储消息原文 —— 步骤、时刻、工具入参结果都从这里来；
 *   - 该会话的逐轮用量行 —— "这一轮 token 花在哪"；
 *   - 压缩记录 —— 「已压缩」那一条。
 *
 * 三条口径：
 *   1. **懒取**：`active` 为 false（用户还在对话页签）时一个请求都不发；
 *   2. **每次切到轨迹页都重取一遍**（`active` 参与取数 key）——轨迹是对已落库事实的投影，
 *      便宜又幂等；不重取的话"刚跑完一轮再切过去"会看到旧的那份；
 *   3. **重取时不清空**（旧数据留在屏上直到新数据到）——切页签不该闪一下空白。
 *      首帧真没数据时才是 `loading`。
 *
 * 流式期间**不刷新**：每一步还没落成 part，这里拿不到也就不编（一轮结束由 `revision` 触发）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoredMessage, ThreadCompaction } from '@shared/threads'
import type { TrajectoryUsageRun } from '@shared/trajectory'
import { fetchThreadCompaction, fetchThreadMessages } from '@renderer/lib/threads-api'
import { fetchThreadUsageRuns } from '@renderer/lib/trajectory-api'
import { buildTrajectory, type TrajectoryDoc } from './model'

export interface TrajectoryData {
  doc: TrajectoryDoc
  messages: StoredMessage[]
  usageRuns: TrajectoryUsageRun[]
  compaction: ThreadCompaction | null
  /** 首帧还没拿到数据（界面给"正在载入"）；后台重取不算 */
  loading: boolean
  /** 取数失败的人话（不静默：错误态给重试） */
  error: string | null
  /** 重新取一遍（错误态的重试按钮走它） */
  reload: () => void
}

interface Loaded {
  /** 这份数据属于哪条会话（会话 id 变了就不认——虽然调用方按会话重挂，这里仍守一道） */
  threadId: string
  messages: StoredMessage[]
  usageRuns: TrajectoryUsageRun[]
  compaction: ThreadCompaction | null
  error: string | null
}

/** 空原料的稳定引用（避免每次渲染新建数组，把下游 memo 全部打穿） */
const NO_MESSAGES: StoredMessage[] = []
const NO_USAGE: TrajectoryUsageRun[] = []

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export interface UseTrajectoryDataOptions {
  threadId: string
  /** 用户当前在轨迹页签（false = 不取数） */
  active: boolean
  /** 取数信号：变了就重取（父组件在一轮结束时把它换一个值，例如会话行的 updatedAt） */
  revision?: string
}

export function useTrajectoryData(options: UseTrajectoryDataOptions): TrajectoryData {
  const { threadId, active, revision = '' } = options
  const [reloadToken, setReloadToken] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!active) return
    let alive = true
    Promise.all([
      fetchThreadMessages(threadId),
      fetchThreadUsageRuns(threadId),
      fetchThreadCompaction(threadId)
    ]).then(
      ([messages, usageRuns, compaction]) => {
        if (alive) setLoaded({ threadId, messages, usageRuns, compaction, error: null })
      },
      (cause: unknown) => {
        if (alive) {
          setLoaded({
            threadId,
            messages: [],
            usageRuns: [],
            compaction: null,
            error: toMessage(cause)
          })
        }
      }
    )
    return () => {
      alive = false
    }
  }, [active, reloadToken, revision, threadId])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  const current = loaded !== null && loaded.threadId === threadId ? loaded : null
  const messages = current?.messages ?? NO_MESSAGES
  const usageRuns = current?.usageRuns ?? NO_USAGE
  const compaction = current?.compaction ?? null

  const doc = useMemo(
    () => buildTrajectory({ messages, usageRuns, compaction }),
    [compaction, messages, usageRuns]
  )

  return {
    doc,
    messages,
    usageRuns,
    compaction,
    loading: active && current === null,
    error: current?.error ?? null,
    reload
  }
}
