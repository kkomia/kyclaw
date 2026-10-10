import './styles/tailwind.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './lib/settings-store'
import { initTheme } from './lib/theme'

// 先落默认外观（跟系统 + 默认字号），再异步读落盘设置覆盖 —— 中间不留白屏/闪色
initTheme()
void useSettingsStore.getState().load()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
