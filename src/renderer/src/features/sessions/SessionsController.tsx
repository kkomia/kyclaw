import { useEffect, useMemo } from 'react'
import { Button } from '../../components/ui/button'
import { NewSessionButton } from './NewSessionButton'
import { SessionList } from './SessionList'
import { useSessionsStore } from './sessions-store'

/**
 * 侧栏会话区（T9）：把 sessions-store 接到 SessionList / NewSessionButton 上。
 *
 * 两件事在这里做：
 *   1. 首屏拉一次会话列表（与对话页共用 ensureLoaded，重复调用会去重）；
 *   2. 维护"当前生效的列表"：服务端列表之外，如果活跃会话还是个**草稿**
 *      （新建了还没发过消息），在最上面补一条"新会话"——否则点完新建侧栏毫无反馈。
 *
 * 列表加载失败不炸侧栏：错误行 + 重试（R11 的"顶部状态条"是后续任务，这里先就地）。
 */
export function SessionsController(): React.JSX.Element {
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)
  const refresh = useSessionsStore((state) => state.refresh)
  const threads = useSessionsStore((state) => state.threads)
  const activeId = useSessionsStore((state) => state.activeId)
  const notices = useSessionsStore((state) => state.notices)
  const error = useSessionsStore((state) => state.error)
  const select = useSessionsStore((state) => state.select)
  const startNew = useSessionsStore((state) => state.startNew)
  const remove = useSessionsStore((state) => state.remove)
  const rename = useSessionsStore((state) => state.rename)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const sessions = useMemo(() => {
    const isDraft = activeId !== null && !threads.some((thread) => thread.id === activeId)
    if (!isDraft) return threads
    return [
      { id: activeId, title: null, updatedAt: new Date().toISOString(), draft: true },
      ...threads
    ]
  }, [threads, activeId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewSessionButton onNew={startNew} />
      {error !== null ? (
        <p data-testid="session-load-error" className="px-4 pb-1 text-c1 text-danger">
          会话列表加载失败
          <Button
            size="sm"
            variant="ghost"
            data-testid="session-load-retry"
            className="ml-1"
            onClick={() => {
              void refresh()
            }}
          >
            重试
          </Button>
        </p>
      ) : null}
      <SessionList
        sessions={sessions}
        activeId={activeId}
        notices={notices}
        onSelect={select}
        onRename={(threadId, title) => {
          void rename(threadId, title)
        }}
        onDelete={(threadId) => {
          void remove(threadId)
        }}
      />
    </div>
  )
}
