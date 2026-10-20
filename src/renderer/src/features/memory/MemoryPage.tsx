import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/input'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { RecallStatusLine } from '@renderer/features/settings/RecallSettings'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { isFeatureDisabledError } from '@renderer/lib/feature-disabled'
import { clearMemory, fetchMemory, saveMemory } from '@renderer/lib/memory-api'
import type { ThreadSummary } from '@shared/threads'

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
 *
 * 本轮（设置页重组，记忆合栏）：**两个入口，一份面板**——
 *   /memory 独立页（标题「记忆空间」）直接铺面板；设置页「记忆」栏里面板收进「记忆空间」弹窗
 *   （MemorySpaceEntry 打开，复用这里的 Dialog 组件），页面上不再平铺一份。
 *   两个入口看到的都是**当前活动会话**那一份（面板自己认会话，页面/弹窗都不管）。
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** 未命名会话的占位标题（与侧栏列表 / 会话动作菜单同一口径） */
const UNTITLED = '新会话'

/**
 * 当前活动会话：只认**服务端已经认识的会话**（草稿还没落库，服务端那边没有它的记忆行）。
 * null = 没有可看的会话（草稿 / 还没载入列表），页面与弹窗都按空态处理。
 * 返回的是列表里那条摘要本身（引用稳定），要看标题的地方顺带就有了。
 */
function useActiveThread(): ThreadSummary | null {
  return useSessionsStore((state) =>
    state.activeId === null
      ? null
      : (state.threads.find((thread) => thread.id === state.activeId) ?? null)
  )
}

export function MemoryPanel(): React.JSX.Element {
  const threadId = useActiveThread()?.id ?? null
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

  // 没有活动会话（草稿 / 列表还没到）：服务端那边没有可看可写的记忆 —— 空态，不发请求。
  // 与"有会话但还没记东西"分开说（`memory-no-session` / `memory-empty`）：这一档不是"记过又空"，
  // 而是压根没有那一份（记忆跟着会话走，草稿还不算服务端认识的会话）。
  if (threadId === null) {
    return (
      <div data-testid="memory-card" className="flex flex-col gap-4 rounded-panel bg-secondary p-4">
        <p data-testid="memory-no-session" className="text-b2 text-ink-secondary">
          当前没有会话：记忆跟着会话走，新建或打开一个会话后，这里才会有一份。
        </p>
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
        isFeatureDisabledError(current.error) ? (
          // 0.2.1（PB-053 泛化）：记忆接口 /api/memory 是 0.2.0 起**主动下架**（501），
          // 不是加载失败：不给红字/重试，只说一句中性的"本版暂不可用"。
          <div
            data-testid="memory-unavailable"
            className="rounded-panel bg-secondary p-4"
            role="status"
          >
            <p className="text-b2 text-ink-secondary">记忆查看与编辑本版暂不可用（0.2.x 恢复）。</p>
          </div>
        ) : (
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
        )
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
                  <p data-testid="memory-empty" className="font-serif text-b2 text-ink-secondary">
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
                {/* 清空是不可逆动作：受控确认框（R12 口径），确认后才发 DELETE。
                    「清空」这颗就是确认框的 trigger —— 关掉它时 Radix 把焦点还给它
                    （设置页那条路是"弹窗套弹窗"，没挂 trigger 的话焦点会掉到 body）。 */}
                <Dialog
                  trigger={
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="memory-clear"
                      disabled={busy || content === null}
                    >
                      清空
                    </Button>
                  }
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
    </>
  )
}

/**
 * 记忆空间入口（设置页「记忆」栏的第二块）：一行标签 + 一句说明 + 「查看记忆」按钮。
 *
 * 按钮就是弹窗的 trigger（Radix 的"关掉后把焦点还给触发元素"靠它：Esc / 点蒙层关掉之后
 * 焦点回到这颗按钮，不会掉到 body）。弹窗体里只有 MemoryPanel——标题只由弹窗给
 * （正文不再套一层标题，内外不重复），会话范围写在说明里（没有活动会话就不编标题，
 * 由面板自己说清"当前没有会话"）。
 *
 * 高度：记忆是一整块 markdown，几条就撑满屏 —— 正文区封顶 60vh 里面滚，弹窗本身不滚。
 */
export function MemorySpaceEntry(): React.JSX.Element {
  const thread = useActiveThread()

  return (
    <div data-testid="memory-space" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-b2 text-ink">记忆空间</span>
        <Dialog
          trigger={
            <Button size="sm" variant="ghost" data-testid="memory-space-open">
              查看记忆
            </Button>
          }
          title="记忆空间"
          // 会话范围明确到名字（没有活动会话时不给说明行，空态由面板那句说）
          description={
            thread === null
              ? undefined
              : `只显示「${thread.title ?? UNTITLED}」这一份记忆；切到别的会话就是另一份。`
          }
          size="md"
        >
          <DialogClose />
          <div data-testid="memory-space-body" className="max-h-[60vh] overflow-y-auto">
            <MemoryPanel />
          </div>
        </Dialog>
      </div>
      <p className="text-c1 text-ink-secondary">记忆跟着会话走，一个会话一份。</p>
    </div>
  )
}

/**
 * 记忆页（独立路由 /memory）：页级容器 + 标题 + 面板。
 * 面板本体（MemoryPanel）同时被设置页「记忆」栏的「记忆空间」弹窗复用（MemorySpaceEntry；
 * round 5 去重：设置为唯一导航源）——所以内容与交互都装在面板里，页面只是它的壳。
 * round 58：两个入口看到的都是**当前会话**的记忆（面板自己认活动会话，页面不必管）。
 * 本轮标题从「记忆」改成「记忆空间」，与设置页那一块同名（独立页保留、可直达）。
 */
export function MemoryPage(): React.JSX.Element {
  return (
    // round 23：外层全宽滚动容器（滚动条贴窗口右缘）+ 内层限宽内容列（口径不变）
    <section
      data-testid="memory-page"
      className="animate-page-in flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div data-testid="memory-page-column" className="content-column flex flex-col gap-6 p-6">
        <h1 className="text-t1 font-medium text-ink">记忆空间</h1>
        {/* round 28：语义召回的本次运行状态（开关与嵌入来源在「设置 → 记忆」里） */}
        <RecallStatusLine />
        <MemoryPanel />
      </div>
    </section>
  )
}
