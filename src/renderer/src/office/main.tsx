import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// M3-S0：office 隔离面的渲染入口（第二个 HTML 入口，见 electron.vite.config.ts 的
// renderer.build.rollupOptions.input）。**故意不 import @betteroffice/** —— 这一步只验
// “入口能构建、面能启动”，编辑器内核接线在 S1/S2（.superpowers/handover/office-docx-plan.md §9）。
// 这里也不引 tailwind.css：隔离面不继承主界面样式，编辑器自己的 CSS 到 S1 再引。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>office surface boot</h1>
      <p style={{ fontSize: 13, opacity: 0.72, marginTop: 8 }}>
        kyclaw · DOCX 隔离面（M3-S0 空壳，未接编辑器）
      </p>
    </main>
  </StrictMode>
)
