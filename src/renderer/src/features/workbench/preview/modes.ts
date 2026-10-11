/**
 * 预览路由（纯函数，单测直接打）：按文件名后缀决定用哪条通道、哪个渲染器。
 *
 * 四条路：
 *   - `text`：现有的文本通道（`workbench:read-file`，64KB 有界，`<pre>` 原样）；
 *   - `markdown` / `code`：同样是文本通道，但分别过 markdown 渲染器与代码高亮
 *     （`.md` / `.markdown`；代码扩展名见下面的 CODE_LANGUAGES）；
 *   - `image` / `pdf` / `table` / `docx` / `pptx`：走字节通道（`workbench:read-bytes`），
 *     图片与 PDF 拉的是原始字节，办公三件与 csv/tsv 拉的是主进程抽好的结构；
 *   - `office-legacy`：`.doc` / `.xls` / `.ppt` —— **不读文件**，直接给人话（另存为新格式）。
 *
 * 为什么按后缀分流而不是"先读回来再看内容"：文本通道 64KB 且只给字符串，图片/PDF 拿不到字节；
 * 反过来给所有文件都拉一次字节也太重。后缀是这里唯一便宜的判据（真格式判定在主进程，头对不上
 * 会回 `unsupported`，渲染端回落二进制占位）。
 */
export type PreviewMode =
  'text' | 'markdown' | 'code' | 'image' | 'pdf' | 'table' | 'docx' | 'pptx' | 'office-legacy'

const MARKDOWN_EXTENSIONS = ['md', 'markdown']
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
/** 表格：xlsx 与 csv/tsv（csv/tsv 在后端也是"一张表"的形状，渲染端同一个组件） */
const TABLE_EXTENSIONS = ['xlsx', 'csv', 'tsv']
/** 旧版 Office 二进制格式：不硬画，给人话 */
const LEGACY_OFFICE_EXTENSIONS = ['doc', 'xls', 'ppt']

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

/** 后缀 → 预览方式（认不出的一律走现有文本通道，保持既有行为） */
export function previewModeOf(relative: string): PreviewMode {
  const extension = extensionOf(relative)
  if (MARKDOWN_EXTENSIONS.includes(extension)) return 'markdown'
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return 'docx'
  if (extension === 'pptx') return 'pptx'
  if (TABLE_EXTENSIONS.includes(extension)) return 'table'
  if (LEGACY_OFFICE_EXTENSIONS.includes(extension)) return 'office-legacy'
  if (codeLanguageOf(relative) !== null) return 'code'
  return 'text'
}

/** 图片格式 → data URL 的 MIME（主进程回的格式枚举，六种都在这里收口） */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp',
  'image-bmp': 'image/bmp'
}

/** 旧版 Office 格式 → 人话（不读文件，直接说清"另存为"这一步） */
export const LEGACY_OFFICE_NOTICE: Readonly<Record<string, string>> = {
  doc: '旧版 Word（.doc）暂不支持预览，可用 Word 另存为 .docx',
  xls: '旧版 Excel（.xls）暂不支持预览，可用 Excel 另存为 .xlsx',
  ppt: '旧版 PowerPoint（.ppt）暂不支持预览，可用 PowerPoint 另存为 .pptx'
}
