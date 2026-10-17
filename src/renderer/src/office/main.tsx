import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// M3-S3：编辑器样式（组件级，类名都在 .oox-root 下，不污染别的页面）+ 面自己的整页骨架。
// CSS 由 Vite 构建成 assets/*.css，经 kyclaw-office://surface/ 同源加载（协议 MIME 已覆盖）。
import '@betteroffice/docx-react/styles.css'
import './surface.css'
import { SurfaceBoot } from './SurfaceBoot'

// M3-S3：office 隔离面的渲染入口（第二个 HTML 入口，见 electron.vite.config.ts）。
//
// 内核（DocxEditor + 字体）只在 `doc:open` 之后由 SurfaceBoot 按需加载/挂载；
// 面没有 preload、拿不到 window.kyclaw，字节与消息只经 postMessage。
// 不引 tailwind.css：隔离面不继承主界面样式。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SurfaceBoot />
  </StrictMode>
)
