import { useState } from 'react'
import { ErrorCard } from './ErrorCard'

/**
 * PB-038：启动失败态（endpoint 解析失败）的唯一出口。
 *
 * 不再承诺「再跑一次」——服务端/内核没起来时重试同一个端点只会再失败；这里只提供真正的
 * `app.relaunch()`（main 侧 `app:relaunch`，有退出守卫）。三种回包：
 *   - ok：已安排重启，窗口会关 → 按钮保持 disabled +「正在重启…」，不再等后续状态；
 *   - unsaved-documents：**没有重启**，提示先保存未保存的 Office 文档（不绕过退出守卫）；
 *   - relaunch-failed / IPC 抛错：提示手动关闭并重开。
 * 无推送事件：状态全在本地，按钮点完不复位到可点（除非明确失败）。
 */
export function StartupFailureCard({ error }: { error: Error }): React.JSX.Element {
  const [relaunching, setRelaunching] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const restart = async (): Promise<void> => {
    if (relaunching) return
    setRelaunching(true)
    setNote(null)
    try {
      const result = await window.kyclaw.app.relaunch()
      if (result.ok) return // 窗口即将关闭：保持「正在重启…」，不假装回到可操作
      setRelaunching(false)
      setNote(
        result.reason === 'unsaved-documents'
          ? '有未保存的文档，请先保存再重启。'
          : '重启失败，请手动关闭并重新打开应用。'
      )
    } catch {
      setRelaunching(false)
      setNote('重启失败，请手动关闭并重新打开应用。')
    }
  }

  return (
    <ErrorCard
      error={error}
      onRetry={() => {
        void restart()
      }}
      retryLabel={relaunching ? '正在重启…' : '重启应用'}
      retryDisabled={relaunching}
      retryHint="重启后会重新加载内核"
      retryNote={note}
    />
  )
}
