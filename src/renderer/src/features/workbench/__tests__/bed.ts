import { defaultSettings } from '@shared/settings'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { resetWorkbenchStore } from '../workbench-store'

/**
 * 工作台四工具共用的测试床：装桥（window.kyclaw）+ 打开工作台 + 指一个有唯一工作区的会话。
 * 各 spec 自己 beforeEach(setupWorkbench) / afterEach(teardownWorkbench)。
 */
export interface Bed {
  bridge: KyclawBridgeStubs
  /** 会话根的绝对路径（工作区列表里的第一条） */
  root: string
}

export function setupWorkbench(options: { workspaces?: number } = {}): Bed {
  resetWorkbenchStore()
  useShellStore.setState({
    sidebarCollapsed: false,
    workPanelOpen: true,
    workPanelWidth: 400,
    workPanelFullscreen: false,
    workPanelFit: null
  })
  const workspaces = Array.from({ length: options.workspaces ?? 1 }, (_value, index) => ({
    path: `D:\\工作区${index === 0 ? '' : index}`,
    mode: 'ask' as const
  }))
  const settings = { ...defaultSettings(), workspaces }
  const bridge = installKyclawBridge(settings)
  useSettingsStore.setState({ settings, loaded: true })
  useSessionsStore.setState({ activeId: 'thread-1', loaded: true })
  return { bridge, root: workspaces[0]?.path ?? '' }
}

export function teardownWorkbench(): void {
  clearKyclawBridge()
  resetWorkbenchStore()
}
