import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useWorkbenchStore } from '../workbench-store'
import { Workbench } from '../Workbench'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 工作台：四工具 tab 栏 + 懒挂载 + 保活 + 根判不出时的空态。
 * 面板用 `data-active` / `inert` 表达可见与可交互（隐藏靠 invisible + opacity 过渡，不卸载）。
 */
let bed: Bed

beforeEach(() => {
  bed = setupWorkbench()
})

afterEach(() => {
  teardownWorkbench()
})

describe('Workbench', () => {
  it('四个 tab 都在，默认选中「文件」并只挂了它', () => {
    render(<Workbench />)

    for (const label of ['浏览器', '文件', 'Git', '终端']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('workbench-panel-files')).toHaveAttribute('data-active', 'true')
    // 没点过的工具不挂载（各工具的 IPC 订阅因此只在用时建立）
    expect(screen.queryByTestId('workbench-panel-git')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workbench-panel-browser')).not.toBeInTheDocument()
  })

  it('切 tab：新面板挂上并激活，老面板不卸载（只隐藏 + inert）', async () => {
    render(<Workbench />)

    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))

    const git = screen.getByTestId('workbench-panel-git')
    expect(git).toHaveAttribute('data-active', 'true')
    expect(git).not.toHaveAttribute('inert')
    expect(git).toHaveClass('opacity-100')

    const files = screen.getByTestId('workbench-panel-files')
    expect(files).toHaveAttribute('data-active', 'false')
    expect(files).toHaveAttribute('inert')
    expect(files).toHaveClass('invisible', 'opacity-0')

    // 记住了选择（内存态）
    expect(useWorkbenchStore.getState().activeTab).toBe('git')
  })

  it('文件 tab 会用会话根列目录（有唯一工作区时）', async () => {
    render(<Workbench />)

    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', ''))
  })

  it('判不出唯一工作区：文件/Git/终端给同一句人话，且不去碰 IPC', async () => {
    bed = setupWorkbench({ workspaces: 2 })
    render(<Workbench />)

    expect(screen.getByTestId('files-notice')).toHaveTextContent('判不出这个会话的工作区')
    expect(bed.bridge.workbench.listDir).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    expect(screen.getByTestId('git-notice')).toHaveTextContent('判不出这个会话的工作区')

    fireEvent.click(screen.getByRole('tab', { name: '终端' }))
    expect(screen.getByTestId('terminal-notice')).toHaveTextContent('判不出这个会话的工作区')
    expect(bed.bridge.terminal.start).not.toHaveBeenCalled()
  })
})
