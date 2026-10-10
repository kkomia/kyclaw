/**
 * 系统通知（spec §7.2：切走生成继续、完成发系统通知）。
 * 渲染端 Web Notification：Electron 会转成系统级通知（Windows = 通知中心 Toast）。
 * 环境不支持（jsdom 单测 / 权限被拒）就静默跳过——应用内还有侧栏的"完成点"兜底。
 */
export function notifyTurnDone(threadTitle: string): void {
  const NotificationCtor = globalThis.Notification as typeof Notification | undefined
  if (NotificationCtor === undefined) return

  const body = `「${threadTitle}」的新回复已完成`
  try {
    if (NotificationCtor.permission === 'granted') {
      new NotificationCtor('kyclaw', { body })
      return
    }
    if (NotificationCtor.permission === 'default') {
      void NotificationCtor.requestPermission().then((permission) => {
        if (permission === 'granted') new NotificationCtor('kyclaw', { body })
      })
    }
  } catch {
    /* 通知失败不影响任何主流程 */
  }
}
