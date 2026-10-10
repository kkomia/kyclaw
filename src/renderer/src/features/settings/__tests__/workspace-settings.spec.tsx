import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  PICKED_WORKSPACE
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings, type Workspace } from '@shared/settings'
import { WorkspaceSettings } from '../WorkspaceSettings'

/**
 * 设置页「工作区」组（T10，RTL）：列授权目录、加（原生选择器）、移除、切访问模式（ask | full）。
 * 全部动作都经 workspace:* 通道，以主进程回吐的设置为准；失败行内报错、不假装成功。
 */
const PROJECT = 'D:\\项目\\demo'
const OTHER = 'E:\\另一个'

function withWorkspaces(...workspaces: Workspace[]): AppSettings {
  return { ...defaultSettings(), workspaces }
}

async function mount(initial: AppSettings): Promise<ReturnType<typeof installKyclawBridge>> {
  const bridge = installKyclawBridge(initial)
  await useSettingsStore.getState().load()
  render(<WorkspaceSettings />)
  return bridge
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('工作区组 · 列表', () => {
  it('一条都没有：空态 + 添加入口', async () => {
    await mount(defaultSettings())

    expect(screen.getByTestId('workspace-empty')).toHaveTextContent('还没有授权的工作区')
    expect(screen.getByTestId('workspace-add')).toHaveTextContent('添加文件夹')
  })

  it('列出路径与模式（每次询问 / 完全访问 两档，选中态跟着落盘值走）', async () => {
    await mount(withWorkspaces({ path: PROJECT, mode: 'full' }, { path: OTHER, mode: 'ask' }))

    expect(screen.getByTestId('workspace-0')).toHaveTextContent(PROJECT)
    expect(screen.getByTestId('workspace-1')).toHaveTextContent(OTHER)
    expect(screen.getByTestId('workspace-0-mode-full')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('workspace-1-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-1-mode-full')).toHaveAttribute('aria-pressed', 'false')
  })
  it('路径截断显示，完整值挂在 Tooltip 上（应用内提示，不用原生 title）', async () => {
    await mount(withWorkspaces({ path: PROJECT, mode: 'ask' }))

    const trigger = screen.getByTestId('workspace-0-path')
    expect(trigger).toHaveTextContent(PROJECT)
    expect(trigger).not.toHaveAttribute('title')

    // 截断的是显示，完整值可聚焦唤出（键盘可达；Radix 的 Tooltip 在 focus 时打开）
    fireEvent.focus(trigger)

    await waitFor(() => {
      const describedBy = trigger.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy ?? '')).toHaveTextContent(PROJECT)
    })
  })
})

describe('工作区组 · 添加（原生选择器）', () => {
  it('点「添加文件夹」→ workspace:pick，选中后列表里出现那一条', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('workspace-add'))

    await waitFor(() => expect(bridge.workspace.pick).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('workspace-0')).toHaveTextContent(PICKED_WORKSPACE)
    expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('workspace-empty')).not.toBeInTheDocument()
  })

  it('添加失败（选到不支持/不可用的路径）：行内报原因，不假装加上了', async () => {
    const bridge = await mount(defaultSettings())
    bridge.workspace.pick.mockRejectedValueOnce(new Error('不支持 UNC / 网络路径'))

    fireEvent.click(screen.getByTestId('workspace-add'))

    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('不支持 UNC / 网络路径')
    expect(screen.getByTestId('workspace-empty')).toBeInTheDocument()
  })
})

describe('工作区组 · 模式切换（T13：full 走显式确认）', () => {
  it('点「完全访问」→ 弹确认框；确认后 setMode(path, full)，选中态跟落盘值走', async () => {
    const bridge = await mount(withWorkspaces({ path: PROJECT, mode: 'ask' }))

    fireEvent.click(screen.getByTestId('workspace-0-mode-full'))

    // 确认前不落盘
    expect(bridge.workspace.setMode).not.toHaveBeenCalled()
    expect(await screen.findByTestId('workspace-full-confirm')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workspace-full-confirm'))

    await waitFor(() => expect(bridge.workspace.setMode).toHaveBeenCalledWith(PROJECT, 'full'))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-0-mode-full')).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'false')
  })

  it('确认框里取消 → 什么都不改（还是「每次询问」）', async () => {
    const bridge = await mount(withWorkspaces({ path: PROJECT, mode: 'ask' }))

    fireEvent.click(screen.getByTestId('workspace-0-mode-full'))
    fireEvent.click(await screen.findByTestId('workspace-full-cancel'))

    await waitFor(() =>
      expect(screen.queryByTestId('workspace-full-confirm')).not.toBeInTheDocument()
    )
    expect(bridge.workspace.setMode).not.toHaveBeenCalled()
    expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'true')
  })

  it('点「每次询问」（收紧方向）→ 直接切，不弹确认', async () => {
    const bridge = await mount(withWorkspaces({ path: PROJECT, mode: 'full' }))

    fireEvent.click(screen.getByTestId('workspace-0-mode-ask'))

    await waitFor(() => expect(bridge.workspace.setMode).toHaveBeenCalledWith(PROJECT, 'ask'))
    await waitFor(() =>
      expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    )
    expect(screen.queryByTestId('workspace-full-confirm')).not.toBeInTheDocument()
  })

  it('切模式失败：选中态不变（不乐观改），行内报错', async () => {
    const bridge = await mount(withWorkspaces({ path: PROJECT, mode: 'ask' }))
    bridge.workspace.setMode.mockRejectedValueOnce(new Error('这个文件夹不在授权列表里'))

    fireEvent.click(screen.getByTestId('workspace-0-mode-full'))
    fireEvent.click(await screen.findByTestId('workspace-full-confirm'))

    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('不在授权列表里')
    expect(screen.getByTestId('workspace-0-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-0-mode-full')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('工作区组 · 移除', () => {
  it('点「移除」→ workspace:remove(path)，那一行消失、其余不动', async () => {
    const bridge = await mount(
      withWorkspaces({ path: PROJECT, mode: 'ask' }, { path: OTHER, mode: 'full' })
    )

    fireEvent.click(screen.getByTestId('workspace-0-remove'))

    await waitFor(() => expect(bridge.workspace.remove).toHaveBeenCalledWith(PROJECT))
    await waitFor(() => expect(screen.queryByText(PROJECT)).not.toBeInTheDocument())
    expect(screen.getByTestId('workspace-0')).toHaveTextContent(OTHER)
  })

  it('移除失败：那一行还在，行内报错', async () => {
    const bridge = await mount(withWorkspaces({ path: PROJECT, mode: 'ask' }))
    bridge.workspace.remove.mockRejectedValueOnce(new Error('磁盘满了'))

    fireEvent.click(screen.getByTestId('workspace-0-remove'))

    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('磁盘满了')
    expect(screen.getByTestId('workspace-0')).toHaveTextContent(PROJECT)
  })
})

describe('工作区组 · 通道缺失', () => {
  it('没有 preload 桥时点「添加文件夹」：报"工作区通道不可用"，不静默', async () => {
    clearKyclawBridge()
    render(<WorkspaceSettings />)

    fireEvent.click(screen.getByTestId('workspace-add'))

    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('工作区通道不可用')
  })
})
