/**
 * DSH 文档预览（PDF 阅读器 + Office 复用）—— 本目录是一个自洽单元：
 * 除了 React、本仓 `components/ui` 与既有的 `pdfjs-dist` 依赖，它不碰任何共享接线文件。
 *
 * 适配来源：deepseek-harness（MIT，commit 86a402200d95fecef4529d969836f1fe13c6cb0d，
 * 源码根 `packages/client/ui-sidebar-documentpreview/src/client/`）的 `pdf/`、`zoom/`、`office/`
 * 三块成熟展示实现 —— 逐文件对应关系写在各自文件头注里。**没有**引入它的插件框架 / 注册表 /
 * store / locale 座位，也没有搬 Office → PDF 的转换器（那条链路在主进程，用随包 LibreOffice kit）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## 对外两件东西
 *
 * - `DshPdfViewer`：**收一份 PDF 字节**，铺一整列可翻页的页面（适应宽度 / 缩放 / 按需页渲染 /
 *   文字选择复制 / 加载·错误·取消生命周期），窄侧栏与放大视图都能用。
 * - `DshOfficeViewer`：**收一个转换口**（Office 字节 → PDF 字节的异步函数），转换态自己的人话，
 *   拿到 PDF 后**复用同一个阅读器**。
 *
 * ## 接线契约（谁要用，必须满足）
 *
 * 1. **PDF 字节从哪来**：PDF 文件走现有 `workbench:read-bytes`（`FileBytesResult.kind === 'bytes'`
 *    且 `format === 'pdf'`），Office 转换后走宿主自己的通道。渲染端这里只要"完整字节"，
 *    不关心它从哪条 IPC 来。
 * 2. **容器要有确定高度**：滚动口在组件内部（`DshPdfViewer` 自己不带高度），宿主给 `h-full` 之类的
 *    高度，否则什么都滚不了。
 * 3. **字节数组实例要稳定**：阅读器按数组身份判断"换文件了"（与既有 `PdfPreview` 同口径）；
 *    换文件请用 `key={路径}` 重挂，或把字节放在宿主 state 里。
 * 4. **Office 那条链路已经是真的**（见 `preview/fetch.ts` + `preview/PreviewBody.tsx`）：
 *    `workbench:office-pdf`（主进程用随包 LibreOffice 转 PDF）→ `DshOfficeViewer`，
 *    `office-bridge.ts` 负责把 `AbortSignal` 翻成 `cancelOfficePdf(requestId)` 的**真取消**；
 *    `.doc/.docx/.ppt/.pptx` 四类都走它（不再把 docx 转 markdown / pptx 抽文字）。
 *    表格（xls/xlsx/csv/tsv）走 `workbench:table-bytes` + 渲染端 `ExcelPreview`，
 *    **不进**办公档这条 PDF 管线。
 * 5. **办公档现在是这样接的**（见 `preview/fetch.ts` + `preview/PreviewBody.tsx`）：
 *    `workbench:office-pdf` 的 `pdf` + `missingFonts` 交给 `DshOfficeViewer`（`office-bridge.ts`
 *    负责 `AbortSignal` → `cancelOfficePdf(requestId)` 的真取消）；`.doc/.docx/.ppt/.pptx` 四类都走它，
 *    **不是**再把 docx 转 markdown / pptx 抽文字。表格（xls/xlsx/csv/tsv）走 `workbench:table-bytes`
 *    + 渲染端 `ExcelPreview`，**不进**办公档这条 PDF 管线。
 * 6. **独立 PDF 入口不动**：`preview/PreviewBody.tsx` 里 `.pdf` 仍然是既有 `PdfPreview`
 *    （缩略图 + 目录书签保留）。新版页式阅读器目前只服务办公档那条链路；要换掉独立 PDF 入口，
 *    得先把缩略图/目录补齐，别直接替换成能力更少的那个。
 *
 * ## 本地资源（CMap / 标准字体）：构建期内联进懒分块
 *
 * **没内嵌字体的 PDF（典型是中文）缺这两样时坏的是整页**，不是"只有文字层没字"（pdf.js 会直接抛
 * "Ensure that the `cMapUrl` API parameter is provided."）。
 *
 * 供给方式（见 `pdfjs-inline-assets-plugin.ts` + `pdf-assets.ts`）：构建期把
 * `node_modules/pdfjs-dist/{cmaps,standard_fonts}` **按文件名**内联成 base64 的独立懒分块
 * （`electron.vite.config.ts` 里装插件；只读这两个目录、不递归、按扩展名过滤、有大小上限），
 * 运行期由 `BinaryDataFactory` 按 pdf.js 的 `{kind, filename}` 一问 `import()` 对应的那一块 ——
 * **一个请求都不发**，所以 `file://` 下不存在"fetch 被拦"这回事；也没放宽 CSP、没加协议、没下载资源。
 * 之所以这条能成立：懒分块的 `import()` 在打包态**本来就在用**（渲染产物里已有十几个懒块，
 * 含 pdfjs 自己那一块）。
 *
 * **仍未验证**：整条链路的端到端（打包态打开一份"没内嵌字体的中文 PDF"且画出来）没在真机跑过 ——
 * 证据要求见仓库交接（构建产物里应有 `cmaps` 对应的懒分块 + 真机截图）。
 *
 * ## 与既有 `preview/PdfPreview.tsx` 的口径差异（换上去之前要知道）
 *
 * | 维度 | 既有 `PdfPreview` | 本目录 `DshPdfViewer` |
 * |---|---|---|
 * | 页渲染 | 挂载即整本开画，上限 50 页（超出截断） | **按需**：进视口才画（提前一屏），不设页数上限 |
 * | 文字选择 | 无（只有位图） | **有**：pdf.js 官方 `TextLayerBuilder` 文字层，可选中可复制 |
 * | 缩放 | 档位 0.5–3，1 档即"适应宽度"，同步拉伸 + 防抖重画 | 适应宽度 / 固定 0.25–4（菜单 0.25/0.5/1/1.5/2），Ctrl+滚轮连续缩放、指针锚定 |
 * | 侧栏 | 缩略图 + 目录书签 | 无（要的是"一列页 + 选字"；缩略图/目录留给后续） |
 * | 失败粒度 | 整份文件一个错误态 | 整份 + **单页**各自错误态与重试 |
 * | 换文件 | `key={relative}` 重挂 | 同口径 |
 *
 * 缩略图 / 目录这两件是既有组件的长处，本版**没有**搬（DSH 的阅读器也没有）——要在同一条链路上
 * 保留它们得另外接线，别把"没有"说成"已完成"。
 */

export { DshPdfViewer, type DshPdfViewerProps } from './DshPdfViewer'
export { DshOfficeViewer, type DshOfficeLabels, type DshOfficeViewerProps } from './DshOfficeViewer'
export { ZoomViewport, type ZoomViewportProps } from './ZoomViewport'
export { ZoomControls, type ZoomControlsHandle, type ZoomControlsProps } from './ZoomControls'
export { PdfPages, type PdfPagesProps } from './PdfPages'
export { openPdf, type PdfSession } from './runtime'
export { renderPdfPage, type PdfDocument, type PdfPageSize, type RenderPdfText } from './document'
export { pdfTextRenderer } from './text-layer'
export { isAbortError, pdfFailureText } from './errors'
export {
  clampZoom,
  containZoom,
  DEFAULT_ZOOM_LABELS,
  FIT_WIDTH,
  fitWidthZoom,
  MAX_FIXED_ZOOM,
  MIN_FIXED_ZOOM,
  resolveZoom,
  stepZoom,
  ZOOM_OPTIONS,
  ZOOM_STEP,
  type ZoomFit,
  type ZoomLabels,
  type ZoomPreference
} from './zoom'
export {
  fontNoticeText,
  toOfficePdf,
  type DshOfficeLoad,
  type DshOfficeLoadResult,
  type DshOfficePdf
} from './office'
export {
  describeOfficeFailure,
  officeLoadFor,
  OfficePreviewFailure,
  type OfficeBridge,
  type OfficeLoadHandle
} from './office-bridge'
export {
  bundledPdfAssets,
  localPdfAssets,
  type BinaryDataRequest,
  type PdfAssetOptions,
  type PdfAssetTable,
  type PdfAssetTables,
  type PdfBinaryDataFactory,
  type PdfAssetKind
} from './pdf-assets'
// 注意：`pdf-assets-bundled.ts` **不进这个 barrel** —— 它 import 的是构建期虚拟模块
// （`virtual:kyclaw-pdfjs-assets`），只有装在 `electron.vite.config.ts` 的那支插件能解析它；
// barrel 一旦带上它，任何在别的环境里 import 本目录的地方都会当场解析失败。
// 需要"表里有什么 / 取字节"时按路径直接 import 那个模块（测试里把它依赖的虚拟模块 mock 掉即可）。
