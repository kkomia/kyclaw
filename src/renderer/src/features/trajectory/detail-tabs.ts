/**
 * 明细面板的页签口径（**单独一层**：文件里只放组件之外的东西，
 * 免得与 Fast Refresh 的"一个文件只导出组件"撞上）。
 *
 * 按行的类型给页签：
 *   - 工具行：概述 / 参数 / 结果 / 计时 —— 参数与结果是原文（可复制）；
 *   - 请求行（系统 / 上下文；用户反馈 015）：概述 / 预览 / **请求** / 原始内容 ——
 *     「请求」那一页按行上的 `request.id` 取**这一次请求的全部消息**（系统 / 用户 / 记忆 /
 *     规矩 / 工具与后续工具结果）；正文按需取（一条请求实测 ~96 KB，列表不背它）；
 *   - 请求失败行（provider 报错时拿不到请求体）：概述 / 原始内容；
 *   - 其余（用户 / 助手 / 压缩）：概述 / 预览 / 原始内容。
 */
import type { TrajectoryRow } from './model'

export type DetailTabId = 'overview' | 'input' | 'output' | 'timing' | 'preview' | 'request' | 'raw'

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
  if (row.request !== null) {
    if (row.request.status === 'error') {
      return [
        { id: 'overview', label: '概述' },
        { id: 'raw', label: '原始内容' }
      ]
    }
    return [
      { id: 'overview', label: '概述' },
      { id: 'preview', label: '预览' },
      { id: 'request', label: '请求' },
      { id: 'raw', label: '原始内容' }
    ]
  }
  return [
    { id: 'overview', label: '概述' },
    { id: 'preview', label: '预览' },
    { id: 'raw', label: '原始内容' }
  ]
}
