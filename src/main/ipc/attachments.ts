/**
 * 附件通道的 handler（模块 2）：目前只有 PDF 文字层抽取。
 *
 * 为什么要主进程：抽取要跑 pdfjs（Node 侧能力），渲染端要保持零新依赖；顺带把"这份 PDF 有多大"
 * 的护栏放在同一边（抽取函数自己会判上限，超限回人话而不是 IPC 错误）。
 * 入参走 `parseIpcArgs` 同一道闸门（形状对了才进抽取）；回包是产品语言（`{ok:false,message}`）。
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS, parseIpcArgs, pdfExtractArgsSchema } from '../../shared/ipc'
import { extractPdfText } from '../pdf'

export function registerAttachmentsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.attachments.extractPdf, (_event, ...args) => {
    const [bytes] = parseIpcArgs(pdfExtractArgsSchema, args, IPC_CHANNELS.attachments.extractPdf)
    return extractPdfText(bytes)
  })
}
