import {
  AlignLeft,
  FileImage,
  FileText,
  FileType,
  Globe,
  Presentation,
  Sheet,
  type LucideIcon
} from 'lucide-react'
import type { OfficeTabKind } from './office-tabs-store'

/** 内容区 tabpanel 的固定 id（标签的 aria-controls 与 OfficePage 共用） */
export const OFFICE_PANEL_ID = 'office-panel'

/** 标签类型 → 中文名（标签 tooltip / 内容区占位共用） */
export const OFFICE_KIND_LABEL: Record<OfficeTabKind, string> = {
  docx: 'Word 文档',
  pptx: 'PPT 演示文稿',
  xlsx: 'Excel 表格',
  pdf: 'PDF',
  image: '图片',
  text: '文本',
  web: '网页'
}

/** 标签类型 → 图标（标签条与「打开文件」列表共用同一张表） */
export const OFFICE_KIND_ICON: Record<OfficeTabKind, LucideIcon> = {
  docx: FileText,
  pptx: Presentation,
  xlsx: Sheet,
  pdf: FileType,
  image: FileImage,
  text: AlignLeft,
  web: Globe
}
