import { useLayoutEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/shell/AppShell'
import { advanceStartupSplash, dismissStartupSplash } from './lib/startup-splash'
import { startupMark } from './lib/startup-timing'
import { ChatPage } from './features/chat/ChatPage'
import { MemoryPage } from './features/memory/MemoryPage'
import { PluginsPage } from './features/plugins/PluginsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { UsagePage } from './features/usage/UsagePage'

/**
 * 路由表：壳是布局路由（element 不带 path），主列的 <Outlet/> 渲染子路由内容。
 * 页面路由：聊天 / 设置（按栏目）/ 插件（round 5 新入口）/ 记忆 / 用量（standalone 直达保留，
 * 不进任何菜单——设置里已有同样的真实内容）+ 根路径/未知路径统一落到 /chat（主列永远有内容）。
 */
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/settings/:section?" element={<SettingsPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/usage" element={<UsagePage />} />
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
