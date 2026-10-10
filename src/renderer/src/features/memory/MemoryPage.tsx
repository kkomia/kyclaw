import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { clearMemory, fetchMemory, saveMemory } from '@renderer/lib/memory-api'

/**
 * 记忆面板（T14 起；round 5 从页面里拆出）：working memory 的查看 / 编辑 / 清空。
 *
 * 记忆只有一份（resource 作用域，见 src/mastra/index.ts 的装配）：任何会话里助手更新的、
 * 这个页面读写的都是同一份——所以这里不需要选会话。
 *
 * 显示复用聊天里的 markdown 渲染（TextPart）：记忆内容本来就是 markdown（标题 + 列表），
 * 两处渲染同一套样式，不再抄一份 markdown 组件配置。编辑是纯文本域——模板口径是整块替换，
 * 所见即所存，不做字段级编辑。
 *
 * 状态机（与 ChatSession 同款）：拉取结果与它对应的 key 一起存，重试 = key+1，
 * 不在 effect 里同步 setState 清场。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function MemoryPanel(): React.JSX.Element {
  const [resolveKey, setResolveKey] = useState(0)
  const [state, setState] = useState<{
    key: number
    content: string | null
    error: Error | null
  } | null>(null)
  /** 非 null = 编辑中（值就是草稿） */
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    let alive = true
    fetchMemory().then(
      (content) => {
        if (alive) setState({ key: resolveKey, content, error: null })
      },
      (cause: unknown) => {
        if (alive) setState({ key: resolveKey, content: null, error: toError(cause) })
      }
    )
    return () => {
      alive = false
    }
  }, [resolveKey])

  const current = state !== null && state.key === resolveKey ? state : null

  const applyContent = useCallback(
    (content: string | null) => {
      setState({ key: resolveKey, content, error: null })
      setDraft(null)
    },
    [resolveKey]
  )

  const save = useCallback((): void => {
    if (draft === null) return
    setBusy(true)
    setActionError(null)
    saveMemory(draft).then(
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
  }, [applyContent, draft])

  const clear = useCallback((): void => {
    setConfirmClear(false)
    setBusy(true)
    setActionError(null)
    clearMemory().then(
      () => {
        setBusy(false)
        applyContent(null)
      },
      (cause: unknown) => {
        setBusy(false)
        setActionError(toError(cause).message)
      }
    )
  }, [applyContent])

  const content = current?.content ?? null

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
          key={resolveKey}
          data-testid="memory-card"
          className="animate-fade-in flex flex-col gap-4 rounded-panel bg-secondary p-4"
        >
          {draft === null ? (
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
                    setDraft(content ?? '')
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
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
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
 */
export function MemoryPage(): React.JSX.Element {
  return (
    <section
      data-testid="memory-page"
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
    >
      <h1 className="text-t1 font-medium text-ink">记忆</h1>
      <MemoryPanel />
    </section>
  )
}
