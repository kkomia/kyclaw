/**
 * composer 附件的口径（round 7 起；模块 2 扩成三类；round 53 第三类改走**路径引用**）。
 *
 * 为什么不再"一律文本内联"（round 7 的历史结论要更新）：当年实测的是 **file part 里的文本**
 * 走真服务时 provider 看不到内容，于是附件退回"把内容写进消息文本"。模块 2 用**真栈**重新验了
 * 视觉这条路（`src/mastra/__tests__/vision-wire.spec.ts`：真 server + 真 Chat + 抓包假端点），
 * 结论是 **图片 file part 会以 `image_url` + data URL 原样进到 provider 请求体** —— 能收的模型
 * 是真看得见。所以策略按模型能力分：
 *
 *   - **图片**（png/jpg/jpeg/webp/gif）：当前模型 vision=true → 作为图片随消息真发（气泡里给缩略图）；
 *     vision=false → **人话拒收**（不假装收下，也不偷偷转成文字描述）。上限 8MB；
 *   - **PDF**：所有模型统一走**主进程文本抽取**（pdfjs，见 main/pdf.ts），抽出的文本按【附件】
 *     围栏内联（带页码标记）。扫描件（无文字层）给人话。**PDF 渲染成图留 v2**；
 *   - **其余文件**（round 53）：**载荷 = 路径引用**（`【附件】<路径>`），不读内容、不按大小/二进制拒收。
 *     本地文件本来就躺在磁盘上，模型有 bash / 读文件工具，给路径比灌内容更省上下文也更有用
 *     （用户原话："作为本地文件，给大模型发的肯定是文件路径链接"）。路径口径见 prepareAttachment：
 *     会话根内 → **工作区相对路径**（与文件树 / @ 引用同口径）；根外（比如 Downloads）→ **原样绝对路径**
 *     （read 工具只认工作区，根外那条模型用 bash 读）。拿不到路径（桥缺失/回空）时兜底旧行为：
 *     文本 ≤16KB 仍内联，否则旧拒收文案 —— 保底，不让流程断。
 */
import {
  ATTACHMENT_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MEDIA_TYPES,
  PDF_MAX_BYTES,
  type PdfExtractResult
} from '@shared/attachments'

export { ATTACHMENT_MAX_BYTES, IMAGE_MAX_BYTES, PDF_MAX_BYTES }

/** 一条待发附件（三类共用一个形状；哪几项有值由种类决定） */
export interface PendingAttachment {
  id: string
  name: string
  size: number
  /** 文本内容（PDF 抽取结果 / 摘选 / 无路径时的文本内联）；图片与路径引用没有 */
  text?: string
  /** 图片：随消息真发的 data URL 与 MIME（vision=true 才有） */
  image?: { url: string; mediaType: string }
  /** PDF 抽取信息（气泡上显示页数；truncated = 触到上限） */
  pdf?: { pages: number; truncated: boolean }
  /**
   * 相对会话根的路径（round 42）：文件树 / 预览那条路才有（＋ 上传与拖拽走 `path`）。
   * 内容进消息时用它当抬头——不把路径丢掉，模型看得到"这是哪个文件"。
   */
  relative?: string
  /**
   * **路径引用**（round 53）：＋ 上传 / 拖拽 / 粘贴来的非图片非 PDF 文件的载荷 ——
   * 不读内容，进消息时只发 `【附件】<path>` 抬头。会话根内是工作区相对路径（与文件树引用同口径），
   * 根外是绝对路径。与 `text` 互斥（有路径就不读内容）。
   */
  path?: string
  /** 拿得到路径时的那条**绝对路径**（chip 的 tooltip 用完整路径；判相对/绝对也是从它算的） */
  absolute?: string
  /** 摘选（round 42 二轮）：载荷头用「【引用】文件：…」，卡片也按引用卡画；没有就是普通【附件】块 */
  quote?: boolean
  /** 摘选在源文里的行号区间（1 基闭区间；定位不到就不给——不瞎编） */
  lines?: { start: number; end: number }
}

/** 随消息真发的文件（形状 = AI SDK 的 FileUIPart；image 之外的类型本轮不发） */
export interface OutgoingFile {
  type: 'file'
  mediaType: string
  url: string
  filename?: string
}

/** 一条要发出去的消息：正文（含内联附件块）+ 要随消息真发的图片 */
export interface OutgoingMessage {
  text: string
  files: OutgoingFile[]
}

/** PDF 抽取的实现（渲染端注入 `window.kyclaw.attachments.extractPdf`；测试注入假件） */
export type PdfExtractor = (bytes: Uint8Array) => Promise<PdfExtractResult>

/** 认不出的 MIME（空 type）时按扩展名兜底的白名单 */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'csv',
  'tsv',
  'log',
  'ini',
  'conf',
  'env',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'css',
  'scss',
  'html',
  'htm',
  'xml',
  'vue',
  'svelte',
  'sh',
  'bash',
  'zsh',
  'bat',
  'ps1',
  'sql',
  'graphql'
])

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot === -1 ? '' : lower.slice(dot + 1)
}

/** 图片的 MIME（认不出 = null）：MIME 与扩展名两条路都认 */
export function imageMediaTypeOf(file: File): string | null {
  const type = file.type.toLowerCase()
  if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(type)) return type
  if (type !== '') return null
  return IMAGE_EXTENSIONS[extensionOf(file.name)] ?? null
}

/** 是不是 PDF（MIME 或扩展名） */
export function isPdfFile(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || extensionOf(file.name) === 'pdf'
}

/**
 * 图片被拒时的固定说法（round 48）：能力是**自动探出来的**（注册模型后主进程真发一条带图请求），
 * 用户没有开关可开、也不该去翻设置——所以这里只如实说结论，不解释后端、不给无效指引。
 */
export const NO_VISION_MESSAGE = '已自动检测：当前模型不支持看图'

/**
 * 能不能收（不能收给出简短原因，调用方原样展示）。图片与 PDF 各自的闸门；
 * **非图片非 PDF 的文件只在"拿不到路径"的兜底路上还走这里**（round 53 起有路径就是路径引用，
 * 不读内容、不看大小/二进制）——兜底口径 = 旧行为：≤16KB 的文本类内联，其余按这两句拒收。
 */
export function attachmentProblem(file: File, options: { vision: boolean }): string | null {
  const mediaType = imageMediaTypeOf(file)
  if (mediaType !== null) {
    if (!options.vision) return NO_VISION_MESSAGE
    if (file.size > IMAGE_MAX_BYTES) return `超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB`
    return null
  }
  if (isPdfFile(file)) {
    if (file.size > PDF_MAX_BYTES) return `超过 ${PDF_MAX_BYTES / 1024 / 1024}MB`
    return null
  }
  if (file.size > ATTACHMENT_MAX_BYTES) return `超过 ${ATTACHMENT_MAX_BYTES / 1024}KB`
  const type = file.type
  const textish =
    type.startsWith('text/') ||
    /(json|xml|yaml|javascript)/.test(type) ||
    TEXT_EXTENSIONS.has(extensionOf(file.name))
  if (!textish) return '不是文本文件'
  return null
}

export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsText(file)
  })
}

/** 读成 data URL（图片随消息真发就用它；provider 侧会翻成 `image_url`） */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 一个文件读完的结果：要么是待发附件，要么是一句"为什么没收" */
export type PreparationResult = { attachment: PendingAttachment } | { problem: string }

/** 反斜杠都换成正斜杠（Windows 路径归一；相对路径的写法与文件树 / @ 引用同口径） */
function slashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 绝对路径 → 会话根内的**工作区相对路径**（正斜杠）；根外 / 根自己 / 判不出根 → null。
 *
 * 口径与文件树 / @ 引用一致（`sessionRoots` 那条路给的就是相对路径）：
 *   - 大小写不敏感（Windows 的 D:\ws 与 d:\WS 是同一个目录）；
 *   - 按**路径段边界**比较（`D:/ws` 不该把 `D:/ws2/a` 当成自家文件）；
 *   - 尾部分隔符先去掉（根写成 `D:\ws\` 也认）。
 * 根外的不在这里拦：调用方**原样保留绝对路径**（模型用 bash 读得到；read 工具只认工作区，
 * 这点写在注释里就够了，不因为这个拒收）。
 */
export function relativeInRoot(absolute: string, root: string | null | undefined): string | null {
  if (root === null || root === undefined || root === '') return null
  const abs = slashPath(absolute).replace(/\/+$/, '')
  const base = slashPath(root).replace(/\/+$/, '')
  if (abs === '' || base === '') return null
  const lowerAbs = abs.toLowerCase()
  const lowerBase = base.toLowerCase()
  if (lowerAbs === lowerBase) return null
  if (!lowerAbs.startsWith(`${lowerBase}/`)) return null
  return abs.slice(base.length + 1)
}

/** prepareAttachment 的可选接线（不传 = 旧行为；单测直接给假件） */
export interface PrepareAttachmentOptions {
  vision: boolean
  extractPdf: PdfExtractor
  id: string
  /** 会话根的绝对路径（判"根内 → 相对"用）；判不出/没有 = 一切路径都按绝对引用 */
  rootPath?: string | null
  /** File → 绝对路径（preload 的 webUtils 桥）；缺失或回空 = 走无路径兜底 */
  pathForFile?: (file: File) => string
}

/**
 * 读一个文件，翻成待发附件（或拒收原因）。**这是附件口径的唯一入口**——
 * 拖拽、＋ 上传与粘贴三条路都调它，三条入口的行为就一定是同一套。
 *
 * 图片：读 data URL（大小与视觉能力已在 attachmentProblem 判过）；
 * PDF：整份丢给主进程抽文字层（扫描件/加密都在这返回人话）；
 * **其余文件：先问路径**（`pathForFile`，preload 的 webUtils）——拿得到就是**路径引用**
 * （根内相对 / 根外绝对，见 relativeInRoot），不读内容、不看大小/二进制（exe、10MB 大文件都收）；
 * 拿不到路径（浏览器 / 单测未装桥 / 内存里造的 File）：兜底旧行为——文本 ≤16KB 读原文，否则旧拒收文案。
 */
export async function prepareAttachment(
  file: File,
  options: PrepareAttachmentOptions
): Promise<PreparationResult> {
  const mediaType = imageMediaTypeOf(file)
  if (mediaType !== null) {
    const problem = attachmentProblem(file, { vision: options.vision })
    if (problem !== null) return { problem }
    try {
      const url = await readDataUrl(file)
      return {
        attachment: { id: options.id, name: file.name, size: file.size, image: { url, mediaType } }
      }
    } catch {
      return { problem: '读取失败' }
    }
  }

  if (isPdfFile(file)) {
    const problem = attachmentProblem(file, { vision: options.vision })
    if (problem !== null) return { problem }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await options.extractPdf(bytes)
      if (!result.ok) return { problem: result.message }
      return {
        attachment: {
          id: options.id,
          name: file.name,
          size: file.size,
          text: result.text,
          pdf: { pages: result.pages, truncated: result.truncated }
        }
      }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : '读取失败' }
    }
  }

  const absolute = options.pathForFile?.(file) ?? ''
  if (absolute !== '') {
    const relative = relativeInRoot(absolute, options.rootPath ?? null)
    return {
      attachment: {
        id: options.id,
        name: file.name,
        size: file.size,
        // 根内给相对路径（与文件树引用同口径），根外原样绝对路径
        path: relative ?? absolute,
        absolute
      }
    }
  }

  const problem = attachmentProblem(file, { vision: options.vision })
  if (problem !== null) return { problem }
  try {
    const text = await readTextFile(file)
    return { attachment: { id: options.id, name: file.name, size: file.size, text } }
  } catch {
    return { problem: '读取失败' }
  }
}

/**
 * 围栏长度（T16 小修批）：内容里最长的一段连续反引号 + 1，下限 3。
 * 固定三反引号的围栏会被内容自带的 ``` 提前收尾——后面的原文就漏成正文了。
 */
function fenceFor(text: string): string {
  let longest = 0
  let run = 0
  for (const char of text) {
    run = char === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 附件块的抬头（round 42：内容进消息时**带上来源路径与位置**；round 53 起路径引用同一条口径）：
 *   - 摘选 → `【引用】文件：<相对路径>（第 X–Y 行）`（行号定位不到就不写那半截，不瞎编）；
 *   - 整文件 → `【附件】<路径>`：路径引用给 `path`（根内相对 / 根外绝对），文件树那条路给
 *     `relative`；两者都没有（无路径兜底的文本内联）才是文件名。
 */
function attachmentHeaderOf(attachment: PendingAttachment): string {
  const label = attachment.path ?? attachment.relative ?? attachment.name
  if (attachment.quote === true) {
    return attachment.lines === undefined
      ? `【引用】文件：${label}`
      : `【引用】文件：${label}（第 ${attachment.lines.start}–${attachment.lines.end} 行）`
  }
  return `【附件】${label}`
}

/**
 * 发送时的组装（round 14：引用已改为输入框内联标记，不再单独成段）：正文 → 附件块
 * （附件内容包在围栏里，模型按原文读）。图片不进来——它不走文本，走 file part。
 * 路径引用（round 53）也没有内容可包：只发抬头那一行，模型按路径自己读（不假装给了内容）。
 */
export function composeOutgoingText(input: {
  text: string
  attachments: readonly PendingAttachment[]
}): string {
  const { text, attachments } = input
  const blocks: string[] = []
  const trimmed = text.trim()
  if (trimmed !== '') blocks.push(trimmed)
  for (const attachment of attachments) {
    if (attachment.text === undefined) {
      if (attachment.path !== undefined) blocks.push(attachmentHeaderOf(attachment))
      continue
    }
    const content = attachment.text.replace(/\n+$/, '')
    const fence = fenceFor(content)
    blocks.push(`${attachmentHeaderOf(attachment)}\n${fence}\n${content}\n${fence}`)
  }
  return blocks.join('\n\n')
}

/** 图片附件 → 要随消息真发的 file part（顺序与附件条一致） */
export function outgoingFilesOf(attachments: readonly PendingAttachment[]): OutgoingFile[] {
  return attachments.flatMap((attachment) =>
    attachment.image === undefined
      ? []
      : [
          {
            type: 'file' as const,
            mediaType: attachment.image.mediaType,
            url: attachment.image.url,
            filename: attachment.name
          }
        ]
  )
}

/** 发送时的完整载荷：文本（含内联附件块）+ 要真发的图片 */
export function composeOutgoing(input: {
  text: string
  attachments: readonly PendingAttachment[]
}): OutgoingMessage {
  return { text: composeOutgoingText(input), files: outgoingFilesOf(input.attachments) }
}
