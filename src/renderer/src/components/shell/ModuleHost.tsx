import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { ChatPage } from '@renderer/features/chat/ChatPage'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { primaryModuleOf } from '@renderer/lib/primary-modules'

/**
 * 一级模块宿主（0.2.0 应用壳）：主对话常驻，模块切换只换可见性、不卸载。
 *
 * 为什么主对话要常驻：输入草稿、附件、滚动位置、对话/轨迹页签都挂在 ChatPage 的组件树里，
 * 按路由换挂会把它们一起丢掉。**第一次进入主对话之后**，ChatPage 就一直占着同一格，切到别的
 * 页面只换可见性（`hidden + inert`；display:none 不会清掉滚动位置，inert 也把它从键盘/读屏里摘掉）。
 * 直接深链进 /notes 时不预先挂一整屏聊天（只初始化会话列表），避免后台白跑一轮端点与历史回灌。
 *
 * 非聊天页面走 Outlet：笔记/知识库/Office 目前是占位页，互相切换时卸载重挂没有状态可丢；
 * 主对话是唯一需要跨页面保活的页面。**这里永远只有一个 ChatPage 实例**——`/chat` 路由本身
 * 不渲染页面（element = null），由宿主统一挂载，避免出现第二个聊天。
 *
 * W7（2026-10-17）：设置 / 插件 / 记忆 / 用量也挪进本宿主（见 App.tsx）。它们不是一级模块，
 * `primaryModuleOf` 返回 null ⇒ chatActive=false ⇒ ChatPage 保持 hidden+inert、页面由 Outlet 渲染；
 * 这样"主对话输入草稿 → 打开设置 → 回主对话"草稿还在（此前路由在宿主之外，一进设置宿主被卸载）。
 *
 * sessions-store 的初始化也提到宿主上：直接深链进 /notes 时，二级栏与对话页都还没被用户打开，
 * 但主对话的 activeId 必须先落位（会话动作、Ctrl+K、返回主对话都依赖它）。
 */
export function ModuleHost(): React.JSX.Element {
  const pathname = useLocation().pathname
  const active = primaryModuleOf(pathname)
  const chatActive = active === 'chat'
  const [chatMounted, setChatMounted] = useState(chatActive)
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)

  // 第一次进入主对话后要"锁存"常驻：在 render 期条件派生 state（React 文档的
  // "adjusting state when props change" 用法），不放进 effect —— effect 里同步 setState 会多一帧
  // 空白、也会触发 react-hooks/set-state-in-effect。条件成立的那一轮 React 会当场重渲染，
  // 本帧后面几行仍按旧值取 `chatMounted || chatActive`，所以第一次进对话这一帧就挂上 ChatPage。
  if (chatActive && !chatMounted) setChatMounted(true)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  // keepChat：进过一次对话之后就一直在（切模块只换可见性、不卸载）
  const keepChat = chatMounted || chatActive

  return (
    <div data-testid="module-host" className="flex min-h-0 flex-1 flex-col">
      {keepChat ? (
        <div
          data-testid="module-chat"
          data-active={chatActive ? 'true' : 'false'}
          aria-hidden={chatActive ? undefined : true}
          inert={!chatActive}
          className={chatActive ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <ChatPage />
        </div>
      ) : null}
      <div
        data-testid="module-outlet"
        className={chatActive ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
      >
        <Outlet />
      </div>
    </div>
  )
}
