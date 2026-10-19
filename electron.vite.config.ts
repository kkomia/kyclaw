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
    ],
    /**
     * M3-S3（dev 修复）：`@betteroffice/*` 内核**不能被 Vite dev 预打包**。
     *
     * 它们按 wasm-bindgen / 资产清单的惯例用 `new URL('../assets/*.wasm|ttf', import.meta.url)`
     * 定位二进制；esbuild 预打包不会改写这种 URL，dev 下会落到 Vite 的 SPA 兜底页（HTML），
     * 表现为 `WebAssembly.compile(): expected magic word ... found 3c 21 64 6f` / 字体字节数不对。
     * 让它们走 dev 的源码转换管线（Vite 会重写成 `/@fs/...` 真文件 URL）即可；构建态由 Rollup
     * 处理同一语法，本来就没问题（preview/打包不受这条影响）。
     *
     * M4-X：XLSX 内核同属 `@betteroffice/*`，`new URL('./generated/xlsx_wasm_bg.wasm',
     * import.meta.url)` 同样不能进 esbuild 预打包 —— 一并 exclude（否则 dev 打开 xlsx 报
     * `expected magic word ... found 3c 21 64 6f`）。
     * M4-P：PPTX 同口径（`pptx_wasm_bg.wasm` 5,395,943 B），三包一并 exclude。
     */
    optimizeDeps: {
      exclude: [
        '@betteroffice/docx',
        '@betteroffice/docx-react',
        '@betteroffice/docx/layout',
        '@betteroffice/fonts',
        '@betteroffice/fonts-cjk',
        '@betteroffice/xlsx',
        '@betteroffice/xlsx-react',
        '@betteroffice/xlsx-i18n',
        '@betteroffice/pptx',
        '@betteroffice/pptx-react',
        '@betteroffice/pptx-i18n'
        // 注意（2026-10-18 最终 build 回归结论）：新增/升级 @betteroffice 包后必须重启 dev，
        // 或删除 node_modules/.vite（旧 dev server 的预打包模块图会让 pptx/xlsx wasm 的
        // new URL(...) 落到 Vite SPA 兜底 HTML，出现 expected magic word 00 61 73 6d）。
      ]
    },
    // 0.2.0 Office 面（M3-S0）：渲染端多入口 —— 主界面 index.html + 隔离的 office.html。
    // 两个入口各自成页；office 面以后由 kyclaw-office:// 协议加载（见 S1）。
    build: {
      /**
       * task-98 验收 P2：**字体资产不内联**。
       * Vite 默认把 <4KB 的资产内联成 data: URI；KaTeX_Size3-Regular.woff2（3,624 B）就是这样
       * 进了主 renderer 的 CSS。主页面是 `src/renderer/index.html`，其 CSP 只有 `default-src 'self'`
       * 且没显式 `font-src` → data:font 被兜底规则拦下，`page.reload()` 后 console 出现 2 条
       * 「Loading the font 'data:font/woff2;base64,…' violates … default-src 'self'」。
       * 这里让字体文件一律走**同源文件 URL**（`'self'` 本来就被 CSP 允许），既不放宽 CSP、
       * 也不改主页面（index.html 与海獭换装并行，归 office-surface-dev）；
       * 非字体小资产仍按 Vite 默认内联。
       */
      assetsInlineLimit: (filePath: string): boolean | undefined =>
        /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          office: resolve('src/renderer/office.html')
        }
      }
    }
  }
})
