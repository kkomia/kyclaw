// P0 产品设计语言的三层 token：identity（Claude 保底色板，`--k-*`）与 motion（动效角色令牌）
// 必须**先于** tailwind.css 引入 —— tailwind.css 里的 semantic.css 只写 `var(--k-*)` 别名，
// 身份层缺席就会丢色；动效角色令牌给新组件用，隔离面入口也按同一顺序引。
import './styles/tokens/identity.css'
import './styles/tokens/motion.css'
import './styles/tailwind.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './lib/settings-store'
import { advanceStartupSplash, failStartupSplash } from './lib/startup-splash'
import { startupMark } from './lib/startup-timing'
import { initTheme } from './lib/theme'

// 冷启动打点的第一笔 —— 渲染端 bundle 开始执行（整条链见 lib/startup-timing.ts）
startupMark('渲染端入口')
// 阶段百分比的真实事件：bundle 已加载并开始执行（不是按时间猜的百分比）
advanceStartupSplash('renderer-entry')

// 先落默认外观（跟系统 + 默认字号），再异步读落盘设置覆盖 —— 中间不留白屏/闪色
initTheme()
void useSettingsStore
  .getState()
  .load()
  .finally(() => {
    // 设置读盘有结果（成功，或失败后回默认值）再记录这一阶段；不回来的话就停在上一格。
    // 晚于 React 首屏提交也不会丢：百分比不倒退，启动壳还在时会显示“设置已就绪”。
    advanceStartupSplash('settings-loaded')
  })

// 首屏在 App 的 layout effect 之前抛错（渲染期错误）时，让启动壳停在失败态。
// 正常提交 / 已退场时 failStartupSplash 是空操作。
function start(): void {
  createRoot(document.getElementById('root')!, {
    onUncaughtError: (error) => {
      console.error('[kyclaw] 首屏渲染失败', error)
      failStartupSplash()
    }
  }).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

start()
