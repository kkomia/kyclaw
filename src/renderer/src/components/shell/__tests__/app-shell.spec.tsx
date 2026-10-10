import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useShellStore } from '@renderer/lib/shell-store'
import { AppShell } from '../AppShell'

beforeEach(() => {
  useShellStore.setState({ sidebarCollapsed: false, workPanelOpen: false })
})

describe('AppShell 三栏骨架', () => {
  it('三栏都在，宽度走壳 token：侧栏 240 / 主列 flex-1 / 工作台 400（默认收起）', () => {
    render(<AppShell />)

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toHaveClass('w-(--sidebar-width)')
    expect(screen.getByTestId('main-column')).toHaveClass('flex-1')

    const panel = screen.getByTestId('work-panel')
    expect(panel).not.toHaveClass('is-open')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
  })

  it('折叠侧栏：拿 is-collapsed 并用 translate(-100%) 滑出，主列类名一字不变（主列不位移）', () => {
    render(<AppShell />)
    const mainClasses = screen.getByTestId('main-column').className

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveClass('is-collapsed', '-translate-x-full')
    // 滑出屏幕后不该还能 Tab 进去/被读屏念到
    expect(sidebar).toHaveAttribute('inert')
    expect(screen.getByTestId('main-column').className).toBe(mainClasses)

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('sidebar')).not.toHaveClass('-translate-x-full')
    expect(screen.getByTestId('sidebar')).not.toHaveAttribute('inert')
    expect(screen.getByTestId('main-column').className).toBe(mainClasses)
  })

  it('工作台面板：开关切换 is-open 与 400 宽（收起时不占宽）', () => {
    render(<AppShell />)
    const panel = screen.getByTestId('work-panel')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(panel).toHaveClass('is-open', 'w-(--work-panel-width)')
    expect(panel).not.toHaveClass('w-0')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(panel).not.toHaveClass('is-open')
    expect(panel).toHaveClass('w-0')
  })

  it('两个开关互不牵连（侧栏折叠不影响面板，反之亦然）', () => {
    render(<AppShell />)

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(screen.getByTestId('sidebar')).toHaveClass('is-collapsed')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open')
  })
})
