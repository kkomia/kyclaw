import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { ChatPage } from '@renderer/features/chat/ChatPage'
import { OfficePage } from '@renderer/features/office/OfficePage'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { primaryModuleOf } from '@renderer/lib/primary-modules'

/**
 * 一级模块宿主（0.2.0 应用壳）：主对话与 Office 常驻，模块切换只换可见性、不卸载。
 *
 * 为什么主对话要常驻：输入草稿、附件、滚动位置、对话/轨迹页签都挂在 ChatPage 的组件树里，
 * 按路由换挂会把它们一起丢掉。**第一次进入主对话之后**，ChatPage 就一直占着同一格，切到别的
 * 页面只换可见性（`hidden + inert`；display:none 不会清掉滚动位置，inert 也把它从键盘/读屏里摘掉）。
 * 直接深链进 /notes 时不预先挂一整屏聊天（只初始化会话列表），避免后台白跑一轮端点与历史回灌。
 *
 * M3-S4：**Office 也常驻**（同款 `hidden + inert` 锁存）。Office 那棵树里挂着 Document 隔离面的
 * iframe、面内 DocxEditor 的 wasm 堆、每个标签的未保存修改与滚动位置——按路由卸载等于把用户
 * 正在编辑的文档全部丢掉。`/office` 路由元素因此改成 `null`，页面只在**第一次进 Office** 时挂载
 * （不拖慢冷启动，与聊天同口径）。
 *
 * 笔记 / 知识库 / 设置等仍走 Outlet：它们是纯只读/表单页，没有需要跨路由保活的编辑态。
 * **本宿主永远只有一个 ChatPage / 一个 OfficePage 实例**——对应路由本身不渲染页面（element = null），
 * 由宿主统一挂载，避免出现第二实例。
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
  const officeActive = active === 'office'
  const [chatMounted, setChatMounted] = useState(chatActive)
  const [officeMounted, setOfficeMounted] = useState(officeActive)
  const ensureLoaded = useSessionsStore((state) => state.ensureLoaded)

  // 第一次进入主对话/Office 后要"锁存"常驻：在 render 期条件派生 state（React 文档的
  // "adjusting state when props change" 用法），不放进 effect —— effect 里同步 setState 会多一帧
  // 空白、也会触发 react-hooks/set-state-in-effect。条件成立的那一轮 React 会当场重渲染，
  // 本帧后面几行仍按旧值取 `xxxMounted || xxxActive`，所以第一次进这一帧就挂上页面。
  if (chatActive && !chatMounted) setChatMounted(true)
  if (officeActive && !officeMounted) setOfficeMounted(true)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  // keepChat / keepOffice：进过一次之后就一直在（切模块只换可见性、不卸载）
  const keepChat = chatMounted || chatActive
  const keepOffice = officeMounted || officeActive

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
      {keepOffice ? (
        <div
          data-testid="module-office"
          data-active={officeActive ? 'true' : 'false'}
          aria-hidden={officeActive ? undefined : true}
          inert={!officeActive}
          className={officeActive ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
        >
          <OfficePage active={officeActive} />
        </div>
      ) : null}
      <div
        data-testid="module-outlet"
        className={chatActive || officeActive ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
      >
        <Outlet />
      </div>
    </div>
  )
}
