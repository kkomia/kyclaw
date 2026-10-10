import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { UpdateState } from '@shared/ipc'
import { updateStatusText } from './status-text'

/**
 * 设置页「关于」组（T17）：当前版本 + 手动"检查更新" + 一行状态。
 *
 * 分工：
 *   - 状态由主进程推（`updates:onStateChanged`），挂载时先拉一次（推送只对已在听的渲染端有效）；
 *   - "检查更新" 走 `updates:check`：等"检查"这一步落地（下载在后台继续，进度继续推）；
 *   - 没配更新源时按钮禁用、状态写「未配置更新源」——**不报错、不弹窗、不发网络请求**
 *     （开发态与未配置的默认路径）；
 *   - 有新版本时按钮变「重启并安装」：安装是用户点的动作（主进程 `autoInstallOnAppQuit = false`），
 *     检出后自动下载、进度显示在状态行里。
 *
 * 全部文案零 emoji、不写后端实现、不用黑描边（状态就是一行普通文字，见雷点 v1）；
 * 文案规则在 status-text.ts（独立文件，顺带过 react-refresh 的"只导出组件"口径）。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AboutSettings(): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const api = window.kyclaw?.updates
    if (!api) return
    let alive = true
    void api
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((caught: unknown) => {
        if (alive) setError(messageOf(caught))
      })
    const unsubscribe = api.onStateChanged((next) => setState(next))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const check = useCallback(async (): Promise<void> => {
    const api = window.kyclaw?.updates
    if (!api) {
      setError('更新通道不可用（window.kyclaw 缺失），没法检查更新')
      return
    }
    setChecking(true)
    setError(undefined)
    try {
      setState(await api.check())
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setChecking(false)
    }
  }, [])

  const install = useCallback(async (): Promise<void> => {
    const api = window.kyclaw?.updates
    if (!api) return
    try {
      await api.install()
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  const downloaded = state?.status.phase === 'downloaded'
  const disabled = state === null || !state.configured

  return (
    <div data-testid="about-settings" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="about-version" className="text-b2 text-ink">
          版本 {state?.currentVersion ?? '—'}
        </span>
        <span className="min-w-2 flex-1" />
        {downloaded ? (
          <Button size="sm" data-testid="about-install" onClick={() => void install()}>
            重启并安装
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          data-testid="about-check"
          loading={checking}
          disabled={disabled}
          onClick={() => void check()}
        >
          检查更新
        </Button>
      </div>

      <p data-testid="about-update-status" className="text-b2 text-ink-secondary">
        {updateStatusText(state)}
      </p>

      {error === undefined ? null : (
        <p data-testid="about-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
