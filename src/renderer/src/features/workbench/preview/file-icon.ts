/**
 * 文件类型图标（**唯一出处**）：预览标签页的 tab 图标、预览头部那个图标块都从这张表取
 * （调用方各处各画一次会让两处慢慢走散）。
 *
 * 分档按**后缀**，判据与 `modes.ts` 的 `previewModeOf` 同一套（那边是"用哪条通道渲染"）：
 * pdf / 图片 / word / excel / ppt / 代码 / markdown / 其它（认不出的后缀 → 通用文件图标）。
 * 旧版 Office 三件（.doc/.xls/.ppt）算对应的 word / excel / ppt 档 —— 它们还是各家的文档，
 * 只是预览方式不同（见 modes.ts 的 office-legacy）。
 *
 * 图标全部来自 lucide：零 emoji（UI 雷点 1，见 docs/reference/UI-设计雷点-v1.md）。
 */
import {
  BookText,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Presentation,
  type LucideIcon
} from 'lucide-react'
import { extensionOf, previewModeOf } from './modes'

export type FileIconKind =
  'pdf' | 'image' | 'word' | 'excel' | 'ppt' | 'code' | 'markdown' | 'other'

/** 档 → 图标：pdf 是文档页、markdown 是书页（写给人看的文档）、word 是字处理、代码/图片/表格各归各的 */
const FILE_ICONS: Record<FileIconKind, LucideIcon> = {
  pdf: FileText,
  image: FileImage,
  word: FileType,
  excel: FileSpreadsheet,
  ppt: Presentation,
  code: FileCode,
  markdown: BookText,
  other: File
}

/** 后缀 → 档（先按预览分流判，旧版 Office 再按后缀细分三件） */
export function fileIconKindOf(relative: string): FileIconKind {
  const mode = previewModeOf(relative)
  if (mode === 'pdf') return 'pdf'
  if (mode === 'image') return 'image'
  if (mode === 'table') return 'excel'
  if (mode === 'pptx') return 'ppt'
  if (mode === 'docx') return 'word'
  if (mode === 'markdown') return 'markdown'
  if (mode === 'code') return 'code'
  if (mode === 'office-legacy') {
    const extension = extensionOf(relative)
    if (extension === 'doc') return 'word'
    if (extension === 'xls') return 'excel'
    if (extension === 'ppt') return 'ppt'
  }
  return 'other'
}

/** 后缀 → 图标（调用方直接 `<Icon />`） */
export function fileIconOf(relative: string): LucideIcon {
  return FILE_ICONS[fileIconKindOf(relative)]
}
