/**
 * 一次请求的正文（按需取）：明细面板选中「系统 / 上下文 / 失败」那类行时才发这一条请求。
 *
 * 为什么按需：一条请求实测 ~96 KB（3 条 system 1.4 万字 + 35 件工具 8.1 万字），一轮里还有好几步
 * —— 列表把它们全背上，长会话的轨迹页会一次拖几十 MB。列表只拿摘要（计数与状态），
 * 正文点开哪条取哪条（`GET /api/trajectory/requests/detail?id=`）。
 *
 * 口径：
 *   - `id` 为 null（普通行）不发请求；
 *   - 取回来的行**带 id 与取数轮次**：id 变了（换行）或点了重试（轮次变了）就自然回到"载入中"，
 *     不会把甲请求的正文显示在乙请求上（不用在 effect 里同步清状态）；
 *   - 失败是**这一条腿自己的**事：回一句人话 + 重试，不牵连轨迹的其它部分。
 */
import { useCallback, useEffect, useState } from 'react'
import type { TrajectoryRequestDetail } from '@shared/trajectory'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { fetchRequestDetail } from '@renderer/lib/trajectory-api'

export interface RequestDetailState {
  detail: TrajectoryRequestDetail | null
  loading: boolean
  error: string | null
  reload: () => void
}

interface LoadedDetail {
  id: string
  /** 取数轮次（重试 +1）：旧轮次的回包不认 */
  token: number
  detail: TrajectoryRequestDetail | null
  error: string | null
}

export function useRequestDetail(id: string | null): RequestDetailState {
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<LoadedDetail | null>(null)

  useEffect(() => {
    if (id === null) return
    let alive = true
    const token = reloadToken
    void fetchRequestDetail(id).then(
      (detail) => {
        if (alive) setState({ id, token, detail, error: null })
      },
      (cause: unknown) => {
        // 0.2.1（PB-053 泛化）：请求快照接口本版主动下架（501）→ 不是"取正文失败"，
        // 不显示错误行；面板空着即可（列表那几行本来也不会出现）。
        const message = isFeatureDisabledError(cause)
          ? null
          : cause instanceof Error
            ? cause.message
            : String(cause)
        if (alive) setState({ id, token, detail: null, error: message })
      }
    )
    return () => {
      alive = false
    }
  }, [id, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  if (id === null) return { detail: null, loading: false, error: null, reload }
  const current = state !== null && state.id === id && state.token === reloadToken ? state : null
  return {
    detail: current?.detail ?? null,
    // 首帧（含换行、重试刚点下去的那一帧）都是载入态：不显示上一条的正文
    loading: current === null,
    error: current?.error ?? null,
    reload
  }
}
