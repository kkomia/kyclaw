import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SurfaceBoot } from './SurfaceBoot'

// M3-S1：office 隔离面的渲染入口（第二个 HTML 入口，见 electron.vite.config.ts 的
// renderer.build.rollupOptions.input）。
//
// **故意不 import @betteroffice/** —— 这一步只验"面能加载、能握手、CSP/wasm 口径正确"，
// 编辑器内核接线在 S2/S3（.superpowers/handover/office-docx-plan.md §9）。
// 这里也不引 tailwind.css：隔离面不继承主界面样式，编辑器自己的 CSS 到 S3 再引。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SurfaceBoot />
  </StrictMode>
)
