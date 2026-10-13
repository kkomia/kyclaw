/**
 * read 工具（round 71 起**按类型分派**）：读授权工作区内的文件。
 *
 * 为什么要有分派：用户实测反馈——丢来 PDF / Word / 图片时，模型吃不到原始输入，只能去 bash 里
 * 想办法或先转格式。现在一条 read 调用就能拿到内容，路径也**最省 token**（不必先转成中间格式）：
 *
 *   - 文本（默认档）：原样 UTF-8，offset/limit 行窗口，>256KB 只读前 256KB 并附提示。
 *     **截断点收在 UTF-8 字符边界上**（StringDecoder 丢弃尾部不完整的多字节序列），不切出半个汉字。
 *   - `.pdf`：主进程的 PDF 文字层抽取（`src/main/pdf.ts`）——与"用户把 PDF 当附件发"那条路
 *     **同一份实现**，所以同一份文档走哪条路进来，模型看到的东西一样。
 *   - `.docx`：主进程的 Word 抽取（`mammoth` → markdown，`src/main/workbench-office.ts`），
 *     内嵌图片只留"（图片已省略）"占位（不要把 base64 巨图灌进上下文）。
 *   - 图片（`.png/.jpg/.jpeg/.webp/.gif`）：**不抽文字**，把**原始字节**作为图片交给模型**看** ——
 *     `toModelOutput` 回 `{type:'file', mediaType, data:{type:'data', data:<base64>}}`，这条形状是
 *     render_ppt 的页图那条**已实测**的路（见 tools/render-ppt.ts 头注），不另造一套。
 *   - 认得出的二进制（OOXML 容器、BMP、改名了的图片…）与旧版 Office（OLE：.doc/.xls/.ppt）：
 *     一句人话说明它**是什么**、下一步能怎么办，**不返回乱码**（旧行为是解成一堆 U+FFFD 与 NUL）。
 *
 * 判据是**扩展名 + 文件头两道闸**（与工作台那条读路同一套口径，`sniffFormat` 也是同一份实现）：
 * 头与扩展名对不上就不猜、不画，也不硬塞给模型端点（`.png` 里其实是文本 → 说清它其实是什么）。
 *
 * 上限一律"如实说 + 给下一步"，绝不返回空串让人以为文件是空的：
 *   - 文本：256KB 截断；PDF：原文件 ≤64MB（`READ_PDF_MAX_BYTES`）、docx：≤32MB；
 *     抽取出来的正文 ≤64000 字符（`READ_DOCUMENT_MAX_CHARS`，与附件那条路同一个数）；
 *   - 图片：≤8MB（`READ_IMAGE_MAX_BYTES`，与"随消息发出去的图"同一个数）且 ≤16M 像素
 *     （`READ_IMAGE_MAX_PIXELS`），超了**不发给模型**并把真实尺寸/下一步说清。
 *   - 扫描版 PDF（没有文字层）：如实说抽不到文字层，并给出下一步（本部署没有"PDF → 图片"的通路，
 *     可以让用户把那几页截图或导出成图片，图片 read 能直接看）。
 *
 * **出站面（round 75 起不审）**：文本 / PDF / Word 全在本机抽取；只有**图片**这一支会把原始字节
 * 发给模型端点（走 provider 的视觉通道）。用户口径："读图这种就不该审" —— 所以图片档与文本 / PDF /
 * Word **同一档免审**，不再单独弹卡（在这之前它按"外发档"判过一次）。两件事照旧：
 *   ① **边界不变**：目标仍必须落在授权工作区内（执行层过引擎，越界 fail closed）；
 *   ② **能力门**：当前模型读不了图（`visionOf` 那套判定，见 skills/runtime 的本部署事实）就
 *      **一个字节都不发**，回一句人话让模型/用户去换模型（见 readImage 的第一个分支）。
 *
 * 读过的路径按会话记进 ToolState（抽取档与图片档也记）：edit 的"未读先改"靠这份记录。
 */
import { StringDecoder } from 'node:string_decoder'
import { extname, relative, sep } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  IMAGE_MAX_BYTES,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_TEXT_MAX_CHARS
} from '../../shared/attachments'
import { PREVIEW_OFFICE_MAX_BYTES } from '../../shared/workbench'
import { extractPdfText } from '../../main/pdf'
import { extractDocx } from '../../main/workbench-office'
import { sniffFormat } from '../../main/workbench-files'
import { currentSkillRuntimeFacts } from '../skills/runtime'
import {
  approvalSessionOf,
  needsApproval,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'

/** read 的文本输出上限：超过就截断（spec §5.1"输出截断限额"） */
export const READ_MAX_BYTES = 256 * 1024

/**
 * 抽取档（PDF / Word）出来的正文上限（字符）：**故意**取成与附件那条路同一个数
 * （shared/attachments 的 PDF_TEXT_MAX_CHARS）—— 同一份文档，当附件发来和用 read 读，
 * 给模型的长度应当一样。
 */
export const READ_DOCUMENT_MAX_CHARS = PDF_TEXT_MAX_CHARS

/** PDF 原文件上限：与附件那条路同一个数（整份进内存抽取，是内存护栏不是业务口径） */
export const READ_PDF_MAX_BYTES = PDF_MAX_BYTES

/** Word 原文件上限：与工作台预览同一个数（mammoth 要整份解包） */
export const READ_DOCX_MAX_BYTES = PREVIEW_OFFICE_MAX_BYTES

/**
 * 单张图片的字节上限：与"随消息真发出去的图"同一个数（IMAGE_MAX_BYTES）—— 两者都是
 * "要进模型请求体的那张"，别再加一个数出来。
 */
export const READ_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES

/**
 * 单张图片的像素上限（**灾难护栏，不是成本政策**）：16M 像素 ≈ 1 万 token 量级
 * （换算按实测口径 ~1600 像素/token，见 render-ppt.ts 的 1600×900 ≈ 882 token）。
 * 取这个数是为了**不误伤常见输入**：4K 截图（3840×2160 ≈ 8.3M）、手机照片（4032×3024 ≈ 12.2M）
 * 都过得去；拦的是超大扫描件/拼图那种"一张就把上下文吃掉一大块"的东西。
 * 本部署没有本机缩放能力（那要引入图像库或让主进程注入 Electron 的 nativeImage，见报告），
 * 所以超限只能**拒并说清**，不做"悄悄缩采样"。
 */
export const READ_IMAGE_MAX_PIXELS = 16_000_000

/** 像素 → token 的**实测**换算（render_ppt 的 1600×900 页图约 880 token）；只用来在回执里报量级 */
export const IMAGE_PIXELS_PER_TOKEN = 1600

export const readInputSchema = z.object({
  path: z.string().min(1).describe('File path; relative paths resolve against the workspace root'),
  offset: z.number().int().min(1).optional().describe('First line to return, 1-based'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return')
})

export type ReadInput = z.infer<typeof readInputSchema>

/**
 * 图片档的输出（与文本档构成两态联合）：**图片字节不进这个对象**（界面上的工具卡会把 output
 * 序列化后截 600 字，塞 base64 进去会把卡片撑爆，与 render_ppt 同一个理由）——这里只放回执与
 * 图片的元信息，`toModelOutput` 拿着 `abs` 再读一次盘，把字节按已验证的形状附给模型。
 */
export const readImageResultSchema = z.object({
  /** 一句话回执（模型看到的正文；界面上的工具卡也显示它） */
  message: z.string(),
  /** 工作区相对路径（正斜杠；给模型与用户看） */
  path: z.string(),
  /** 绝对路径（toModelOutput 读盘用） */
  abs: z.string(),
  /** 交给模型时声明的 MIME */
  mediaType: z.string(),
  /** 文件字节数 */
  bytes: z.number(),
  /** 像素宽高；**读不出就不给**（认不出的文件头不猜，也不拦） */
  width: z.number().optional(),
  height: z.number().optional()
})

export type ReadImageResult = z.infer<typeof readImageResultSchema>

/**
 * 工具输出两态联合（字符串 = 文本 / 抽取档的回执与正文；对象 = 图片档）。
 * 与 deliver_file 同一个写法：字符串原样显示、对象显示成 JSON，所以**只有当字段真有用时才回对象**。
 */
export const readResultSchema = z.union([readImageResultSchema, z.string()])

export type ReadResult = z.infer<typeof readResultSchema>

/** 认路的图片扩展名 → MIME（与 composer / 附件的 `IMAGE_MEDIA_TYPES` 同一套） */
const IMAGE_MEDIA_TYPE: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** 文件头（`sniffFormat` 的结论）→ MIME：能进模型请求体的那几种 */
const SNIFF_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp'
}

/** 二进制档在人话里怎么称呼（键 = `sniffFormat` 的结论，外加 OLE） */
const BINARY_NAME: Readonly<Record<string, string>> = {
  pdf: 'PDF',
  ooxml: 'OOXML 容器（.xlsx / .pptx / .zip 这类）',
  'image-png': 'PNG 图片',
  'image-jpeg': 'JPEG 图片',
  'image-gif': 'GIF 图片',
  'image-webp': 'WebP 图片',
  'image-bmp': 'BMP 图片',
  ole: '旧版 Office 二进制（.doc / .xls / .ppt）'
}

/**
 * 旧版 Office 的 OLE 复合文档头：`sniffFormat` 不认它（它的判据只覆盖工作台预览认得的那几档），
 * 而 `.doc` 恰恰是用户最常丢过来的东西之一 —— 少了这一条，它会被当文本解成乱码。
 */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 认得出 OLE 头（.doc / .xls / .ppt） */
function isOle(bytes: Buffer): boolean {
  return bytes.length >= OLE_HEAD.length && bytes.subarray(0, OLE_HEAD.length).equals(OLE_HEAD)
}

/**
 * BMP 的魔数只有两个字节（`BM`），撞文本太容易了（`BMW 车型对比.txt` 这种真文本一开头就是它）。
 * 工作台那条路是"扩展名 + 魔数"两道闸，不担心；read 的文本档只有魔数这一道，所以再看一眼
 * 文件头里的 4 个保留字节（BMP 规定全 0）—— 真 BMP 照样认得出，真文本不会被误判成二进制。
 */
function looksLikeBmp(bytes: Buffer): boolean {
  return bytes.length >= 10 && bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
}

/**
 * 文本档里"这份其实是二进制/老格式"的判据（返回 `BINARY_NAME` 的键，null = 按文本读）。
 * OLE 是这里补的（`sniffFormat` 不覆盖旧版 Office），BM 是收口的（见 looksLikeBmp）。
 */
function binaryKindOf(bytes: Buffer): string | null {
  const sniffed = sniffFormat(bytes)
  if (sniffed === 'image-bmp') return looksLikeBmp(bytes) ? sniffed : null
  if (sniffed !== null) return sniffed
  return isOle(bytes) ? 'ole' : null
}

type ReadKind = 'text' | 'pdf' | 'docx' | 'image'

/** 按扩展名分派（大小写不敏感）；认不出就是**文本档** —— 与改动前逐字一致，不改变原有行为 */
function kindOf(target: string): ReadKind {
  const ext = extname(target).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  return IMAGE_MEDIA_TYPE[ext] === undefined ? 'text' : 'image'
}

/**
 * read 的审批：**一律不问**（classify 的 read 档）。
 *
 * round 75：**读图片不再单独弹卡**（用户口径："读图这种就不该审"）。在这之前图片这一支按"外发档"
 * 单独判过一次审批（把字节发给模型端点 = 把文件带出本机，所以当时要问一次）—— 用户裁定不审：
 * 读一张图与读一个文本在"用户想不想让模型看"这件事上没有区别，而且弹卡的位置（工具执行前）
 * 也说不出"这次会发多少、发给谁"。**边界照旧**：目标仍必须落在授权工作区内（执行层的
 * `toolTarget` → 引擎，区外一律 fail closed）；不能证明落点在工作区里的调用走的是 guard 的
 * 「工作区之外」那一档（见 guard.needsApproval），与其它工具同一把尺。
 *
 * 图片字节发给模型端点这件事本身**不做审批**，但做**能力门**：当前模型读不了图就不发（见
 * `readImage` 的 vision 判断）。
 */
export function readNeedsApproval(ctx: ToolContext, input: ReadInput, session?: string): boolean {
  return needsApproval(ctx, 'read', input, session)
}

/** 字节数 → 人话（回执里报的都是**真实值**，不四舍五入成整数） */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes} 字节`
}

/** 像素 → 人话（如 `17.5M 像素`） */
function formatPixels(pixels: number): string {
  return pixels >= 1_000_000 ? `${(pixels / 1_000_000).toFixed(1)}M 像素` : `${pixels} 像素`
}

/** 一张图大约多少 token（量级；按实测换算，让模型对成本有感觉。小图至少报 1） */
function estimatedTokens(width: number, height: number): number {
  return Math.max(1, Math.round((width * height) / IMAGE_PIXELS_PER_TOKEN))
}

interface ImageSize {
  width: number
  height: number
}

/** PNG：8 字节签名之后就是 IHDR（宽高各 4 字节大端） */
function pngSize(bytes: Buffer): ImageSize | null {
  return bytes.length >= 24
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : null
}

/** GIF：逻辑屏幕描述符里宽度与高度各 2 字节小端 */
function gifSize(bytes: Buffer): ImageSize | null {
  return bytes.length >= 10 ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) } : null
}

/**
 * JPEG：尺寸在 SOFn 段里（FFC0–FFCF 里除 C4/C8/CC 都是 SOF），逐段按段长跳过前面那些
 * APPn / DQT / DHT 段；遇到 SOS（扫描数据）还没见到 SOF 就认不出（返回 null，不猜）。
 */
function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 无载荷的标记（SOI / TEM / RSTn）：直接跳到下一个标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    // SOF 段：FF Cn / Lf(2) / 精度(1) / 高(2) / 宽(2)
    if (isSof)
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    if (marker === 0xda) return null
    offset += 2 + length
  }
  return null
}

/**
 * WebP：三种块头各自的尺寸位置（实测三种都过：有损 VP8 / 无损 VP8L / 扩展 VP8X）。
 * 认不出（长度不够、起始码不对）就返回 null —— 上层按"尺寸未知"放行，不拿判据卡住合法文件。
 */
function webpSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 30) return null
  const format = bytes.toString('latin1', 12, 16)
  if (format === 'VP8X') {
    // 画布尺寸：24 位小端，存的是"减一"
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    }
  }
  if (format === 'VP8 ') {
    // 帧头之后是 3 字节起始码 9d 01 2a，再是 14 位宽 + 14 位高
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) return null
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (format === 'VP8L') {
    // 签名 0x2f 之后：14 位宽-1 + 14 位高-1（小端位序）
    if (bytes[20] !== 0x2f) return null
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function imageSizeOf(bytes: Buffer, sniffed: string): ImageSize | null {
  switch (sniffed) {
    case 'image-png':
      return pngSize(bytes)
    case 'image-jpeg':
      return jpegSize(bytes)
    case 'image-gif':
      return gifSize(bytes)
    case 'image-webp':
      return webpSize(bytes)
    default:
      return null
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

interface WindowOptions {
  /** 上游已经截断过（>256KB / 抽取上限）：窗口备注里就不再说"共 N 行"（那个行数是**截过的**） */
  truncated?: boolean
  /** 前置备注（如"[已截断：…]"），排在窗口备注前面 */
  notes?: readonly string[]
  /** 回执里对这份东西的称呼（'文件' / '抽取到的正文'）：备注与报错都按它说 */
  source?: string
}

/**
 * 按行窗口切一段并附说明（文本档与抽取档共用）。**越界的 offset 明确报错**，不给静默空内容；
 * 抽取档的行数是**抽取结果**的行数（`source` 会把这件事说清）。
 */
function windowText(
  text: string,
  target: string,
  input: ReadInput,
  options: WindowOptions = {}
): string {
  const source = options.source ?? '文件'
  const lines = text.split('\n')
  const offset = input.offset ?? 1
  if (offset > lines.length) {
    throw new Error(`offset=${offset} 超出${source}行数：${target} 共 ${lines.length} 行`)
  }
  const from = offset - 1
  const to = input.limit === undefined ? lines.length : Math.min(lines.length, from + input.limit)
  const body = lines.slice(from, to).join('\n')

  const notes = [...(options.notes ?? [])]
  if (offset > 1 || to < lines.length) {
    const total = options.truncated === true ? '' : `，${source}共 ${lines.length} 行`
    notes.push(`[只显示第 ${from + 1}-${to} 行${total}]`)
  }
  return notes.length === 0 ? body : `${body}\n\n${notes.join('\n')}`
}

/**
 * 认得出的二进制 / 旧版 Office：一句人话说明它**是什么** + 下一步，不返回乱码。
 * （旧行为是把它按 UTF-8 解出来 —— 模型会以为文件坏了，或者内容是空的。）
 */
function binaryMessage(target: string, kind: string): string {
  const what = BINARY_NAME[kind] ?? kind
  const next: Record<string, string> = {
    ooxml:
      'read 只抽 .docx 的文字（xlsx / pptx / zip 都抽不了）：要表格数据请让用户导出成 CSV 再读，' +
      '要看 PPT 用 render_ppt（只吃 .pptx）。',
    pdf: '这其实是 PDF 内容：改成 .pdf 扩展名再读，我就能抽它的文字层。',
    'image-png': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-jpeg': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-gif': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-webp': '这是图片但扩展名对不上：改对扩展名（或另存一份）再读，图片我能直接看。',
    'image-bmp':
      'BMP 我看不了：让用户另存成 PNG / JPEG（或别的常见图片格式）再读 —— 那几种我能直接看。',
    ole:
      '旧版 Office 二进制（.doc / .xls / .ppt）抽不了：让用户在 Office 里另存为 .docx（Word 我能抽），' +
      '或把要看的几页截图 / 导出成图片再 read（图片我能直接看）。'
  }
  return (
    `read 没读这个文件：${target} 是二进制（文件头是 ${what}），按文本解出来只会是乱码。\n` +
    `下一步：${next[kind] ?? '确认它真实是什么格式，或换一条能处理它的路。'}`
  )
}

/** 纯文本档：原样读（含"认得出的二进制就说人话"这一道） */
async function readPlainText(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  const clipped = size > READ_MAX_BYTES
  const bytes = await ctx.fs.readFile(abs, clipped ? READ_MAX_BYTES : undefined)

  const binaryKind = binaryKindOf(bytes)
  if (binaryKind !== null) {
    return binaryMessage(target, binaryKind)
  }

  const text = new StringDecoder('utf8').write(bytes)
  const notes = clipped ? [`[已截断：文件共 ${size} 字节，只显示前 ${READ_MAX_BYTES} 字节]`] : []
  return windowText(text, target, input, { notes, truncated: clipped })
}

/** PDF 档：文字层抽取（与附件那条路同一份实现）；没有文字层/打不开都给人话 + 下一步 */
async function readPdf(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  if (size > READ_PDF_MAX_BYTES) {
    return (
      `read 没读这份 PDF：${target} 有 ${formatSize(size)}，超过单份 ${formatSize(READ_PDF_MAX_BYTES)} 的上限。\n` +
      '下一步：用 bash 在本机处理它（比如只取需要的几页），或先压缩再读。'
    )
  }

  const result = await extractPdfText(await ctx.fs.readFile(abs))
  if (!result.ok) {
    const scanned = result.message.includes('没有文字层')
    return [
      scanned
        ? `read 抽不出这份 PDF 的文字：${result.message}。`
        : `read 打不开这份 PDF：${result.message}。`,
      '下一步：本部署没有"PDF → 图片"的通路（render_ppt 只吃 .pptx），所以这份 PDF 的内容我看不到。',
      scanned
        ? '可以请用户把要问的那几页**截图或导出成图片**（PNG / JPEG），再 read 那张图 —— 图片我能直接看。'
        : '可以请用户确认文件是否完整（加密的先解密、损坏的重新导出），或把要问的那几页截图成图片再 read。'
    ].join('\n')
  }

  const notes = [`[这是 PDF 的文字层，共 ${result.pages} 页]`]
  if (result.truncated) {
    notes.push(
      `[抽取有上限（页数 ${PDF_MAX_PAGES} / 总量 ${READ_DOCUMENT_MAX_CHARS} 字符），后面的内容不在这里]`
    )
  }
  return windowText(result.text, target, input, {
    notes,
    truncated: result.truncated,
    source: '抽取到的正文'
  })
}

/** Word 档：OOXML 两道闸 + mammoth 抽 markdown；抽不动给人话 + 下一步 */
async function readDocx(
  ctx: ToolContext,
  abs: string,
  target: string,
  size: number,
  input: ReadInput
): Promise<string> {
  if (size > READ_DOCX_MAX_BYTES) {
    return (
      `read 没读这份 Word：${target} 有 ${formatSize(size)}，超过单份 ${formatSize(READ_DOCX_MAX_BYTES)} 的上限。\n` +
      '下一步：用 bash 在本机处理它，或让用户另存一份小一点的再读。'
    )
  }

  const bytes = await ctx.fs.readFile(abs)
  if (sniffFormat(bytes) !== 'ooxml') {
    return (
      `read 没读这个文件：${target} 的扩展名是 .docx，但文件头不是 OOXML（zip）—— ` +
      '它多半不是 Word 文档（改过扩展名？）。\n' +
      '下一步：确认它真实是什么格式；旧版 .doc 请在 Office 里另存为 .docx 再读。'
    )
  }

  let markdown: string
  let truncated: boolean
  try {
    ;({ markdown, truncated } = await extractDocx(bytes))
  } catch (cause) {
    return (
      `read 读不了这份 Word：${messageOf(cause)}\n` +
      '下一步：文件可能损坏或被改过；请用户在 Word 里另存一份 .docx 再试。'
    )
  }

  const clipped = markdown.length > READ_DOCUMENT_MAX_CHARS
  const notes = ['[这是 Word 文档抽成的 markdown（内嵌图片只留"（图片已省略）"占位）]']
  if (truncated || clipped) {
    notes.push(`[正文有上限（${READ_DOCUMENT_MAX_CHARS} 字符），后面的内容不在这里]`)
  }
  return windowText(
    clipped ? markdown.slice(0, READ_DOCUMENT_MAX_CHARS) : markdown,
    target,
    input,
    {
      notes,
      truncated: truncated || clipped,
      source: '抽取到的正文'
    }
  )
}

/**
 * 图片档：两道闸（扩展名 → MIME、文件头 → MIME）都过、字节与像素都在上限内，才交给模型看。
 * 四个分支都返回**人话**（模型看不了图 / 超限 / 头对不上），一个字节都不发给模型端点。
 *
 * 第一个分支（round 75）：**当前模型读不了图就不发** —— 能力判定走 `visionOf` 那套口径
 * （探测结论 > 注册表 > 保守 false），来源是本部署事实注册表（`skills/runtime` 的
 * `currentSkillRuntimeFacts`，生产由 main 侧装配时装进去，与指令里写给模型的那一行**同一份**）。
 * 判据只在**明确 false**时收手：`null`（没探到结论 / 没配 provider / 工具单测）照旧发 ——
 * 不把"不知道"当成"不能"（与 `visionOf` 的注释同一口径）。
 */
async function readImage(
  ctx: ToolContext,
  abs: string,
  rel: string,
  target: string,
  size: number
): Promise<ReadImageResult | string> {
  if (currentSkillRuntimeFacts()?.vision === false) {
    return (
      `read 没把这张图发给模型：当前模型看不了图，所以没有把 ${target} 的字节发出去` +
      '（发过去它也读不到，只会白占上下文和一次外发）。\n' +
      '下一步：要让我看这张图，请在「设置 → 模型」里换一个支持图片的模型；' +
      '也可以请用户用文字描述图里的内容，或把图里的关键文字贴出来。'
    )
  }

  if (size > READ_IMAGE_MAX_BYTES) {
    return (
      `read 没把这张图交给模型：${target} 有 ${formatSize(size)}，超过单张图片 ` +
      `${formatSize(READ_IMAGE_MAX_BYTES)} 的上限。\n` +
      '下一步：请用户先缩小 / 压缩这张图，或换成更小的一张（只截要看的区域）再读一次；这个文件的内容我看不到。'
    )
  }

  const bytes = await ctx.fs.readFile(abs)
  const sniffed = sniffFormat(bytes)
  const expected = IMAGE_MEDIA_TYPE[extname(abs).toLowerCase()] ?? 'image/png'
  const mediaType = sniffed === null ? null : (SNIFF_MEDIA_TYPE[sniffed] ?? null)
  if (sniffed === null || mediaType === null || mediaType !== expected) {
    const actual = sniffed === null ? '认不出的东西' : (BINARY_NAME[sniffed] ?? sniffed)
    return (
      `read 没把 ${target} 交给模型：文件头不是 ${expected}（看内容像是 ${actual}）。\n` +
      '下一步：确认它真实格式；改过扩展名的先把扩展名改对（或另存一份真正的 PNG / JPEG / GIF / WebP），再读一次。'
    )
  }

  const imageSize = imageSizeOf(bytes, sniffed)
  if (imageSize !== null && imageSize.width * imageSize.height > READ_IMAGE_MAX_PIXELS) {
    return (
      `read 没把这张图交给模型：${target} 是 ${imageSize.width}×${imageSize.height}` +
      `（${formatPixels(imageSize.width * imageSize.height)}，约 ${estimatedTokens(imageSize.width, imageSize.height)} ` +
      `token）—— 超过单张图片 ${formatPixels(READ_IMAGE_MAX_PIXELS)} 像素的上限。\n` +
      '下一步：请用户先缩小这张图（或只截要看的区域、另存一份小图）再读一次；它的内容我看不到。'
    )
  }

  const dimensions = imageSize === null ? '尺寸没读出来' : `${imageSize.width}×${imageSize.height}`
  const cost =
    imageSize === null ? '' : `，约 ${estimatedTokens(imageSize.width, imageSize.height)} token`
  return {
    message:
      `这是一张图片，已经交给你看了：${target}（${dimensions}，${mediaType}，` +
      `${formatSize(size)}${cost}）。看不到这张图就说看不到，不要凭文件名或尺寸推测内容。`,
    path: rel,
    abs,
    mediaType,
    bytes: size,
    ...(imageSize === null ? {} : { width: imageSize.width, height: imageSize.height })
  }
}

export async function createReadTool(ctx: ToolContext): Promise<Tool<ReadInput, ReadResult>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'read',
    description:
      'Read a workspace file. Plain text comes back as-is (offset/limit take a line window); .pdf via its text ' +
      'layer and .docx as markdown come back as extracted text; .png/.jpg/.jpeg/.webp/.gif come back as the image ' +
      'itself, for you to look at. Caps state the real numbers and never come back as empty output: 256KB of text, ' +
      '64MB PDF / 32MB Word, 64000 characters of extracted text, 8MB / 16M pixels per image. A scanned PDF with ' +
      'no text layer, a legacy .doc or any other binary is named, not returned as mojibake. Reading an image ' +
      "sends its bytes to the model endpoint (no approval step) — if the current model can't see images, " +
      'the bytes are not sent at all and you get a note saying so.',
    inputSchema: readInputSchema,
    outputSchema: readResultSchema,
    requireApproval: (input, approval) =>
      readNeedsApproval(ctx, input, approvalSessionOf(approval)),
    execute: async (input, context): Promise<ReadResult> => {
      const session = sessionKey(context)
      const { abs, workspace } = toolTarget(ctx, input.path, session)
      const fileStat = await statOrNull(ctx, abs)
      if (fileStat === null || !fileStat.isFile()) {
        throw new Error(`read 失败：${input.path} 不存在或不是文件（目录请用 glob 列出）`)
      }

      const kind = kindOf(abs)
      const result =
        kind === 'image'
          ? await readImage(
              ctx,
              abs,
              relative(workspace.path, abs).split(sep).join('/'),
              input.path,
              fileStat.size
            )
          : kind === 'pdf'
            ? await readPdf(ctx, abs, input.path, fileStat.size, input)
            : kind === 'docx'
              ? await readDocx(ctx, abs, input.path, fileStat.size, input)
              : await readPlainText(ctx, abs, input.path, fileStat.size, input)

      // 读过的路径记进当前会话（edit 的"未读先改"靠它）：抽取档与图片档也记 —— 模型确实"看过"
      // 这份文件的内容（只是经过了抽取 / 视觉）。真去 edit 一个二进制会因 oldText 匹配不上而失败，
      // 不会静默改坏文件。
      ctx.state.markRead(session, abs)
      return result
    },
    /**
     * 图片档把**原生字节**交给模型看；文本 / 抽取档返回 null（= 不做映射，原样是文本，
     * 与改动前的行为逐字一致 —— 见 mastra 侧 normalizeModelOutput 那句"nullish mapping result
     * means no special mapping needed"）。
     *
     * 形状（`{type:'file', mediaType, data:{type:'data', data:<base64>}}`）与 render_ppt 的页图**完全
     * 一致**：`image-url` 是废弃形状、`{type:'url', url:'data:…'}` 在真 DeepSeek 端点上会被
     * 8192 字符的 URL 长度校验拒掉（实测，见 tools/render-ppt.ts 头注）；`data` 里放 base64 字符串
     * 而不是 Uint8Array，是因为这份 modelOutput 会被存进 providerMetadata（过 JSON）。
     *
     * 读不到就退化成人话（不把整次调用判失败）：文件可能在 execute 之后被删/改名了。
     */
    toModelOutput: async (result: ReadResult) => {
      if (typeof result === 'string') return null
      try {
        const bytes = await ctx.fs.readFile(result.abs)
        return {
          type: 'content',
          value: [
            { type: 'text', text: result.message },
            {
              type: 'file',
              mediaType: result.mediaType,
              data: { type: 'data', data: Buffer.from(bytes).toString('base64') }
            }
          ]
        }
      } catch {
        return {
          type: 'content',
          value: [
            {
              type: 'text',
              text: `${result.message}\n（这张图在读取之后取不到了：文件可能刚被删除或改名，这次我没看到图）`
            }
          ]
        }
      }
    }
  })
}
