/**
 * 退出确认对话框（M3-S5-2）：壳收到主进程 `office:quit-request` 后的三态。
 *
 * 三态（与 `s5-main-report.md` §7 的契约一致）：
 *   - **保存全部**：串行保存所有脏标签（`saveAllBeforeQuit`），全成功回 `saved`；
 *     任一失败 → 停在失败项、对话框不关（`role="alert"` + 可重试/放弃/取消），回 `cancelled`；
 *   - **放弃修改**：直接回 `discarded`（退出框不叠第二层确认，recon 允许简化）；
 *   - **取消** / Esc / 点蒙层：回 `cancelled`（主进程保持窗口打开）。
 *
 * 互斥（S4 报告 §10 的建议）：本对话框开着（= `useOfficeQuitStore.request` 非空）时，
 *   ① 键盘：capture 阶段吞掉 Ctrl+W / Ctrl+S / Ctrl+Tab —— AppTabBar 的 window 监听收不到，
 *      标签级脏三态不会被键盘拉起（Esc 放行给 Radix 自己处理）；
 *   ② AppTabBar 的点击/中键关闭：它读 `isOfficeQuitInFlight()` 避让（见该文件注释）；
 *   ③ 反向：退出请求到达时若「打开文件」弹窗开着，桥先收掉它（见 use-office-dirty-reporter）。
 *
 * testid 契约（S5-4 / S6 打包态探针依赖，别改名）：`office-quit-dialog` / `office-quit-save-all` /
 * `office-quit-discard` / `office-quit-cancel` / `office-quit-progress` / `office-quit-error`。
 */
import { useEffect, useState } from 'react'
import type { OfficeQuitRequestPayload, OfficeQuitResult } from '@shared/office-editor'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { saveOfficeTab } from './office-actions'
import {
  cancelQuitOutcome,
  discardQuitOutcome,
  officeQuitActionOf,
  quitSaveTargets,
  saveAllBeforeQuit,
  setPendingOfficeQuitRequest,
  type QuitFlowFailure,
  type QuitFlowProgress,
  type QuitOutcome
} from './office-quit-flow'
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'

/** 对话框自身的相位：确认 → 保存中 → 失败停住（可重试）；成功后由回包 + 清请求关闭 */
type QuitDialogPhase = 'confirm' | 'saving' | 'error'

export interface OfficeQuitDialogProps {
  /** 主进程推来的请求（AppShell 从 `useOfficeDirtyReporter()` 拿） */
  request: OfficeQuitRequestPayload
  /** 测试注入：保存一个标签（默认 `office-actions.saveOfficeTab`，与保存按钮 / Ctrl+S 同一条路） */
  saveTab?: (tab: OfficeTab) => Promise<boolean>
  /** 测试注入：回包（默认 `window.kyclaw.office.respondQuitRequest`） */
  respond?: (result: OfficeQuitResult) => Promise<void>
}

export function OfficeQuitDialog({
  request,
  saveTab,
  respond
}: OfficeQuitDialogProps): React.JSX.Element {
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const dirtyTabs = quitSaveTargets(tabs)
  const [phase, setPhase] = useState<QuitDialogPhase>('confirm')
  const [progress, setProgress] = useState<QuitFlowProgress | null>(null)
  const [failure, setFailure] = useState<QuitFlowFailure | null>(null)

  // 互斥 ①：本框开着时吞掉 AppTabBar 的快捷键（capture 阶段；其它键放行，Esc 归 Radix）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key !== 'w' && key !== 's' && key !== 'tab') return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  /**
   * 回包 + 关闭的唯一出口。
   * 顺序：先回主进程，再清「待决请求」（清掉后 AppShell 卸载本框）。
   * 回包失败：主进程 5s 超时会按取消处理（窗口保持打开），这里如实不重试、也不吞。
   */
  const respondWith = async (outcome: QuitOutcome): Promise<void> => {
    const send =
      respond ??
      (async (result: OfficeQuitResult): Promise<void> => {
        const office = window.kyclaw?.office
        if (office === undefined) return
        await office.respondQuitRequest(result)
      })
    try {
      await send({ requestId: request.requestId, action: officeQuitActionOf(outcome) })
    } catch {
      // 回包失败按主进程超时兜底（宁可让用户再点一次退出，也不在这里假装成功）
    } finally {
      setPendingOfficeQuitRequest(null)
    }
  }

  const startSaveAll = (): void => {
    if (phase === 'saving') return
    setFailure(null)
    setPhase('saving')
    setProgress({ done: 0, total: quitSaveTargets(useOfficeTabsStore.getState().tabs).length })
    void (async () => {
      const outcome = await saveAllBeforeQuit({
        tabs: useOfficeTabsStore.getState().tabs,
        saveTab: saveTab ?? saveOfficeTab,
        onProgress: setProgress
      })
      if (outcome.result === 'saved') {
        await respondWith(outcome)
        return
      }
      if (outcome.result === 'cancelled') {
        setFailure(outcome.failure ?? null)
        setPhase('error')
      }
    })()
  }

  const cancel = (): void => {
    // 保存中不允许取消：保存已在进行，半途取消会让"保存全部"的结果无法回收（按钮也已禁用）
    if (phase === 'saving') return
    void respondWith(cancelQuitOutcome())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
      title={request.reason === 'quit' ? '退出前保存更改？' : '关闭窗口前保存更改？'}
      description={
        dirtyTabs.length === 0
          ? '当前没有未保存的修改。'
          : `有 ${dirtyTabs.length} 个文档还有未保存的修改，直接退出会丢失这些修改。`
      }
      footer={
        <>
          <Button
            data-testid="office-quit-save-all"
            variant="primary"
            loading={phase === 'saving'}
            onClick={startSaveAll}
          >
            保存全部
          </Button>
          <Button
            data-testid="office-quit-discard"
            variant="danger"
            disabled={phase === 'saving'}
            onClick={() => void respondWith(discardQuitOutcome())}
          >
            放弃修改
          </Button>
          <Button
            data-testid="office-quit-cancel"
            variant="ghost"
            disabled={phase === 'saving'}
            onClick={cancel}
          >
            取消
          </Button>
        </>
      }
    >
      <div data-testid="office-quit-dialog" className="flex flex-col gap-2">
        {dirtyTabs.length === 0 ? null : (
          <ul className="max-h-40 overflow-y-auto text-b2 text-ink-secondary">
            {dirtyTabs.map((tab) => (
              <li key={tab.id} className="truncate" title={tab.title}>
                {tab.title}
              </li>
            ))}
          </ul>
        )}
        {phase === 'saving' && progress !== null ? (
          <p data-testid="office-quit-progress" className="text-b2 text-ink-secondary">
            {`正在保存 ${String(progress.done)}/${String(progress.total)}`}
            {progress.currentTitle === undefined ? '' : `：${progress.currentTitle}`}
          </p>
        ) : null}
        {failure === null ? null : (
          <p role="alert" data-testid="office-quit-error" className="text-b2 text-ink">
            {failure.message}
          </p>
        )}
      </div>
    </Dialog>
  )
}
