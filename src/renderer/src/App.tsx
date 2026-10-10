import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/shell/AppShell'
import { ChatPage } from './features/chat/ChatPage'
import { MemoryPage } from './features/memory/MemoryPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { UsagePage } from './features/usage/UsagePage'

/**
 * 路由表：壳是布局路由（element 不带 path），主列的 <Outlet/> 渲染子路由内容。
 * 四条页面路由（设置页按栏目 /settings/:section，不带栏目落到默认栏）+ 根路径/未知路径统一落到 /chat
 * （主列永远有内容）。
 */
export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/settings/:section?" element={<SettingsPage />} />
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
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}

export default App
