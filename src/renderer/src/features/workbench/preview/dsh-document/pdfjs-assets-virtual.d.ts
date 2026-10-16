/**
 * 构建期虚拟模块 `virtual:kyclaw-pdfjs-assets` 的类型面。
 *
 * 实现是 `pdfjs-inline-assets-plugin.ts`（由 `electron.vite.config.ts` 装进渲染端构建）；
 * 声明单独放在这份 `.d.ts` 里 —— 在模块文件里写 `declare module` 会变成"模块增补"而不是环境声明。
 * 表里的值是**懒加载器**：调用它才会去 `import()` 那个资源对应的分块（base64 文本）。
 */
declare module 'virtual:kyclaw-pdfjs-assets' {
  /** pdf.js 的预定义 CMap：文件名 → base64 文本的懒加载器 */
  export const CMAP_FILES: Record<string, () => Promise<string>>
  /** pdf.js 的标准字体数据：文件名 → base64 文本的懒加载器 */
  export const FONT_FILES: Record<string, () => Promise<string>>
}
