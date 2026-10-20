/**
 * 轨迹取数与投影（渲染端的唯一入口）。
 *
 * 四样原料并行取（都是幂等读，互不依赖）：
 *   - 存储消息原文 —— 步骤、时刻、工具入参结果都从这里来；**唯一必得的一条腿**；
 *   - 该会话的逐轮用量行 —— "这一轮 token 花在哪"；
 *   - 压缩记录 —— 「已压缩」那一条；
 *   - 逐次模型请求的摘要（round 87）—— 「系统 / 上下文」几行（系统指令长度 / 消息条数 / 工具件数，
 *     一步一步；正文在明细面板里按需取）。
 *
 * ## 一条硬腿、三条软腿（round 87 / 用户反馈 017）
 *
 * 以前四条腿绑成一份 `Promise.all`：**任何一条**失败（用量接口回 500 也算）整页就只剩一行
 * 错误 + 重试，消息原文明明已经在手里也看不到。现在：
 *   - **消息腿失败 = 真错误**（`error`）：没有它就没有轨迹，界面给错误 + 重试；
 *   - 用量腿 / 压缩腿 / 请求快照腿失败 = **降级**：照样出轨迹（rows / turns / 时间轴全不依赖
 *     用量；`model.ts` 对缺失的用量与快照一律 null-safe，缺了就留白），只在顶上多一行
 *     非致命提示（`usageError`）+ 重试。
 *
 * 口径：
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
import type { TrajectoryRequestSummary, TrajectoryUsageRun } from '@shared/trajectory'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { fetchThreadCompaction, fetchThreadMessages } from '@renderer/lib/threads-api'
import { fetchThreadRequestSummaries, fetchThreadUsageRuns } from '@renderer/lib/trajectory-api'
import { buildTrajectory, type TrajectoryDoc } from './model'

export interface TrajectoryData {
  doc: TrajectoryDoc
  messages: StoredMessage[]
  usageRuns: TrajectoryUsageRun[]
  /** round 87：逐次模型请求的摘要（系统指令 / 上下文 / 工具账）；空数组 = 没记过（不报错） */
  requests: TrajectoryRequestSummary[]
  compaction: ThreadCompaction | null
  /** 首帧还没拿到数据（界面给"正在载入"）；后台重取不算 */
  loading: boolean
  /** 取数失败的人话（不静默：错误态给重试）——**只有消息腿失败**才进这里 */
  error: string | null
  /**
   * 非致命降级的人话（**软腿**失败）：界面给一行提示 + 重试，但轨迹照出。
   * 用量腿 / 压缩腿 / 请求快照腿都往这里写一句带原因的人话（哪条腿坏了看得出）。
   */
  usageError: string | null
  /** 重新取一遍（错误态与非致命提示的重试按钮都走它） */
  reload: () => void
}

interface Loaded {
  /** 这份数据属于哪条会话（会话 id 变了就不认——虽然调用方按会话重挂，这里仍守一道） */
  threadId: string
  messages: StoredMessage[]
  usageRuns: TrajectoryUsageRun[]
  requests: TrajectoryRequestSummary[]
  compaction: ThreadCompaction | null
  error: string | null
  usageError: string | null
}

/** 空原料的稳定引用（避免每次渲染新建数组，把下游 memo 全部打穿） */
const NO_MESSAGES: StoredMessage[] = []
const NO_USAGE: TrajectoryUsageRun[] = []
const NO_SNAPSHOTS: TrajectoryRequestSummary[] = []

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 软腿失败的人话：哪条腿 + 为什么（服务端的人话经 trajectory-api 带出来） */
function degrade(label: string, lose: string, cause: unknown): string {
  return `${label}未取到（${toMessage(cause)}）· ${lose}`
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
    /** 软腿：自己吞掉异常，回一句"没取到"的人话（不牵连整页） */
    const soft = async <T>(
      label: string,
      lose: string,
      load: () => Promise<T>,
      fallback: T
    ): Promise<{ value: T; notice: string | null }> => {
      try {
        return { value: await load(), notice: null }
      } catch (cause) {
        // 0.2.1（PB-053 泛化）：本版**主动下架**的接口（/api/trajectory、/api/usage 等回 501）
        // 不是"取数失败"。轨迹照出、不提示、不重试——这是本版没有的能力，不该在界面上报错。
        if (isFeatureDisabledError(cause)) return { value: fallback, notice: null }
        return { value: fallback, notice: degrade(label, lose, cause) }
      }
    }

    void fetchThreadMessages(threadId).then(
      async (messages) => {
        const [usageRuns, compaction, requests] = await Promise.all([
          soft('用量', '本轮 token 不显示', () => fetchThreadUsageRuns(threadId), NO_USAGE),
          soft('压缩记录', '「已压缩」那条不显示', () => fetchThreadCompaction(threadId), null),
          soft(
            '请求快照',
            '「系统 / 上下文」几行不显示',
            () => fetchThreadRequestSummaries(threadId),
            NO_SNAPSHOTS
          )
        ])
        if (!alive) return
        const notices = [usageRuns.notice, compaction.notice, requests.notice].filter(
          (notice): notice is string => notice !== null
        )
        setLoaded({
          threadId,
          messages,
          usageRuns: usageRuns.value,
          requests: requests.value,
          compaction: compaction.value,
          error: null,
          usageError: notices.length === 0 ? null : notices.join('；')
        })
      },
      (cause: unknown) => {
        // **只有消息腿失败才进错误态**（其余三条腿的失败只降级，见文件头注）
        if (!alive) return
        setLoaded({
          threadId,
          messages: [],
          usageRuns: [],
          requests: [],
          compaction: null,
          error: toMessage(cause),
          usageError: null
        })
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
  const requests = current?.requests ?? NO_SNAPSHOTS
  const compaction = current?.compaction ?? null

  const doc = useMemo(
    () => buildTrajectory({ messages, usageRuns, compaction, requests }),
    [compaction, messages, requests, usageRuns]
  )

  return {
    doc,
    messages,
    usageRuns,
    requests,
    compaction,
    loading: active && current === null,
    error: current?.error ?? null,
    usageError: current?.usageError ?? null,
    reload
  }
}
