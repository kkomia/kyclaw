import { useLayoutEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/shell/AppShell'
import { ModuleHost } from './components/shell/ModuleHost'
import { advanceStartupSplash, dismissStartupSplash } from './lib/startup-splash'
import { startupMark } from './lib/startup-timing'
import { KnowledgePage } from './features/knowledge/KnowledgePage'
import { MemoryPage } from './features/memory/MemoryPage'
import { NotesPage } from './features/notes/NotesPage'
import { OfficePage } from './features/office/OfficePage'
import { PluginsPage } from './features/plugins/PluginsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { UsagePage } from './features/usage/UsagePage'

/**
 * 路由表：壳是布局路由（element 不带 path），主列的 <Outlet/> 渲染子路由内容。
 * 页面路由：一级模块（主对话 / 笔记 / 知识库 / Office）/ 设置（按栏目）/ 插件（round 5 新入口）/
 * 记忆 / 用量（standalone 直达保留，不进任何菜单——设置里已有同样的真实内容）+
 * 根路径/未知路径统一落到 /chat（主列永远有内容）。
 *
 * 一级模块共用 ModuleHost：宿主自己挂常驻的 ChatPage，`/chat` 路由只是匹配用的空元素
 * （不能在这里再挂一个 ChatPage，否则会出现第二个聊天实例）。笔记 / 知识库 / Office 的
 * 页面元素由宿主里的 <Outlet/> 渲染。
 *
 * W7（设置往返丢草稿的根因修复）：设置 / 插件 / 记忆 / 用量四条路由原来挂在 ModuleHost **之外**，
 * 一进设置宿主（连同常驻 ChatPage）就被卸载，输入草稿/滚动/页签全丢。现在它们也进 ModuleHost：
 * 切过去时 ChatPage 只 hidden+inert，页面由宿主的 <Outlet/> 渲染。这四条不是一级模块
 * （primaryModuleOf 返回 null ⇒ chatActive=false），所以宿主不会把聊天当"当前页"显示。
 */
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route element={<ModuleHost />}>
          <Route path="/chat" element={null} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/office" element={<OfficePage />} />
          <Route path="/settings/:section?" element={<SettingsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/usage" element={<UsagePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  )
}

/**
 * 生产用 HashRouter：打包后渲染端跑在 file:// 上，history 式路径（BrowserRouter）
 * 在刷新/深链时不可靠，hash 路由不需要主进程配合改写 URL。
 */
function App(): React.JSX.Element {
  // layout effect 在 DOM 提交后、浏览器绘制前跑：记首屏提交，并只写到 80%。
  // 100% 与退场由 dismissStartupSplash 排到下一绘制之后（见 lib/startup-splash.ts），
  // 否则同一个 layout effect 里的 80 → 100 会只剩 100 被画出来。
  useLayoutEffect(() => {
    startupMark('首屏已提交')
    advanceStartupSplash('react-committed')
    dismissStartupSplash()
  }, [])

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}

export default App
