/**
 * 预览的"取内容"这一段（round 50 从 FilesTool 抽出来共用）。
 *
 * 分流规则全在 `modes.ts`（按后缀）。四条通道：
 *   - 文本 / markdown / 代码 → **`workbench:read-text-page`**（文本分页：第一页在这儿取，
 *     之后由 `PagedTextBody` 按游标续读、"加载更多"、版本变了提示重读 —— 见 `dsh-media/paged-text.tsx`；
 *     旧的 `workbench:read-file` 仍是 @ 引用/附件那条路的通道，不走这里）；
 *   - 图片 / PDF / **HTML** → `workbench:read-bytes`（原始字节；PDF 交给既有 `PdfPreview`、
 *     图片交给 `DshImageBody`、HTML 交给 `DshHtmlViewer` 的静态隔离预览）；
 *   - 表格（xls/xlsx/csv/tsv）→ `workbench:table-bytes`（**原始字节**，渲染端自己解析）；
 *   - 办公档（doc/docx/ppt/pptx）→ `workbench:office-pdf`（主进程转 PDF；**不在这里读**，
 *     只交出一个"转换口"，由 `DshOfficeViewer` 挂载时按需发起、取消时真发 IPC）。
 *
 * 两个出口：
 *   - `readPreview`：**无状态**的读一次（给"只为显示"的调用方，如预览标签）；
 *   - `readPreviewState`：同一次读，另外带上**是哪个会话的哪份文件**（给要丢弃晚到响应的调用方，
 *     如 FilesTool 的内联预览 —— 它会在一次读还没回来时又点了别的文件）。
 */
import type { KyclawWorkbenchApi } from '@shared/ipc'
import type { FileBytesResult, TableByteFormat, TableBytesResult } from '@shared/workbench'
import type { TextPage, TextPageResult } from '@shared/workbench-text'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { formatBytes } from '../format'
import { officeLoadFor, type OfficeLoadHandle } from './dsh-document/office-bridge'
import type { TextPager } from './dsh-media/text-pager'
import { previewModeOf, type PreviewMode } from './modes'

/**
 * 预览只用到工作台面的这几个方法。
 * 收窄到 `Pick<…>` 是为了让单测喂一个小对象就够（不必造整份 `KyclawWorkbenchApi`），
 * 同时**签名仍然来自真合同**（`shared/ipc.ts`），不是另写一份。
 * 这几条通道主进程 / preload 都已经接线（`workbench:read-text-page` / `workbench:text-version` /
 * `workbench:office-pdf` / `workbench:cancel-office-pdf` / `workbench:table-bytes`），
 * 所以这里不再有"通道没接上"的兜底分支 —— 契约是静态的，缺了编译期就炸。
 */
export type PreviewWorkbench = Pick<
  KyclawWorkbenchApi,
  'readTextPage' | 'textVersion' | 'readBytes' | 'tableBytes' | 'officePdf' | 'cancelOfficePdf'
>

/** 表格那一支的字节（主进程只给字节与格式，解析在渲染端） */
export interface TableBytes {
  readonly bytes: Uint8Array
  readonly format: TableByteFormat
  readonly size: number
}

/**
 * 文本那一支的取数口：第一页（`page`）已经在手上，续读/探版本走 `pager`。
 * 把"活句柄"放进值时与 `office` 那条同路数 —— 状态里存的是能力，不是数据副本。
 */
export interface TextPagePreview {
  readonly page: TextPage
  readonly pager: TextPager
}

/** 预览拿到的值：文本分页、字节通道、表格原始字节通道各一路 */
export type PreviewValue =
  | { channel: 'text-page'; textPage: TextPagePreview }
  | { channel: 'bytes'; bytes: FileBytesResult }
  | { channel: 'table'; table: TableBytes }

/** 一份预览"读到什么了"（不含路径/线程这种"看的是谁"的记账） */
export interface LoadedPreview {
  /** 按后缀定下来的渲染方式（决定走哪条通道、哪个组件） */
  mode: PreviewMode
  status: 'loading' | 'ready' | 'error'
  value?: PreviewValue
  /**
   * 办公档那一支的转换口（`mode === 'office'` 且通道可用时才有）：**转换不在这里发生** ——
   * 组件挂载时按需转，卸载/换文件时 `AbortSignal` 会被翻译成 `cancelOfficePdf(requestId)`。
   */
  office?: OfficeLoadHandle
  error?: string
}

/** 读一次的结果 + "这是谁的"（晚到的响应据此丢弃） */
export interface PreviewState extends LoadedPreview {
  /** 属于哪个线程 */
  threadId: string
  /** 看的是哪个文件（工作区相对路径） */
  relative: string
}

/** 通道名与错误码的单一来源都在 `shared/office-preview.ts`；渲染端这里只负责翻成组件要的形状 */

/** 相对路径的**文件名**（预览条与标签标题都用它；正反斜杠都认） */
export function baseNameOf(relative: string): string {
  const index = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'))
  return index === -1 ? relative : relative.slice(index + 1)
}

/**
 * 预览手里能拿来比对位置的**源文**：只有"整份都在手里"的文本预览才有 —— 也就是**一页读完**
 * （`page.eof`）的那些；分页中（还有没加载的部分）一律给 null：此时界面上的文本比这一页长，
 * 拿第一页去算行号会给出**错的**行号，宁可让摘选不带行号。
 * 字节 / 表格通道也没有可比对的文本 → null。
 * 内联预览与预览标签都拿它喂给 `SelectionContextMenu`（见那件头注）。
 */
export function sourceTextOf(state: LoadedPreview): string | null {
  const value = state.value
  if (value === undefined || value.channel !== 'text-page') return null
  return value.textPage.page.eof ? value.textPage.page.text : null
}

/**
 * 文本分页的取数口（给 `PagedTextBody` 续读与探版本用）。
 * 与 `officeLoadFor` 同路数：把"通道能力"收成一个形状固定的对象，组件不碰 `window.kyclaw`。
 */
export function textPagerFor(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string
): TextPager {
  return {
    readPage: (cursor) => workbench.readTextPage(threadId, relative, cursor),
    version: () => workbench.textVersion(threadId, relative)
  }
}

/** 文本分页读不到第一页时的人话（与旧文本通道同一批说法，不另造一套）。 */
function textPageFailureText(result: Exclude<TextPageResult, { kind: 'page' }>): string {
  switch (result.kind) {
    case 'binary':
      return `这是二进制文件（${formatBytes(result.size)}）`
    case 'too-large':
      return `文件太大（${formatBytes(result.size)}），不适合在这里预览`
    case 'missing':
      return '这个文件不在磁盘上了（可能刚被删除或改名）'
    case 'changed':
      return '读取的时候文件正在被改动，稍后再试一次'
  }
}

/**
 * 文本 / markdown / 代码：**第一页**从分页通道取（带版本与游标），续读交给组件。
 * 读不到（二进制/过大/没了/正在改）翻成人话走既有的错误落点 —— 与表格那条同一口径。
 */
async function textPreviewState(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string,
  mode: PreviewMode
): Promise<LoadedPreview> {
  try {
    const result = await workbench.readTextPage(threadId, relative, null)
    if (result.kind !== 'page') {
      return { mode, status: 'error', error: textPageFailureText(result) }
    }
    return {
      mode,
      status: 'ready',
      value: {
        channel: 'text-page',
        textPage: { page: result, pager: textPagerFor(workbench, threadId, relative) }
      }
    }
  } catch (error) {
    return { mode, status: 'error', error: unwrapIpcError(error) }
  }
}

/** 表格通道的四种"没读到字节"都给人话（分别是"过大 / 认不出 / 没了 / 正在改"）。 */
function tableFailureText(result: TableBytesResult): string {
  switch (result.kind) {
    case 'too-large':
      return `这份表格太大（超过 ${formatBytes(result.limit)}），不适合在这里预览`
    case 'unsupported':
      return '认不出这份表格（后缀和文件内容对不上）'
    case 'missing':
      return '这个文件不在磁盘上了（可能刚被删除或改名）'
    case 'changed':
      return '读取的时候文件正在被改动，稍后再试一次'
    default:
      return '读不了这份表格'
  }
}

/** 办公档：只交出转换口（不读文件、不转） */
function officePreviewState(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string
): LoadedPreview {
  return { mode: 'office', status: 'ready', office: officeLoadFor(workbench, threadId, relative) }
}

/** 表格：整份原始字节拉回来（解析交给渲染端的 `ExcelPreview`） */
async function tablePreviewState(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string
): Promise<LoadedPreview> {
  try {
    const result = await workbench.tableBytes(threadId, relative)
    if (result.kind !== 'bytes') {
      return { mode: 'table', status: 'error', error: tableFailureText(result) }
    }
    return {
      mode: 'table',
      status: 'ready',
      value: {
        channel: 'table',
        table: { bytes: result.bytes, format: result.format, size: result.size }
      }
    }
  } catch (error) {
    return { mode: 'table', status: 'error', error: unwrapIpcError(error) }
  }
}

/**
 * 读一份文件 → 一条已定稿的预览状态（`ready` / `error`）。
 * 办公档不读文件（只交转换口）；文本/markdown/代码取**第一页**（续读在组件里）；其余走字节通道。
 */
export async function readPreview(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string
): Promise<LoadedPreview> {
  const mode = previewModeOf(relative)
  if (mode === 'office') return officePreviewState(workbench, threadId, relative)
  if (mode === 'table') return tablePreviewState(workbench, threadId, relative)
  if (mode === 'text' || mode === 'markdown' || mode === 'code') {
    return textPreviewState(workbench, threadId, relative, mode)
  }

  // 图片 / PDF / HTML 拉原始字节（文本那三档上面已经分流）
  return workbench.readBytes(threadId, relative).then(
    (bytes): LoadedPreview => ({ mode, status: 'ready', value: { channel: 'bytes', bytes } }),
    (error: unknown): LoadedPreview => ({ mode, status: 'error', error: unwrapIpcError(error) })
  )
}

/** 同 `readPreview`，另外记下"这是哪个会话的哪份文件"（见头注） */
export async function readPreviewState(
  workbench: PreviewWorkbench,
  threadId: string,
  relative: string
): Promise<PreviewState> {
  return { threadId, relative, ...(await readPreview(workbench, threadId, relative)) }
}
