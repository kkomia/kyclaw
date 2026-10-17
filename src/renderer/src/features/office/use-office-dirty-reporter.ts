/**
 * 退出拦截的**壳侧桥**（M3-S5-2）：脏计数上报 + 主进程退出请求订阅。
 *
 * 挂在 AppShell（所有路由常驻，设置页/聊天页也会触发退出）：
 *   1. 订阅 `useOfficeTabsStore`，脏标签数变化时 `window.kyclaw.office.reportDirtyState(count)`
 *      —— **只传计数**、不 debounce（0→1 的窗口越短越好；计数变化本身低频）；
 *   2. 订阅 `window.kyclaw.office.onQuitRequest(cb)`（返回退订），把请求写进**唯一来源**
 *      `useOfficeQuitStore`；AppShell 据此条件渲染 `OfficeQuitDialog`，AppTabBar 据此避让标签级
 *      脏三态（两个对话框互斥）。
 *
 * 边界：桥不存在（独立渲染壳的单测 / 极端启动时序）时全部 no-op，不抛；卸载**不推 0**
 * （窗口都要关了，再推一次计数没有意义）。
 */
import { useEffect } from 'react'
import type { OfficeQuitRequestPayload } from '@shared/office-editor'
import { setPendingOfficeQuitRequest, useOfficeQuitStore } from './office-quit-flow'
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'
import { useOfficeUiStore } from './office-ui-store'

/**
 * 未保存文档数（主进程只拿它做"退出要不要问"的快速判空）。
 * 只读标签不可能有未保存修改（编辑器只读直通），防御性排除。
 */
export function countDirtyOfficeTabs(tabs: readonly OfficeTab[]): number {
  return tabs.filter((tab) => tab.dirty && !tab.readOnly).length
}

/**
 * 在壳顶层调用一次：返回当前待决的退出请求（null = 没有退出确认在飞）。
 * AppShell 把返回值透传给 `OfficeQuitDialog`；其它地方要做互斥判断用 `isOfficeQuitInFlight()`。
 */
export function useOfficeDirtyReporter(): OfficeQuitRequestPayload | null {
  const request = useOfficeQuitStore((state) => state.request)

  // 1) 脏计数：变化即推（含首次挂载取当前值）；卸载只退订、不推 0
  useEffect(() => {
    const office = window.kyclaw?.office
    if (office === undefined) return
    const report = (tabs: readonly OfficeTab[]): void => {
      try {
        void Promise.resolve(office.reportDirtyState(countDirtyOfficeTabs(tabs))).catch(() => {
          // 上报失败不影响本地编辑：下一次计数变化 / 退出时主进程还会再问
        })
      } catch {
        // 桥调用同步抛（坏桥）也不能把壳带崩
      }
    }
    report(useOfficeTabsStore.getState().tabs)
    return useOfficeTabsStore.subscribe((state, previous) => {
      if (state.tabs === previous.tabs) return
      report(state.tabs)
    })
  }, [])

  // 2) 主进程的退出确认请求：写进唯一来源；顺手收掉「打开文件」弹窗（同层弹窗互斥）
  useEffect(() => {
    const office = window.kyclaw?.office
    if (office === undefined) return
    return office.onQuitRequest((payload) => {
      const ui = useOfficeUiStore.getState()
      if (ui.pickerOpen) ui.closePicker()
      setPendingOfficeQuitRequest(payload)
    })
  }, [])

  return request
}
