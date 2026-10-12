import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { RecallStatusLine } from '@renderer/features/settings/RecallSettings'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { clearMemory, fetchMemory, saveMemory } from '@renderer/lib/memory-api'

/**
 * 记忆面板（T14 起；round 5 从页面里拆出；round 58 起按会话隔离）：working memory 的查看 / 编辑 / 清空。
 *
 * **记忆跟着会话走**（round 58，用户口径：开几个会话就是为了隔离上下文）：作用域是 thread，
 * 一个会话一份 —— 这里读写的都是**当前活动会话**那一份：切会话自动重拉，保存/清空也写它。
 * 草稿会话（还没落库、不在会话列表里）按"没有会话"处理：不请求，也不给编辑入口。
 *
 * 显示复用聊天里的 markdown 渲染（TextPart）：记忆内容本来就是 markdown（标题 + 列表），
 * 两处渲染同一套样式，不再抄一份 markdown 组件配置。编辑是纯文本域——模板口径是整块替换，
 * 所见即所存，不做字段级编辑。
 *
 * 状态机（与 ChatSession 同款）：拉取结果与它对应的 key 一起存，重试 = key+1，
 * 不在 effect 里同步 setState 清场。round 58 起 key = `<会话 id>#<重试次数>`：
 * 换会话就是换 key，上一次的结果自然"过时"（不匹配）；编辑草稿同样记着它属于哪个会话，
 * 切走后自动作废，不必手动清。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 当前会话 id：只认**服务端已经认识的会话**（草稿还没落库，服务端那边没有它的记忆行）。
 * null = 没有可看的会话（草稿 / 还没载入列表），页面按空态处理。
 */
function useActiveThreadId(): string | null {
  return useSessionsStore((state) =>
    state.activeId !== null && state.threads.some((thread) => thread.id === state.activeId)
      ? state.activeId
      : null
  )
}

export function MemoryPanel(): React.JSX.Element {
  const threadId = useActiveThreadId()
  const [resolveKey, setResolveKey] = useState(0)
  const [state, setState] = useState<{
    key: string
    content: string | null
    error: Error | null
  } | null>(null)
  /**
   * 非 null = 编辑中（值就是草稿）。草稿**跟着会话走**：记着它属于哪个会话，
   * 切走后自然"不匹配"（不用 effect 清场，也不会把上一个会话的草稿写进新会话）。
   */
  const [draft, setDraft] = useState<{ threadId: string; value: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  /** 这次拉取的身份：会话 + 重试次数（换会话或重试都让上一次的结果作废） */
  const loadKey = `${threadId ?? ''}#${resolveKey}`

  useEffect(() => {
    // 没有会话（草稿 / 列表还没到）：不发请求，直接空态
    if (threadId === null) return undefined
    let alive = true
    fetchMemory(threadId).then(
      (content) => {
        if (alive) setState({ key: loadKey, content, error: null })
      },
      (cause: unknown) => {
        if (alive) setState({ key: loadKey, content: null, error: toError(cause) })
      }
    )
    return () => {
      alive = false
    }
  }, [loadKey, threadId])

  const current = state !== null && state.key === loadKey ? state : null
  /** 当前会话的编辑草稿（别的会话留下的草稿不算数） */
  const editing = draft !== null && draft.threadId === threadId ? draft.value : null

  const applyContent = useCallback(
    (content: string | null) => {
      setState({ key: loadKey, content, error: null })
      setDraft(null)
    },
    [loadKey]
  )

  const save = useCallback((): void => {
    if (editing === null || threadId === null) return
    setBusy(true)
    setActionError(null)
    saveMemory(threadId, editing).then(
      // 服务端归一后的内容才是真相（全空白会回 null）
      (saved) => {
        setBusy(false)
        applyContent(saved)
      },
      (cause: unknown) => {
        setBusy(false)
        setActionError(toError(cause).message) // 留在编辑态，草稿不丢
      }
    )
  }, [applyContent, editing, threadId])

  const clear = useCallback((): void => {
    if (threadId === null) return
    setConfirmClear(false)
    setBusy(true)
    setActionError(null)
    clearMemory(threadId).then(
      () => {
        setBusy(false)
        applyContent(null)
      },
      (cause: unknown) => {
        setBusy(false)
        setActionError(toError(cause).message)
      }
    )
  }, [applyContent, threadId])

  const content = current?.content ?? null

  // 没有活动会话（草稿 / 列表还没到）：服务端那边没有可看可写的记忆 —— 空态，不发请求
  if (threadId === null) {
    return (
      <div data-testid="memory-card" className="flex flex-col gap-4 rounded-panel bg-secondary p-4">
        <div data-testid="memory-content">
          <p data-testid="memory-empty" className="text-b2 text-ink-secondary">
            还没有记忆：告诉助手值得长期记住的信息，它会记在这里。
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      {current === null ? (
        <div
          data-testid="memory-loading"
          className="flex flex-col gap-3 rounded-panel bg-secondary p-4"
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : current.error !== null ? (
        <div
          data-testid="memory-error"
          role="alert"
          className="flex flex-col items-start gap-3 rounded-panel bg-secondary p-4"
        >
          <p className="text-b2 text-ink-secondary">{current.error.message}</p>
          <Button
            size="sm"
            variant="ghost"
            data-testid="memory-retry"
            onClick={() => setResolveKey((key) => key + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        <div
          key={loadKey}
          data-testid="memory-card"
          className="animate-fade-in flex flex-col gap-4 rounded-panel bg-secondary p-4"
        >
          {editing === null ? (
            <>
              <div data-testid="memory-content">
                {content === null ? (
                  <p data-testid="memory-empty" className="text-b2 text-ink-secondary">
                    还没有记忆：告诉助手值得长期记住的信息，它会记在这里。
                  </p>
                ) : (
                  <TextPart text={content} />
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="memory-edit"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null)
                    setDraft({ threadId, value: content ?? '' })
                  }}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="memory-clear"
                  disabled={busy || content === null}
                  onClick={() => setConfirmClear(true)}
                >
                  清空
                </Button>
              </div>
            </>
          ) : (
            <>
              <Textarea
                data-testid="memory-input"
                aria-label="记忆内容"
                className="min-h-40"
                // 上限与 shared/memory 的 schema 一致（超了服务端也 400，这里先挡住）
                maxLength={20000}
                value={editing}
                disabled={busy}
                onChange={(event) => setDraft({ threadId, value: event.target.value })}
              />
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="memory-cancel"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null)
                    setActionError(null)
                  }}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  data-testid="memory-save"
                  loading={busy}
                  onClick={() => void save()}
                >
                  保存
                </Button>
              </div>
            </>
          )}

          {actionError === null ? null : (
            <p data-testid="memory-action-error" className="text-c1 text-danger">
              {actionError}
            </p>
          )}
        </div>
      )}

      {/* 清空是不可逆动作：受控确认框（R12 口径），确认后才发 DELETE */}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空记忆？"
        description="清空后助手不再记得这些内容；已有的对话不受影响。"
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="memory-clear-cancel"
              onClick={() => setConfirmClear(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="memory-clear-confirm"
              onClick={() => void clear()}
            >
              清空
            </Button>
          </>
        }
      />
    </>
  )
}

/**
 * 记忆页（独立路由 /memory）：页级容器 + 标题 + 面板。
 * 面板本体（MemoryPanel）同时被设置页「记忆」栏复用（round 5 去重：弹层不再有第二入口，
 * 设置为唯一导航源）——所以内容与交互都装在面板里，页面只是它的壳。
 * round 58：两个入口看到的都是**当前会话**的记忆（面板自己认活动会话，页面不必管）。
 */
export function MemoryPage(): React.JSX.Element {
  return (
    // round 23：外层全宽滚动容器（滚动条贴窗口右缘）+ 内层限宽内容列（口径不变）
    <section
      data-testid="memory-page"
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div data-testid="memory-page-column" className="content-column flex flex-col gap-6 p-6">
        <h1 className="text-t1 font-medium text-ink">记忆</h1>
        {/* round 28：语义召回的本次运行状态（开关与嵌入来源在「设置 → 记忆」里） */}
        <RecallStatusLine />
        <MemoryPanel />
      </div>
    </section>
  )
}
