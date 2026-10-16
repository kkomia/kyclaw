/**
 * dsh-media：DSH 媒体/文档族的渲染件（图片、HTML 静态预览、markdown 数学与 frontmatter、代码、纯文本）。
 *
 * 本目录是一个自洽单元：除 React、本仓 `components/ui`、既有 `features/chat/parts/CodeBlock`、
 * 共用缩放（`preview/dsh-document/`，为其加了可配置边界）与三个上游 micromark 工具包之外，
 * 它不引入别的依赖。逐文件的上游对照、许可与新增依赖见同目录 `LICENSE-deepseek-harness.md`。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ## 对外五件东西（各有自己的入参契约）
 *
 * - `DshImageBody({ format, bytes })`：一份**图片字节**（png/jpeg/gif/webp/bmp/ico/svg）。
 *   自带统一缩放（共用 `dsh-document/ZoomViewport`，图片传自己的边界：10%–800%、一档 ×1.25）、
 *   旋转、双击回位、坏图人话。
 * - `DshHtmlViewer({ bytes })`：一份**完整 HTML 字节**（UTF-8）。清洗后进 `sandbox=""` 的 iframe，
 *   **不启用脚本模式**、不读相对资源、不放行联网。
 * - `DshMarkdownBody({ text })`：markdown **全文**（文本通道内容）。frontmatter 字段表 + 数学
 *   （`$...$` / `$$...$$` / `\(...\)` / `\[...\]`）+ 既有代码块口径。
 * - `DshCodeBody({ text, language })`：代码**全文** + Shiki 语言 id（`modes.ts` 那张表里认得的）。
 *   行号默认开、换行默认开。
 * - `DshTextBody({ text })`：纯文本**全文**（文本通道内容），逐行铺开（**不是分页**，见下）。
 *
 * ## 接线状态（2026-10-16）
 *
 * 渲染端接线**已落地**（本目录 + `preview/{modes,file-icon,fetch,PreviewBody}.ts(x)` 这几个文件）：
 *   - `preview/modes.ts`：`PreviewMode` 增 `'html'`；`HTML_EXTENSIONS = ['html','htm']`（**排在 code
 *     之前**，`.html/.htm` 本来按源码高亮看）；`IMAGE_EXTENSIONS` 增 `'svg','ico'`；`IMAGE_MIME` 增两项；
 *   - `preview/file-icon.ts`：`FALLBACK_KINDS` 补 `html: 'html'`（`Record<PreviewMode, …>` 的缺项）；
 *   - `preview/fetch.ts`：HTML 走字节通道（`mode !== text/markdown/code` 那条判据本来就收它）；
 *   - `preview/PreviewBody.tsx`：`BytesBody` 增加 `html` 分支（`SIZED_HOST_CLASS` + `DshHtmlViewer`）、
 *     图片分支维持 `ImagePreview → DshImageBody`；`TextBody` 的纯文本 `<pre>` 换成 `DshTextBody`。
 * 后端（B 已落地，本目录只登记事实）：`fileByteFormatSchema` 含 `image-svg/image-ico/html`、
 * `PREVIEW_HTML_MAX_BYTES = 8MB`；`main/workbench-files.ts` 的 `EXTENSION_FORMATS` + 文本头 sniff
 * （ICO 走 magic）都在；`.html/.htm/.svg` 被 `OPENABLE_EXCLUDED` 挡在「用系统默认应用打开」之外。
 *
 * ## 文本分页 + 版本提示（本轮落地；旧口径"64KB 一次读完"作废）
 *
 * 预览里的文本 / markdown / 代码现在走**文本分页通道**（`shared/workbench-text.ts` +
 * `main/workbench-text.ts` + `preview/dsh-media/paged-text.tsx`）：
 *   - 一页 ≤256KB，页边界落在换行之后并从 UTF-8 字符边界上收 → 各页**直接拼接**就是原文；
 *   - 超长单行按 32KB 切开（`overlongLine` 为真时界面如实说明）；
 *   - 续读带 `{ offset, version }`（`version = size:mtimeMs`）：不符即 `changed`，**不拼旧新**；
 *   - "加载更多"读到 `eof`（≤64MB 的文件都能看全；超过才回 `too-large`）。
 *
 * **刷新语义**（"通知 + 按钮"不是全部，自动刷新有三条硬边界）：
 *   - 每 4s 只 **stat**（`textVersion`，不读正文），且只在**窗口可见 + 预览标签在前台**时发；
 *   - 版本变了且**读者没上翻（滚动在顶附近）+ 已加载范围 ≤8 页/2MB** → **自动重读并静默换新**
 *     （滚动位置照旧，提示"已刷新到最新"）；这是"编辑文档时预览自动跟上"的常见路径；
 *   - 读者**已上翻**、或范围更大 → **只提示**「文件已在磁盘上更新」+「重新读取并回到这里」
 *     （点它重读到原阅读位置、位置放回去；上限 64 页，补不齐如实说）——**不抢读者的位置、
 *     不静默拉一份大的**；
 *   - 中途读到的任何非 `page` 回包（改过/没了/不再是文本）都**只提示不拼接**。
 * 旧的 `workbench:read-file`（64KB）**仍是** @ 引用 / 附件那条路的通道，没有改动。
 *
 * ## 仍然待办（不是本目录能单独完成的）
 *
 * 1) **附件防回归（chat 区）**：`composer-inbox.ts` 里 A 已落地**模型附件白名单**
 *    （`VISION_ATTACHMENT_FORMATS`，只列光栅五种；svg/ico 落 `CONTEXT_UNSUPPORTED`）。
 *    **残留一处夹具**：`features/chat/__tests__/composer.spec.tsx` 的
 *    "二进制 / 超限（round 53）→ 路径引用"用例仍用 `logo.ico` 当二进制夹具 ——
 *    `.ico` 现在走 image 模式，该用例会红。建议把夹具换成非图片后缀（如 `blob.bin`，与
 *    `workbench/__tests__/{files-tool,preview-tool}.spec.tsx` 里已改过的同款夹具一致）。
 * 2) **真机目视**（本代理无法跑 dev）：统一缩放的手感、KaTeX 字体、srcdoc iframe 渲染、
 *    行号/换行观感、"加载更多"与更新提示的观感。
 * 3) **不做**：HTML 脚本模式（allow-scripts + 相对 .js/.css 打包）；独立 PDF 入口仍是既有 `PdfPreview`
 *    （它那套 10%–800% 缩放与缩略图/目录不动），"统一缩放"目前只覆盖 图片 ↔ 办公档页式阅读器；
 *    文本行号（`data-dsh-text-line` 已留口，可做"跳到第 N 行"的后续）。
 */

export { DshImageBody } from './image-body'
export { DshHtmlViewer } from './html-viewer'
export { DshMarkdownBody } from './markdown-body'
export { DshCodeBody } from './code-body'
export { DshTextBody } from './text-body'
export { IMAGE_MEDIA_TYPES, toDataUrl, type DshImageFormat } from './formats'
export { createBasicHtmlDocument, decodeText } from './html-document'
export { splitFrontmatter, type FrontmatterSplit } from './frontmatter'
export { FrontmatterFields } from './frontmatter-fields'
export { parseFrontmatterFields, type FrontmatterField } from './frontmatter-parse'
export { mathCompatibility, remarkBackslashMath } from './math-compatibility'
