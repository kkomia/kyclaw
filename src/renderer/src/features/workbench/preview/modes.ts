/**
 * 预览路由（纯函数，单测直接打）：按文件名后缀决定用哪条通道、哪个渲染器。
 *
 * 几条路（**接线的分流口径就这一处**）：
 *   - `text`：**文本分页通道**（`workbench:read-text-page`，一页 ≤256KB、按行与 UTF-8 边界收边）
 *     → `dsh-media/paged-text.tsx` 累加各页并「加载更多」；纯文本那一页由 `DshTextBody` 逐行铺开。
 *     （旧 `workbench:read-file` 的 64KB 有界读仍是 @ 引用/附件那条路，预览不再用它。）
 *   - `markdown` / `code`：同一份文本过 markdown 渲染器 / 代码高亮；
 *   - `html` / `htm`：**字节通道**（`workbench:read-bytes`）→ `DshHtmlViewer` 的静态隔离预览
 *     （DOMPurify 清洗 + `sandbox=""` iframe，不启用脚本模式）。判定**排在 code 之前**：
 *     这两个后缀本来在 `CODE_LANGUAGES` 里（按源码高亮看），现在顺手给它们真正的渲染器；
 *     `codeLanguageOf('x.html')` 仍给 `'html'`，谁要按代码看谁自己问；
 *   - `image` / `pdf`：**字节通道** —— 图片（png/jpeg/gif/webp/bmp **+ svg/ico**）走 `DshImageBody`
 *     （data URL 进 `<img>`，SVG 不进 DOM）；PDF 走既有 `PdfPreview`（缩略图 + 目录书签那套能力保留）；
 *   - `table`（xls / xlsx / csv / tsv）：**表格原始字节通道**（`workbench:table-bytes`）；
 *   - `office`（doc / docx / ppt / pptx）：**页式预览**（`workbench:office-pdf`）。
 *
 * 为什么按后缀分流而不是"先读回来再看内容"：文本通道 64KB 且只给字符串，图片/PDF 拿不到字节；
 * 反过来给所有文件都拉一次字节也太重。后缀是这里唯一便宜的判据（真格式判定在主进程：扩展名与
 * 文件头两道闸对不上就回 `unsupported`，渲染端照样给人话）。
 */

export type PreviewMode =
  'text' | 'markdown' | 'code' | 'html' | 'image' | 'pdf' | 'table' | 'office'

const MARKDOWN_EXTENSIONS = ['md', 'markdown']
/**
 * HTML 两种后缀：静态隔离预览（字节通道）。
 * 与 `.svg` 的关系：`.svg` 按**图片**看（矢量图，渲染器是 `DshImageBody`）；要读它的源码是另一回事。
 */
const HTML_EXTENSIONS = ['html', 'htm']
/** 图片八种：前六种是既有字节格式，后两种（svg / ico）由 `dsh-media` 的渲染器接住。 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']
/**
 * 表格：四种后缀走**原始字节**通道（主进程只做后缀 + 文件头对暗号 + 上限，抽结构那套不在这条路上）。
 * 含旧版 `.xls`：SheetJS 能直接读它，不必先转格式，也不必进办公档那条 PDF 管线。
 */
const TABLE_EXTENSIONS = ['xls', 'xlsx', 'csv', 'tsv']
/** 办公档：四种后缀都走"转 PDF → 页式预览"（含旧版 `.doc` / `.ppt`）。 */
const OFFICE_EXTENSIONS = ['doc', 'docx', 'ppt', 'pptx']

/**
 * 代码扩展名 → shiki 的语言 id。
 *
 * **只列高亮器真打包了的语言**（清单在 `features/chat/parts/CodeBlock.tsx` 的 langs 里：
 * javascript / typescript / tsx / json / css / html / python / bash(+shellscript) / markdown / yaml）。
 * 不在这张表里的后缀（`.log` `.sql` `.toml` `.ini` `.ps1` `.bat` `.xml` 之类）一律回落现有
 * `<pre>` 纯文本 —— 行为与 round40 之前**完全一致**，不硬套别的语法。
 * 两处刻意的就近映射（都是"引擎里有、按语义贴上去"的）：
 *   - `.jsx` → `javascript`：仓库没装独立的 jsx 语法，JSX 标签不会被单独染色，JS 部分照常高亮；
 *   - `.xml`  → `html`：html 语法本身就是 XML 家族（标签/属性/注释/CDATA 同一套规则）。
 */
const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  yaml: 'yaml',
  yml: 'yaml'
}

/** 取小写后缀（不含点；正反斜杠都认；没有后缀给空串） */
export function extensionOf(relative: string): string {
  const base = relative.slice(Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** 这个文件能不能高亮、用哪个语言（认不出给 null → 回落纯文本 `<pre>`，行为不变） */
export function codeLanguageOf(relative: string): string | null {
  return CODE_LANGUAGES[extensionOf(relative)] ?? null
}

/** 后缀 → 预览方式（认不出的一律走文本通道，保持既有行为） */
export function previewModeOf(relative: string): PreviewMode {
  const extension = extensionOf(relative)
  if (MARKDOWN_EXTENSIONS.includes(extension)) return 'markdown'
  // html 要排在 code 之前：这两个后缀同时也在 CODE_LANGUAGES 里（.html/.htm → 'html' 语言）。
  // 想按源码高亮的调用方自己调 codeLanguageOf，路由这一层按"有真渲染器就用真的"说话。
  if (HTML_EXTENSIONS.includes(extension)) return 'html'
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (TABLE_EXTENSIONS.includes(extension)) return 'table'
  if (OFFICE_EXTENSIONS.includes(extension)) return 'office'
  if (codeLanguageOf(relative) !== null) return 'code'
  return 'text'
}

/** 图片格式 → data URL 的 MIME（渲染组件与附件通道共用这一张表；svg/ico 是本轮新收的两种）。 */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp',
  'image-bmp': 'image/bmp',
  'image-ico': 'image/x-icon',
  'image-svg': 'image/svg+xml'
}

/**
 * ## 字节格式（跟共享枚举走）
 *
 * 渲染端认的字节格式就是 `shared/workbench.ts` 的 `fileByteFormatSchema`（本轮 B 已把
 * `image-svg` / `image-ico` / `html` 补进去，`PREVIEW_HTML_MAX_BYTES = 8MB` 也在那边）。
 * 这里不再维护第二份名单：图片一族用 `dsh-media/formats.ts` 的 `DshImageFormat`
 * （从枚举里抽 `image-*`），HTML 直接用枚举里的 `'html'`。
 */
