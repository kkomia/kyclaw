import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// M3-S3：编辑器样式（组件级，类名都在 .oox-root 下，不污染别的页面）+ 面自己的整页骨架。
// CSS 由 Vite 构建成 assets/*.css，经 kyclaw-office://surface/ 同源加载（协议 MIME 已覆盖）。
//
// A1（Office UI 改版）：面也 import 主界面的**同一套 token**（原样层 + 语义层），这样
// `--doc-canvas-bg` / `--doc-page-bg` 等与 shell 单源；深色靠 `html[data-theme]` 切档
// （SurfaceBoot 的 applySurfaceTheme 同时写 data-theme 与 data-surface-theme）。
// P0 设计语言（2026-10-18）：identity（Claude `--k-*` 身份层）必须**先于** semantic.css ——
// 语义层只写 `var(--k-*)` 别名，面内缺 identity 就会丢色；motion.css 给面内 chrome 的角色
// 动效令牌（A4 状态栏/之后 P3 对齐读它），一并前置。顺序：identity → motion → kimi → semantic。
// token CSS 是纯自定义属性声明（+ data-font-size 档），不含组件样式，不会污染内核。
import '../styles/tokens/identity.css'
import '../styles/tokens/motion.css'
import '../styles/tokens/kimi-tokens.css'
import '../styles/tokens/semantic.css'
import '@betteroffice/docx-react/styles.css'
import './surface.css'
// A2：面内自绘 chrome（QAT + 5 tab + 工具带 + 折叠）；只消费 token，不另建颜色
import './office-chrome.css'
// A4：保存态换词动效与 shell 状态栏共用同一份 CSS（150ms + 新词晚 50ms + reduced-motion）
import './office-save-swap.css'
import { SurfaceBoot } from './SurfaceBoot'

// M3-S3：office 隔离面的渲染入口（第二个 HTML 入口，见 electron.vite.config.ts）。
//
// 内核（DocxEditor + 字体）只在 `doc:open` 之后由 SurfaceBoot 按需加载/挂载；
// 面没有 preload、拿不到 window.kyclaw，字节与消息只经 postMessage。
// 不引 tailwind.css：隔离面不继承主界面样式（只借 token，不借 utility 样式）。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SurfaceBoot />
  </StrictMode>
)
