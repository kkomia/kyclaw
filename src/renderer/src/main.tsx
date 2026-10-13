import './styles/tailwind.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './lib/settings-store'
import { startupMark } from './lib/startup-timing'
import { initTheme } from './lib/theme'

// round 73：冷启动打点的第一笔 —— 渲染端 bundle 开始执行（整条链见 lib/startup-timing.ts）
startupMark('渲染端入口')

// 先落默认外观（跟系统 + 默认字号），再异步读落盘设置覆盖 —— 中间不留白屏/闪色
initTheme()
void useSettingsStore.getState().load()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
// 首屏（壳 + 空对话页）已提交渲染：React 的同步渲染在这里返回，DOM 已经出来了
startupMark('首屏已提交')
