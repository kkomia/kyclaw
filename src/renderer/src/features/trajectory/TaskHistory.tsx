import { useEffect, useState } from 'react'
import type { TaskHistory as History } from '@shared/tasks'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { fetchTaskHistory } from '@renderer/lib/tasks-api'
import { projectTaskSnapshot } from '../chat/task-history'
import { Button } from '@renderer/components/ui/button'

export function TaskHistory({
  threadId,
  active,
  revision,
  representedRevisions
}: {
  threadId: string
  active: boolean
  revision: string
  representedRevisions: ReadonlySet<number>
}): React.JSX.Element | null {
  const [token, setToken] = useState(0)
  const [result, setResult] = useState<{
    threadId: string
    history: History | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    fetchTaskHistory(threadId).then(
      (history) => {
        if (alive) setResult({ threadId, history, error: null })
      },
      (cause: unknown) => {
        // 0.2.1（PB-053 泛化）：/api/tasks 是本版主动下架（501），不是"加载失败"：
        // 不显示错误行、不加重试（重试永远失败），任务历史这块直接不出现。
        if (alive) {
          const unavailable = isFeatureDisabledError(cause)
          setResult({
            threadId,
            history: null,
            error: unavailable ? null : '任务历史加载失败，请重试'
          })
        }
      }
    )
    return () => {
      alive = false
    }
  }, [threadId, active, revision, token])
  if (!result || result.threadId !== threadId) return null
  if (result.error)
    return (
      <div className="px-4 py-1 text-c1 text-warning" role="alert">
        {result.error}
        <Button size="sm" variant="ghost" onClick={() => setToken((value) => value + 1)}>
          重试任务历史
        </Button>
      </div>
    )
  const entries =
    result.history?.revisions.filter((entry) => !representedRevisions.has(entry.revision)) ?? []
  if (!entries.length) return null
  return (
    <details className="mx-4 my-1 max-h-40 shrink-0 overflow-y-auto text-c1 text-ink-secondary">
      <summary className="cursor-pointer">
        任务历史（{entries.length} 个未在工具行展示的版本）
      </summary>
      <ul className="space-y-1 py-1">
        {entries.map((entry) => {
          const projection = projectTaskSnapshot(entry.snapshot)
          return (
            <li key={entry.revision} className="[overflow-wrap:anywhere]">
              历史版本 {entry.revision} · {projection?.summary} ·{' '}
              {entry.origin === 'tool' ? '工具更新' : '用户更新'}
              <ul className="pl-3">
                {projection?.items.map((item) => (
                  <li key={item.id}>
                    {item.title} · {item.statusLabel}
                    {item.note ? ` · ${item.note}` : ''}
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
