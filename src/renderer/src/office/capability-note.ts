/**
 * PB-020 R1：Office 能力说明（两格式统一口径）。
 *
 * 旧做法：常驻横幅占掉编辑器第一行（`XlsxEditorPane`/`PptxEditorPane` 各一份）。
 * 新做法：首次打开该格式时显示一次（可关），之后从状态栏「能力说明」入口随取随看。
 * 文案只写事实：沙箱内不可用的能力如实说明，不给假入口。
 */
export type OfficeCapabilityKind = 'xlsx' | 'pptx'

export const OFFICE_CAPABILITY_NOTE: Record<OfficeCapabilityKind, string> = {
  xlsx: '支持编辑单元格并保存回原文件；行/列插入删除、工作表增删与深色画布暂不支持。打印、导出与演示在此沙箱内不可用。',
  pptx: '支持文字 / 形状 / 插入幻灯片等轻量编辑；删页与重排、母版与动画编辑暂不支持。演示、导出、打印在此沙箱内不可用。'
}

const SEEN_KEY = (kind: OfficeCapabilityKind): string => `kyclaw:office-capability-seen:${kind}`

/** 是否还需要显示「首次能力提示」（localStorage 不可用时按需要显示处理） */
export function shouldShowCapabilityNote(kind: OfficeCapabilityKind): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY(kind)) !== '1'
  } catch {
    return true
  }
}

/** 标记已看过（关闭一次后不再自动出现） */
export function markCapabilityNoteSeen(kind: OfficeCapabilityKind): void {
  try {
    window.localStorage.setItem(SEEN_KEY(kind), '1')
  } catch {
    // 存储不可用：退化为每次都显示，不影响编辑
  }
}
