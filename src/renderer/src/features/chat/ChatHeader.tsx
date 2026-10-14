import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Segmented } from '@renderer/components/ui/segmented'
import { SessionActionsMenu } from '@renderer/features/sessions/SessionActionsMenu'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'

/**
 * 对话页顶部栏（round 24）：
 *   - **背景与 chat 不做区分**（无独立底色、无分隔线、无卡片描边），高 40px（h-10）；
 *   - 左上角 = 当前对话名称（文本 + chevron，图2 样式：hover 灰底、无描边的文字按钮），
 *     点击展开**与侧栏会话 ⋯ 同款**的菜单（SessionActionsMenu——同一份实现，动作后侧栏即时一致）；
 *   - 左缘与消息内容列对齐：本栏 pl-2(8px) + 标题按钮 px-2(8px) = 16px = 消息列内容的 pl-4；
 *   - 右端留给工作台开关（AppShell 在 ContentRegion 右上角的常驻按钮，正好落在这条带的右端——
 *     所以本栏 pr-14 让出走廊，标题与页签不钻到按钮底下）；
 *   - 不参与滚动（在消息滚动区之外）、不遮导览轨（轨道在消息区垂直居中，碰不到顶部这条）。
 *
 * round 26（可用性收口）：草稿（还没落成线程）与真实会话**同一份菜单与可用性**——
 * 置顶/归档/移至项目先物化（sessions-store.materialize）再执行，重命名/删除就地做；
 * 草稿名显示本地标题（draftTitles）或"新会话"占位。不再有"草稿只给静态标题"。
 *
 * 轨迹页签（本轮）：头部右侧是「对话 / 轨迹」的分段切换，标题可收缩并让出工作台按钮走廊 —— 轨迹是**并列的一等视图**，
 * 不是藏在抽屉里的面板；切换由 `ChatSession` 持有状态（它与页签、两块内容同层），
 * 这里只负责画与回调。两个 prop 都是可选的：不给就只画标题（旧的调用方与既有用例不受影响）。
 */
export type ChatView = 'chat' | 'trajectory'

export interface ChatHeaderProps {
  threadId: string
  /** 当前视图；与 `onViewChange` 一起给才画分段切换 */
  view?: ChatView
  onViewChange?: (view: ChatView) => void
}

/** 未命名会话的占位标题（与侧栏列表同口径） */
const UNTITLED = '新会话'

export function ChatHeader({ threadId, view, onViewChange }: ChatHeaderProps): React.JSX.Element {
  const listed = useSessionsStore((state) => state.threads.find((thread) => thread.id === threadId))
  // round 26：草稿的本地标题（就地重命名改的是它；此时服务端还没有这条线程）
  const draftTitle = useSessionsStore((state) => state.draftTitles[threadId])
  const title = listed?.title ?? draftTitle ?? null
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <header
        data-testid="chat-header"
        className="flex h-10 min-w-0 shrink-0 items-center gap-2 pr-14 pl-2"
      >
        <div className="min-w-0 flex-1">
          {/* round 26：草稿与真实会话一样给动作菜单（置顶/归档/移至项目先物化，重命名/删除就地做） */}
          <SessionActionsMenu
            threadId={threadId}
            title={title}
            align="start"
            onError={setError}
            trigger={
              // 图2：名称 + chevron 的文字按钮（hover / 展开铺灰底，**无描边**）
              <button
                type="button"
                data-testid="chat-title"
                className="inline-flex h-8 max-w-full min-w-0 items-center gap-1 rounded-control px-2 text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover data-[state=open]:bg-hover motion-reduce:transition-none"
              >
                <span className="truncate">{title ?? UNTITLED}</span>
                <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
              </button>
            }
          />
        </div>
        {/* 对话 / 轨迹：固定在头部右侧，避开工作台按钮走廊；标题占剩余空间并可收缩。 */}
        {view === undefined || onViewChange === undefined ? null : (
          <Segmented
            className="shrink-0"
            ariaLabel="对话视图"
            value={view}
            onChange={onViewChange}
            options={[
              { value: 'chat', label: '对话', testId: 'view-tab-chat' },
              { value: 'trajectory', label: '轨迹', testId: 'view-tab-trajectory' }
            ]}
          />
        )}
      </header>
      {error === null ? null : (
        <p data-testid="chat-header-error" className="px-4 pb-1 text-c1 text-danger">
          {error}
        </p>
      )}
    </>
  )
}
