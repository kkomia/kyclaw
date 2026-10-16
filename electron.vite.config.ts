import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { createPdfjsInlineAssetsPlugin } from './src/renderer/src/features/workbench/preview/dsh-document/pdfjs-inline-assets-plugin'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      /**
       * pdf.js 的本地资源（预定义 CMap / 标准字体）**内联进懒加载的 JS 分块**。
       *
       * 为什么必须内联：pdf.js 取这两样走自己的 `fetchData`，而打包态渲染端是 `file://`，
       * Chromium 默认拦 file:// 的 fetch/XHR —— 那样没有内嵌字体的中文 PDF **整页画不出来**。
       * 懒分块的 `import()` 在打包态本来就在跑（产物里已有十几个懒块），所以资源以 base64
       * 落进独立分块、随用随取：不放宽 CSP、不加协议、不联网。
       *
       * 路径是**点明的那一条**：`node_modules/pdfjs-dist`（插件只读它的 `cmaps/` 与
       * `standard_fonts/` 两层目录，不递归、按扩展名过滤、有单文件与总量上限）。
       * 资源表本身由 `dsh-document/pdf-assets.ts` 交给 pdf.js 的 `BinaryDataFactory`。
       */
      createPdfjsInlineAssetsPlugin({ root: resolve('node_modules/pdfjs-dist') })
    ]
  }
})
