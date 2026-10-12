/**
 * 产出物工具（模块 4）的公共件：目标解析、默认文件名派生、落盘回执、自带样式的 HTML 报告外壳。
 *
 * 五个格式工具（create_report / create_pdf / create_excel / create_ppt / create_docx）共用这一份口径：
 *   - **路径**只认 guard 的引擎（相对**会话根**的项目/默认工作区；越界 fail closed）。不给 `path`
 *     时从 `title` 派生默认文件名（扩展名由工具定），派生结果同样过引擎——不是"绕过路径校验的后门"。
 *   - **审批**与 write 同档（写类默认问）：派生出来的路径先解析成目标再判，所以"没给 path"也照旧
 *     吃 mode='full' 工作区免审、命中"永久允许"规则免审（见 guard.needsApproval 头注）。
 *   - **落盘**走 ctx.fs（可注入），文字走 string、二进制走 Uint8Array；同文件串行（与 write/edit 共用队列）。
 *   - **回执**统一是"已创建/已覆盖 <绝对路径>（N 字节，<种类>）"，工具卡直接显示、模型可继续用这个文件。
 *
 * 渲染与执行分离（brief §2）：renderReportHtml 是纯函数；各格式的 renderXlsx / renderPptx / renderDocx
 * 是同库的纯入口（输入 → 字节，无 IO）；工具执行只做"解析路径 → 调渲染 → 落盘 → 回执"。
 * `printPdf` 例外：它是**主进程注入的钩子**（真实现是 Electron 的 printToPDF，见 main/print-pdf.ts），
 * 工具层不 import electron —— 注入模式与 llama 二进制路径（main/index.ts）同一路数，测试注入 stub。
 */
import { dirname } from 'node:path'
import { DEFAULT_SESSION, needsApproval, statOrNull, toolTarget, type ToolContext } from './guard'

/** 主进程注入的打印钩子：HTML → PDF 字节（工具层只吃这个形状，真实现要用 Electron） */
export type PdfPrinter = (html: string) => Promise<Buffer | Uint8Array>

/** 没注入打印钩子时的错误文案（无窗口环境 / 测试没给 stub） */
export const NO_PDF_PRINTER_MESSAGE =
  'PDF 导出不可用：当前运行环境没有注入打印钩子（printPdf）；可以先用 create_report 生成 HTML 报告'

/** 文件名里不能出现的字符（Windows 口径最严：`<>:"/\|?*`） */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/g

/** C0 控制字符（0x00–0x1f，Windows 一律不接受）：用码点判——正则字面量写它们会被 no-control-regex 拦 */
const CONTROL_CHAR_MAX = 0x1f

/** 标题里自带的扩展名：派生文件名前先摘掉（否则 "报告.pdf" 会变成 "报告.pdf.pdf"） */
const KNOWN_EXTENSION = /\.(html?|pdf|xlsx|pptx|docx|md|markdown|txt|csv|json)$/i

/** 派生文件名的长度上限（不含扩展名；给标题里的长句留个截断） */
const MAX_NAME_CHARS = 60

/** Windows 保留设备名（占用了会写失败）→ 前缀一个词绕开 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 派生不出名字时的兜底（工具各自给更贴切的：报告 / 演示文稿 / 表格 / 文档） */
export const DEFAULT_ARTIFACT_NAME = '产出物'

/**
 * 从标题派生文件名（`报告` → `报告.html`）：
 * 丢控制字符 → 非法字符换空格 → 折叠空白 → 摘自带扩展名 → 去首尾点与空格
 * （Windows 不接受结尾的点/空格）→ 截断 → 空/保留名兜底。
 * 注意**不**动中文与全角标点（CJK 文件名完全合法，用户看着也顺眼）。
 */
export function defaultArtifactName(title: string, ext: string): string {
  return `${sanitizeFileName(title)}.${ext}`
}

function sanitizeFileName(title: string): string {
  let base = Array.from(title)
    .filter((char) => char.charCodeAt(0) > CONTROL_CHAR_MAX)
    .join('')
    .replace(ILLEGAL_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 摘扩展名放在归一空白之后：'  报告 .md  ' 也算"自带扩展名"
    .replace(KNOWN_EXTENSION, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')

  if (base.length > MAX_NAME_CHARS) base = base.slice(0, MAX_NAME_CHARS).replace(/[.\s]+$/, '')
  if (base === '') return DEFAULT_ARTIFACT_NAME
  return RESERVED_NAME.test(base) ? `${DEFAULT_ARTIFACT_NAME}_${base}` : base
}

/** 产出物入参的公共面：给了 path 就认 path，没给就用 title 派生 */
export interface ArtifactInput {
  title?: string
  path?: string
}

/**
 * 这次调用**实际会写的那个目标串**：给了 path 原样用；没给就从 title 派生默认文件名
 * （title 也给空就用该工具的 fallbackTitle）。
 *
 * 审批与执行都用这一个函数算出来的目标 —— 两边的口径必须一致，否则会出现
 * "批的是 A、写的是 B"这种最糟的错配。
 */
export function artifactPath(input: ArtifactInput, ext: string, fallbackTitle: string): string {
  const given = input.path?.trim() ?? ''
  if (given !== '') return given

  const title = input.title?.trim() ?? ''
  return defaultArtifactName(title === '' ? fallbackTitle : title, ext)
}

/**
 * 审批口径（写类，同 write；判定细节见 guard.needsApproval）。
 * `session` 来自回调第二参（round 46）：产出物的路径总会派生出一个显式目标，所以这一档走的
 * 是"显式目标"分支（目标落在哪个工作区判 full / 规则），会话只影响"无目标"的档位；
 * 仍然透传，与大工具集保持同一写法（缺省 undefined = 老口径）。
 */
export function artifactNeedsApproval(
  ctx: ToolContext,
  tool: string,
  input: ArtifactInput,
  ext: string,
  fallbackTitle: string,
  session?: string
): boolean {
  return needsApproval(
    ctx,
    tool,
    {
      title: input.title,
      path: artifactPath(input, ext, fallbackTitle)
    },
    session
  )
}

/** 执行口径：解析到会话根的绝对路径（越界抛中文人话，目标只认引擎给的 abs） */
export function artifactTarget(
  ctx: ToolContext,
  input: ArtifactInput,
  ext: string,
  fallbackTitle: string,
  session?: string
): string {
  return toolTarget(ctx, artifactPath(input, ext, fallbackTitle), session).abs
}

export interface SaveArtifactOptions {
  /** 文本类产出物（HTML）内容对模型完全已知 → 记进"已读"，后续 edit 不必再 read */
  markRead?: boolean
  /** markRead 用（会话键 = agent 线程 id） */
  session?: string
  /** 产出后的结构自检结论（如 '结构校验通过'）：拼在回执尾部，模型/工具卡一眼能看到 */
  check?: string
}

/**
 * 落盘 + 回执。与 write 同一套边界：目标是目录就拒、父目录自动建、同文件串行（并发产出互不覆盖）。
 * 二进制（PDF/xlsx/pptx/docx）走 Uint8Array 分支，文本（HTML）走 string 分支。
 */
export async function saveArtifact(
  ctx: ToolContext,
  abs: string,
  bytes: string | Uint8Array,
  kind: string,
  options: SaveArtifactOptions = {}
): Promise<string> {
  return await ctx.state.runExclusive(abs, async () => {
    const existing = await statOrNull(ctx, abs)
    if (existing?.isDirectory() === true) {
      throw new Error(`产出物没能落盘：${abs} 是一个目录，不能当文件写`)
    }

    await ctx.fs.mkdir(dirname(abs))
    await ctx.fs.writeFile(abs, bytes)
    if (options.markRead === true) {
      ctx.state.markRead(options.session ?? DEFAULT_SESSION, abs)
    }

    const action = existing === null ? '已创建' : '已覆盖'
    const check = options.check === undefined ? '' : `；${options.check}`
    return `${action} ${abs}（${byteLengthOf(bytes)} 字节，${kind}）${check}`
  })
}

function byteLengthOf(bytes: string | Uint8Array): number {
  return typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength
}

/** HTML 转义（只用于我们模板里的标题等文本位；模型给的正文 HTML 原样嵌入，见 renderReportHtml） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 报告外壳的内联样式（自带、无外部请求、离线可看；打印时不带阴影与底色）。
 * 颜色只做浅色一套：报告是"给人看的文档"，打印与投屏都以浅色为准（深色版留后续）。
 */
const REPORT_STYLE = `:root{--ink:#1f1f1e;--ink-2:#5b5b58;--line:#e4e2df;--bg:#f5f4f2;--accent:#3b6ea5}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--ink);
font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;
-webkit-print-color-adjust:exact;print-color-adjust:exact}
.kyclaw-report{max-width:820px;margin:0 auto;padding:48px 56px;background:#fff;border-radius:8px;
box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
.kyclaw-report__head{border-bottom:2px solid var(--line);margin-bottom:32px;padding-bottom:16px}
.kyclaw-report__head h1{margin:0;font-size:30px;line-height:1.35;letter-spacing:.2px}
h2{margin:32px 0 12px;font-size:22px;line-height:1.4;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{margin:24px 0 10px;font-size:18px;line-height:1.45}
h4,h5,h6{margin:20px 0 8px;font-size:16px}
p{margin:12px 0}
ul,ol{margin:12px 0;padding-left:26px}
li{margin:6px 0}
li>ul,li>ol{margin:6px 0}
a{color:var(--accent)}
blockquote{margin:16px 0;padding:8px 16px;border-left:3px solid var(--accent);background:#f7f8fa;color:var(--ink-2)}
code{font-family:"Cascadia Mono",Consolas,"Courier New",monospace;font-size:.92em;background:#f3f3f1;
padding:2px 5px;border-radius:4px}
pre{margin:16px 0;padding:14px 16px;background:#f6f6f4;border:1px solid var(--line);border-radius:6px;
overflow:auto}
pre code{background:none;padding:0;font-size:13px;line-height:1.6}
table{width:100%;margin:16px 0;border-collapse:collapse;font-size:14px}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:#f4f5f7;font-weight:600}
tbody tr:nth-child(even){background:#fafafa}
hr{margin:28px 0;border:0;border-top:1px solid var(--line)}
img{max-width:100%;height:auto}
small,.muted{color:var(--ink-2)}
@page{size:A4}
@media print{
body{padding:0;background:#fff}
.kyclaw-report{max-width:none;margin:0;padding:0;box-shadow:none;border-radius:0}
h2,h3{break-after:avoid}
tr,img,pre,blockquote{break-inside:avoid}
}`

export interface ReportHtmlInput {
  /** 文档标题：写进 <title> 与页首大标题 */
  title: string
  /** 正文 HTML 片段：原样嵌入（模型自己产出的内容；模板只负责外壳与样式） */
  body: string
}

/**
 * 把正文 HTML 包进**自带样式**的独立文档：单文件、内联 CSS、无外部请求、UTF-8、离线可看，
 * 打印时自动去掉底色与阴影（PDF 走的也是这份 HTML，见 create_pdf）。
 *
 * 正文**不做净化**：这是用户自己会话里 agent 的产出（与 write 落一个 .html 同性质），
 * 挡的是"我们的模板"出问题（标题一律转义），不是替用户审查它自己的文件。
 */
export function renderReportHtml(input: ReportHtmlInput): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
${REPORT_STYLE}
</style>
</head>
<body>
<main class="kyclaw-report">
<header class="kyclaw-report__head"><h1>${escapeHtml(input.title)}</h1></header>
${input.body}
</main>
</body>
</html>
`
}
