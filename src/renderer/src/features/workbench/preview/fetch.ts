/**
 * 预览的"取内容"这一段（round 50 从 FilesTool 抽出来共用；**行为逐字不变**）。
 *
 * 分流规则全在 `modes.ts`（按后缀）：文本 / markdown / 代码走 `workbench:read-file`（有界文本），
 * 图片 / PDF / 办公三件 / 表格走 `workbench:read-bytes`（原始字节或主进程抽好的结构）。
 * 唯一不读文件的是旧版 Office（`.doc/.xls/.ppt`）—— 直接是"已就绪、没有 value"的状态，
 * 人话由 `PreviewBody` 收口。
 *
 * 两个出口：
 *   - `readPreview`：**无状态**的读一次（给"只为显示"的调用方，如预览标签）；
 *   - `readPreviewState`：同一次读，另外带上**是哪个会话的哪份文件**（给要丢弃晚到响应的调用方，
 *     如 FilesTool 的内联预览 —— 它会在一次读还没回来时又点了别的文件）。
 */
import type { FileBytesResult, FilePreview } from '@shared/workbench'
import type { KyclawWorkbenchApi } from '@shared/ipc'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { previewModeOf, type PreviewMode } from './modes'

/** 预览拿到的值：文本通道（`FilePreview`）与字节通道（`FileBytesResult`）各一路 */
export type PreviewValue =
  { channel: 'text'; preview: FilePreview } | { channel: 'bytes'; bytes: FileBytesResult }

/** 一份预览"读到什么了"（不含路径/线程这种"看的是谁"的记账） */
export interface LoadedPreview {
  /** 按后缀定下来的渲染方式（决定走哪条通道、哪个组件） */
  mode: PreviewMode
  status: 'loading' | 'ready' | 'error'
  value?: PreviewValue
  error?: string
}

/** 读一次的结果 + "这是谁的"（晚到的响应据此丢弃） */
export interface PreviewState extends LoadedPreview {
  /** 属于哪个线程 */
  threadId: string
  /** 看的是哪个文件（工作区相对路径） */
  relative: string
}

/** 相对路径的**文件名**（预览条与标签标题都用它；正反斜杠都认） */
export function baseNameOf(relative: string): string {
  const index = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'))
  return index === -1 ? relative : relative.slice(index + 1)
}

/**
 * 读一份文件 → 一条已定稿的预览状态（`ready` / `error`）。
 * 旧版 Office 不读文件（同步就绪，没有 value）；其余按 `modes.ts` 的两条通道取内容。
 */
export async function readPreview(
  workbench: KyclawWorkbenchApi,
  threadId: string,
  relative: string
): Promise<LoadedPreview> {
  const mode = previewModeOf(relative)
  // 旧版 Office（.doc/.xls/.ppt）：不读文件，直接给人话（"另存为 .docx/.xlsx/.pptx"）
  if (mode === 'office-legacy') return { mode, status: 'ready' }

  // 图片 / PDF 拉原始字节，办公三件与表格拉"抽好的结构"（都在字节通道上）；
  // 文本 / markdown / 代码走文本通道（64KB 有界，承载不了上面的真渲染）
  const remote = mode !== 'text' && mode !== 'markdown' && mode !== 'code'
  const request = remote
    ? workbench
        .readBytes(threadId, relative)
        .then((bytes): PreviewValue => ({ channel: 'bytes', bytes }))
    : workbench
        .readFile(threadId, relative)
        .then((preview): PreviewValue => ({ channel: 'text', preview }))
  return request.then(
    (value): LoadedPreview => ({ mode, status: 'ready', value }),
    (error: unknown): LoadedPreview => ({ mode, status: 'error', error: unwrapIpcError(error) })
  )
}

/** 同 `readPreview`，另外记下"这是哪个会话的哪份文件"（见头注） */
export async function readPreviewState(
  workbench: KyclawWorkbenchApi,
  threadId: string,
  relative: string
): Promise<PreviewState> {
  return { threadId, relative, ...(await readPreview(workbench, threadId, relative)) }
}
