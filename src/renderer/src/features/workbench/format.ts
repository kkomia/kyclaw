/**
 * 工作台的显示口径（纯函数，单测直接打）：文件大小、时间、git 变更的中文标签与配色档。
 * 中文标签在这里收一处 —— 界面上不出现 emoji（雷点 1），也不用小字解释（雷点 2）。
 */
import type { GitChangeStatus } from '@shared/workbench'

/** 文件大小：B / KB / MB / GB（一位小数；B 不给小数） */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** ISO 时间 → `YYYY-MM-DD HH:mm`（本地时区；解析不了就原样回，不编一个假时间） */
export function formatDateTime(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ` +
    `${pad(time.getHours())}:${pad(time.getMinutes())}`
  )
}

/** 未提交变更的中文标签（porcelain 码归类的口径见 shared/workbench.ts） */
export const GIT_STATUS_LABEL: Record<GitChangeStatus, string> = {
  modified: '已修改',
  added: '已新增',
  deleted: '已删除',
  renamed: '已重命名',
  copied: '已复制',
  typechange: '类型变化',
  untracked: '未跟踪',
  conflicted: '有冲突'
}

/** 变更标签的配色档（tailwind 类名；同一个色只用一次含义） */
export const GIT_STATUS_TONE: Record<GitChangeStatus, string> = {
  modified: 'text-warning',
  added: 'text-positive',
  deleted: 'text-danger',
  renamed: 'text-ink-secondary',
  copied: 'text-ink-secondary',
  typechange: 'text-ink-secondary',
  untracked: 'text-ink-tertiary',
  conflicted: 'text-danger'
}

/**
 * `--decorate=short` 的 refs（`HEAD -> main, tag: v1.0`）拆成一块块。
 * 渲染时按每块自己的前缀上色（HEAD / tag / 远程 各一档）。
 */
export function splitRefs(refs: string): string[] {
  return refs
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** ref 的配色档：HEAD 常色、tag 走高亮、远程分支走次要灰 */
export function refTone(ref: string): string {
  if (ref.startsWith('tag:')) return 'text-warning'
  if (ref.includes('HEAD')) return 'text-accent-text'
  if (ref.includes('/')) return 'text-ink-tertiary'
  return 'text-ink-secondary'
}

/** `+N −M` 的显示（二进制文件两列都是 null） */
export function formatLineStat(additions: number | null, deletions: number | null): string {
  if (additions === null && deletions === null) return '二进制'
  return `+${additions ?? 0} −${deletions ?? 0}`
}
