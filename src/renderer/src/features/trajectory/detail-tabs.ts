/**
 * 明细面板的页签口径（**单独一层**：文件里只放组件之外的东西，
 * 免得与 Fast Refresh 的"一个文件只导出组件"撞上）。
 *
 * 按行的类型给页签：
 *   - 工具行：概述 / 参数 / 结果 / 计时 —— 参数与结果是原文（可复制）；
 *   - 其余（用户 / 助手 / 上下文 / 压缩）：概述 / 预览 / 原始内容。
 */
import type { TrajectoryRow } from './model'

export type DetailTabId = 'overview' | 'input' | 'output' | 'timing' | 'preview' | 'raw'

export interface DetailTab {
  id: DetailTabId
  label: string
}

export function detailTabsOf(row: TrajectoryRow): DetailTab[] {
  if (row.kind === 'tool') {
    return [
      { id: 'overview', label: '概述' },
      { id: 'input', label: '参数' },
      { id: 'output', label: '结果' },
      { id: 'timing', label: '计时' }
    ]
  }
  return [
    { id: 'overview', label: '概述' },
    { id: 'preview', label: '预览' },
    { id: 'raw', label: '原始内容' }
  ]
}
