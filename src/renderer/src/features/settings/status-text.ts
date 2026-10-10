import type { LangfuseState, UpdateState } from '@shared/ipc'

/**
 * 设置页两处状态行的文案（T17）：纯函数单独放一份 —— 组件文件只导出组件（react-refresh 口径），
 * 文案规则也可以被单测直接钉住。
 *
 * 两条纪律：零 emoji；不解释后端怎么实现（只说用户能看到的那件事）。
 */

/** 「关于」栏：更新状态一行话 */
export function updateStatusText(state: UpdateState | null): string {
  if (state === null) return '正在读取…'
  const { status, configured } = state
  switch (status.phase) {
    case 'idle':
      return configured ? '尚未检查' : '未配置更新源'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '已是最新版本'
    case 'available':
      return status.version === undefined ? '发现新版本' : `发现新版本 ${status.version}`
    case 'downloading':
      return status.version === undefined
        ? `正在下载 ${status.percent ?? 0}%`
        : `正在下载 ${status.version}（${status.percent ?? 0}%）`
    case 'downloaded':
      return status.version === undefined
        ? '新版本已下载，重启后安装'
        : `新版本 ${status.version} 已下载`
    case 'error':
      return `检查失败：${status.message ?? '未知原因'}`
  }
}

/** 「追踪」栏：三项齐了才算"已配置"（与主进程 telemetry.ts 的判定同一口径） */
export function langfuseConfigured(state: LangfuseState): boolean {
  return state.endpoint.trim().length > 0 && state.publicKey.hasKey && state.secretKey.hasKey
}

/**
 * 「追踪」栏状态行：配置是"落盘的值"，active 是"本次运行有没有真挂上导出"——两件事分开说，
 * 所以改完配置到重启前，这行字不会撒谎。
 */
export function langfuseStatusText(state: LangfuseState | null): string {
  if (state === null) return '正在读取…'
  if (langfuseConfigured(state)) return state.active ? '已开启' : '已配置，重启应用后开启'
  return state.active ? '本次运行已开启，重启应用后停止' : '未开启'
}
