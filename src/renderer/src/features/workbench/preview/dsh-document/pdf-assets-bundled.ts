/**
 * 构建期内联资源表这一层的**薄适配**：把 `virtual:kyclaw-pdfjs-assets`（`CMAP_FILES` /
 * `FONT_FILES` 两张"文件名 → base64 懒加载器"的记录）翻成 `pdf-assets.ts` 认的 `Map`。
 *
 * 生成方是 `pdfjs-inline-assets-plugin.ts`（装 `electron.vite.config.ts` 上）：它在构建期读
 * `node_modules/pdfjs-dist/{cmaps,standard_fonts}`，把每个文件写成 base64 的独立懒分块。
 * 所以这里**没有逻辑**，只有形状转换 —— 也正因为依赖那个构建期虚拟模块，它**不进 barrel**
 * （`index.ts`），免得别处 import 本目录时解析失败；单测里要那份表就喂 `localPdfAssets(假表)`
 * （见 `pdf-assets.spec.ts`），真字节由 `pdfjs-inline-assets-plugin.spec.ts` 对着磁盘验。
 */
import { CMAP_FILES, FONT_FILES } from 'virtual:kyclaw-pdfjs-assets'
import type { PdfAssetTables } from './pdf-assets'

/**
 * 构建期内联的两张表。
 * @returns pdf.js 那两类资源各自的"文件名 → base64 懒加载器"。
 */
export function pdfAssetTables(): PdfAssetTables {
  return {
    cMapUrl: new Map(Object.entries(CMAP_FILES)),
    standardFontDataUrl: new Map(Object.entries(FONT_FILES))
  }
}
