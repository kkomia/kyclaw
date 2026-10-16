/**
 * 「添加到上下文」的注入通道（round 42）：文件树右键 / 预览选中 → 输入卡的附件条。
 * round 61 起同一个文件里还有第二条通道：「原文放回输入框」（消息动作行的「撤回」→ 草稿），
 * 问题形状与解法完全相同，见下面 `ComposerDraft` 那一段。
 *
 * 为什么是一条通道而不是 props：生产方（工作台的文件树与预览）与消费方（输入卡）在组件树上
 * 毫无交情（一个在右侧边栏、一个在对话页），而草稿与附件是 Composer 的内部 state（对外没有
 * 写入口）。这里只放一个极小 pub/sub，**不落 store、不持久化**——事件就是"用户刚做的一个动作"，
 * 没人在听（非 chat 路由 / 没有会话）就丢掉。
 *
 * 分工：发布方只报「哪个会话、哪个文件（或哪段摘选）」，**读文件与判档全在订阅方**做
 * （见 `resolveContextItem`）——于是附件口径仍然只有 composer-attachments.ts 那一处，
 * 文件树不需要知道图片 / PDF / 二进制各自怎么收。摘选的那一路没有文件可读，直接在这里成形。
 */
import { extensionOf, previewModeOf } from '@renderer/features/workbench/preview/modes'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import type { PdfExtractResult } from '@shared/attachments'
import type { FileByteFormat, FileBytesResult, FilePreview } from '@shared/workbench'
import { ATTACHMENT_MAX_BYTES, NO_VISION_MESSAGE } from './composer-attachments'
import type { PdfExtractor, PendingAttachment } from './composer-attachments'

/** 一条"添加到上下文"的请求（v1 两种形状；`threadId` 让订阅方丢掉不属于自己会话的事件） */
export type ContextItem =
  | { source: 'file'; threadId: string; relative: string; name: string }
  | {
      source: 'selection'
      threadId: string
      relative: string
      name: string
      text: string
      /** 选区在源文里的行号区间（发布方在源文在手时算；算不出就不给——订阅方不瞎编） */
      lines?: { start: number; end: number }
    }

type ContextItemListener = (item: ContextItem) => void

/** 当前挂着的订阅者（同时最多一个 Composer；这里不假设，Set 更省心） */
const listeners = new Set<ContextItemListener>()

/** 发布一条请求（同步派发；没人在听就等于没发生） */
export function publishContextItem(item: ContextItem): void {
  for (const listener of [...listeners]) listener(item)
}

/** 订阅（返回退订函数；Composer 挂载时订阅、卸载时退订） */
export function subscribeContextItems(listener: ContextItemListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 「原文放回输入框」的通道（round 61）：消息动作行的「撤回」确认后，对话页把被撤回那条
 * 用户消息的原文交给输入卡。
 *
 * 为什么还是 pub/sub：与上面那条同一个问题 —— 生产方（对话页的消息动作）与消费方（输入卡）
 * 之间没有 props 通路可走（草稿是 Composer 的内部 state，对话页拿不到写入口）。口径也照旧：
 * **不落 store、不持久化**，带 threadId 做归属过滤，没人在听（非对话路由）就丢掉。
 *
 * round 76：这条通道上又多了一类生产方（初始页的「能力入口」胶囊，点一下把起始提示词填进输入框），
 * 它要的是**追加**而不是替换 —— 用户可能已经敲了半句话，点胶囊不该把它抹掉。于是多一个 `mode`
 * 参数：缺省 `'replace'`（撤回回填的既有语义，**不能动**），`'append'` 由能力入口显式要。
 * 两种语义的落点都在订阅方（Composer）：那里才知道输入框里现在有什么。
 */
export interface ComposerDraft {
  threadId: string
  /** 要放进输入框的文本（撤回时 = 被撤回那条用户消息的原文） */
  text: string
  /** `'replace'` = 整段替换（缺省，撤回那条路）；`'append'` = 空框填入、非空则追加到末尾 */
  mode?: 'replace' | 'append'
}

type ComposerDraftListener = (draft: ComposerDraft) => void

/** 当前挂着的订阅者（同时最多一个 Composer；与上面同理，Set 更省心） */
const draftListeners = new Set<ComposerDraftListener>()

/** 发布一次「把这段原文放回输入框」（同步派发；没人在听就等于没发生） */
export function publishDraft(draft: ComposerDraft): void {
  for (const listener of [...draftListeners]) listener(draft)
}

/** 订阅草稿回填（返回退订函数；Composer 挂载时订阅、换会话/卸载时退订） */
export function subscribeDrafts(listener: ComposerDraftListener): () => void {
  draftListeners.add(listener)
  return () => {
    draftListeners.delete(listener)
  }
}

/** 订阅方要用的那条通道（Composer 传 `window.kyclaw.workbench`；单测传桩） */
export interface ContextChannel {
  readFile: (threadId: string, relative: string) => Promise<FilePreview>
  readBytes: (threadId: string, relative: string) => Promise<FileBytesResult>
}

export interface ResolveContextOptions {
  /** 工作区通道（缺失 = 浏览器 / 单测没装桥：给人话，不抛） */
  channel: ContextChannel | null
  /** 当前模型能不能看图（图片的收/拒与 ＋ 上传同一口径） */
  vision: boolean
  /** 主进程的 PDF 抽取（与 ＋ 上传同一条） */
  extractPdf: PdfExtractor
  /** 附件 id（调用方给，保证附件条上的 key 不撞） */
  id: string
}

/**
 * 一次收下的结果：要么是待发附件（`note` = 顺带给用户的一句人话，如截断），
 * 要么是一句"为什么没收"（**只给原因**，调用方按 ＋ 上传的既有形状包成「未附加：名字（原因）」）。
 */
export type ContextItemResult =
  { attachment: PendingAttachment; note?: string } | { problem: string }

/** 认不出的格式（二进制 / 后缀与文件头对不上）时的固定人话 */
export const CONTEXT_UNSUPPORTED = '这个格式暂不支持加入上下文'

/**
 * **能进模型请求体**的图片格式（字节通道的格式枚举 → MIME）。这是**模型附件白名单**，
 * 与工作台预览那张 `IMAGE_MIME` 表是两回事，刻意不共用：
 *   - 预览表会加 `image-svg` / `image-ico`（渲染端要能画它们），但矢量图多数视觉端点不收；
 *   - 白名单只列**光栅**五种，**新增格式要显式加这一行**（不跟前缀、不跟预览表漂）。
 *
 * 取值与 `@shared/attachments` 的 `IMAGE_MEDIA_TYPES`（＋ 上传那条路）同一组格式；
 * 那边按 mime 串认、这边按格式枚举认，谁改都要记得对齐。
 */
export const VISION_ATTACHMENT_FORMATS: Readonly<Partial<Record<FileByteFormat, string>>> = {
  'image-png': 'image/png',
  'image-jpeg': 'image/jpeg',
  'image-gif': 'image/gif',
  'image-webp': 'image/webp',
  'image-bmp': 'image/bmp'
}

/** 文件不在磁盘上了（与主进程 workbench 的同口径说法） */
const FILE_GONE = '这个文件不在磁盘上了（可能刚被删除或改名）'

/** 文本上限的说法（与 composer-attachments 的拒收文案同一份数字口径） */
const TEXT_LIMIT_LABEL = `${ATTACHMENT_MAX_BYTES / 1024}KB`

/**
 * 把一个请求解析成附件（或拒收原因）。**唯一的读文件入口**：
 * 文本走 `readFile`（有界文本通道），图片 / PDF 走 `readBytes`（按格式的字节通道），
 * 摘选直接用事件里带的文字（不读文件）。
 * round 53：文本通道装不下的（二进制 / 超大 / 超 16KB）退回**相对路径引用**，不再拒收；
 * 小文本照旧内联（这条路的既有行为不动）。
 */
export async function resolveContextItem(
  item: ContextItem,
  options: ResolveContextOptions
): Promise<ContextItemResult> {
  if (item.source === 'selection') return selectionAttachment(item, options.id)
  if (options.channel === null) return { problem: '工作台通道不可用（window.kyclaw 缺失）' }
  const mode = previewModeOf(item.relative)
  // 矢量图（svg/ico）：预览要能画它们，但**不发进模型请求**（见 VISION_ATTACHMENT_FORMATS）。
  // 退回文本那条路：svg 是文本格式，装得下就内联源码（模型读得到）；ico 这类二进制拿到的是
  // **路径引用**（与 round 53 起"二进制 / 超限 → 相对路径"完全同一条既有路，chip 照常进附件条）。
  if (mode === 'image' && VECTOR_IMAGE_EXTENSIONS.includes(extensionOf(item.relative))) {
    return textAttachment(item, options, options.channel)
  }
  if (mode === 'image') return imageAttachment(item, options, options.channel)
  if (mode === 'pdf') return pdfAttachment(item, options, options.channel)
  return textAttachment(item, options, options.channel)
}

/** 矢量图后缀：预览要能画它们（渲染器接得住），但**不发进模型请求**（多数视觉端点不收矢量图） */
const VECTOR_IMAGE_EXTENSIONS: readonly string[] = ['svg', 'ico']

/** 摘选：文字已在事件里；超上限按**字节**截断（与 ＋ 上传的 16KB 同一把尺），不整段拒收 */
function selectionAttachment(
  item: Extract<ContextItem, { source: 'selection' }>,
  id: string
): ContextItemResult {
  if (item.text.trim() === '') return { problem: '没有选中文字' }
  const clipped = truncateToBytes(item.text, ATTACHMENT_MAX_BYTES)
  return {
    attachment: {
      id,
      name: item.name,
      size: utf8ByteLength(clipped.text),
      text: clipped.text,
      // round 42 二轮：摘选进消息时带**路径 + 位置**（【引用】文件：…（第 X–Y 行）），卡片也按引用卡画
      relative: item.relative,
      quote: true,
      lines: item.lines
    },
    note: clipped.truncated
      ? `已截断：${item.name} 超过 ${TEXT_LIMIT_LABEL}，只收下前面一部分`
      : undefined
  }
}

/**
 * 文本类：读有界文本通道。装得下的照旧内联（文件树那条路既有的行为不动）；
 * 装不下的（二进制 / 超大 / 超 16KB）**不再拒收** —— round 53 起退回**路径引用**
 * （相对路径本就在手上；与 ＋ 上传 / 拖拽的非图片非 PDF 口径一致，见 composer-attachments.ts）。
 */
async function textAttachment(
  item: Extract<ContextItem, { source: 'file' }>,
  options: ResolveContextOptions,
  channel: ContextChannel
): Promise<ContextItemResult> {
  let preview: FilePreview
  try {
    preview = await channel.readFile(item.threadId, item.relative)
  } catch (error) {
    return { problem: unwrapIpcError(error) }
  }
  if (
    preview.kind === 'binary' ||
    preview.kind === 'too-large' ||
    preview.size > ATTACHMENT_MAX_BYTES
  ) {
    return {
      attachment: {
        id: options.id,
        name: item.name,
        size: preview.size,
        path: item.relative
      }
    }
  }
  return {
    attachment: {
      id: options.id,
      name: item.name,
      size: preview.size,
      text: preview.text,
      // 整文件也带相对路径（别让模型只拿到裸文件名）
      relative: item.relative
    }
  }
}

/** 图片：先过视觉能力（与 ＋ 上传同一句人话），再取字节做 data URL */
async function imageAttachment(
  item: Extract<ContextItem, { source: 'file' }>,
  options: ResolveContextOptions,
  channel: ContextChannel
): Promise<ContextItemResult> {
  if (!options.vision) return { problem: NO_VISION_MESSAGE }
  const read = await readBytesOf(item, channel)
  if (!read.ok) return { problem: read.problem }
  /**
   * 只认**模型附件白名单**（`VISION_ATTACHMENT_FORMATS`，光栅五种），不用 `format.startsWith('image-')`
   * 放行、也不借预览那张 MIME 表：预览把 svg / ico 收进"图片"是工作台要画它们，而按前缀放行会以
   * `image/svg+xml`（或回落 `application/octet-stream`）发进模型请求，多数视觉端点直接 400。
   * 白名单外的一律按"不支持"拒收，由调用方退回路径引用那条路。
   */
  const mediaType = VISION_ATTACHMENT_FORMATS[read.format]
  if (mediaType === undefined) return { problem: CONTEXT_UNSUPPORTED }
  return {
    attachment: {
      id: options.id,
      name: item.name,
      size: read.size,
      image: { url: toDataUrl(read.bytes, mediaType), mediaType }
    }
  }
}

/** PDF：取字节后走主进程抽文字层（扫描件 / 加密都在抽取那一步给人话） */
async function pdfAttachment(
  item: Extract<ContextItem, { source: 'file' }>,
  options: ResolveContextOptions,
  channel: ContextChannel
): Promise<ContextItemResult> {
  const read = await readBytesOf(item, channel)
  if (!read.ok) return { problem: read.problem }
  if (read.format !== 'pdf') return { problem: CONTEXT_UNSUPPORTED }
  let extracted: PdfExtractResult
  try {
    extracted = await options.extractPdf(read.bytes)
  } catch (error) {
    return { problem: unwrapIpcError(error) }
  }
  if (extracted.ok === false) return { problem: extracted.message }
  return {
    attachment: {
      id: options.id,
      name: item.name,
      size: read.size,
      text: extracted.text,
      pdf: { pages: extracted.pages, truncated: extracted.truncated },
      // PDF 的文字层也是"从哪个文件来的"，一并带上
      relative: item.relative
    }
  }
}

type BytesRead =
  | { ok: true; format: FileByteFormat; bytes: Uint8Array; size: number }
  | { ok: false; problem: string }

/** 字节通道的四种判别结果翻成人话（`too-large` 的上限用主进程回的值，不猜） */
async function readBytesOf(
  item: Extract<ContextItem, { source: 'file' }>,
  channel: ContextChannel
): Promise<BytesRead> {
  let result: FileBytesResult
  try {
    result = await channel.readBytes(item.threadId, item.relative)
  } catch (error) {
    return { ok: false, problem: unwrapIpcError(error) }
  }
  if (result.kind === 'missing') return { ok: false, problem: FILE_GONE }
  if (result.kind === 'too-large') {
    return { ok: false, problem: `超过 ${result.limit / 1024 / 1024}MB` }
  }
  if (result.kind === 'unsupported') return { ok: false, problem: CONTEXT_UNSUPPORTED }
  if (result.kind !== 'bytes') return { ok: false, problem: CONTEXT_UNSUPPORTED }
  return { ok: true, format: result.format, bytes: result.bytes, size: result.size }
}

/** 原字节 → data URL（与 preview/ImagePreview 同一配方：分块拼串，一次性 apply 大数组会爆栈） */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const encoder = new TextEncoder()

/** UTF-8 的字节数（附件上限是按字节算的，不是按字符） */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 按**字节**截断到上限：二分找最长的、UTF-8 后不超上限的前缀
 * （不是按字符数切——中文一个字三字节，按字数切会超上限；代理对也不劈开）。
 */
export function truncateToBytes(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  if (low > 0 && isHighSurrogate(text.charCodeAt(low - 1))) low -= 1
  return { text: text.slice(0, low), truncated: true }
}

/** 第 index 个字符落在源文的第几行（1 基；index 按 UTF-16 下标） */
function lineAt(source: string, index: number): number {
  let line = 1
  const upto = Math.min(Math.max(index, 0), source.length)
  for (let i = 0; i < upto; i += 1) if (source[i] === '\n') line += 1
  return line
}

/**
 * 选区在**源文**里的行号区间（1 基闭区间）。发布方（预览那侧，源文在手）用它算位置。
 *
 * 两条路：
 *   1. 整段能原样对上（文本 / 代码预览是源文保真）→ 一步到位；
 *   2. markdown 预览的 DOM 已经不是源文的样子（标题去掉了 `#`、行内标记被改写）→ **尽力**：
 *      拿选区的**首行**在源文里从头搜、**末行**从尾搜，两端都命中才算数
 *      （Chromium 的选区文本在块之间插换行，所以首行/末行正好是首段/末段的文字）。
 * 两条都不成立就返回 null —— **算不出就省略位置，不瞎编**。
 */
export function linesOfSelection(
  source: string,
  selected: string
): { start: number; end: number } | null {
  const trimmed = selected.trim()
  if (trimmed === '' || source === '') return null

  const whole = source.indexOf(trimmed)
  if (whole !== -1) {
    return { start: lineAt(source, whole), end: lineAt(source, whole + trimmed.length - 1) }
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (first === undefined || last === undefined) return null
  const startIndex = source.indexOf(first)
  const endIndex = source.lastIndexOf(last)
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null
  return { start: lineAt(source, startIndex), end: lineAt(source, endIndex + last.length - 1) }
}
