/** 笔记页的小格式化（保存态时间 / 列表次行时间）——都按本机时区显示，不引日期库。 */
export function clockLabel(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** 列表次行：今天显示 HH:mm，更早显示 M月D日 */
export function listTimeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return clockLabel(iso)
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/** 搜索命中行第二行：snippet（主进程已压过空白；空则退回列表摘要） */
export function rowMetaText(excerpt: string, updatedAt: string): string {
  const text = excerpt.trim()
  if (text !== '') return text
  return listTimeLabel(updatedAt)
}
