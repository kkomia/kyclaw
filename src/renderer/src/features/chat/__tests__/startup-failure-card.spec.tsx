import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StartupFailureCard } from '../StartupFailureCard'
import { ChatSession } from '../ChatPage'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'

/**
 * PB-038：启动失败态只给「重启应用」，不再是「再跑一次」。
 * 三种回包都要可读：ok（保持正在重启）/ unsaved-documents（先保存）/ relaunch-failed（手动重开）。
 * 不绕过 main 的退出守卫；无推送事件，状态本地管。
 */
const error = new Error('agent 服务未启动')

beforeEach(() => installKyclawBridge())
afterEach(() => clearKyclawBridge())

describe('PB-038 StartupFailureCard', () => {
  it('默认文案：重启应用 + 重启后会重新加载内核；没有「再跑一次」', () => {
    render(<StartupFailureCard error={error} />)
    expect(screen.getByTestId('error-retry')).toHaveTextContent('重启应用')
    expect(screen.getByTestId('error-retry')).toBeEnabled()
    expect(screen.getByTestId('error-retry-hint')).toHaveTextContent('重启后会重新加载内核')
    expect(screen.queryByText('再跑一次')).not.toBeInTheDocument()
  })

  it('ok=true：点击后立刻禁用并显示「正在重启…」，不假装还能再点', async () => {
    const relaunch = vi.fn(async () => ({ ok: true as const }))
    window.kyclaw.app.relaunch = relaunch
    render(<StartupFailureCard error={error} />)
    fireEvent.click(screen.getByTestId('error-retry'))
    await waitFor(() => expect(screen.getByTestId('error-retry')).toHaveTextContent('正在重启…'))
    expect(screen.getByTestId('error-retry')).toBeDisabled()
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('unsaved-documents：没有重启，提示先保存，按钮恢复可点', async () => {
    window.kyclaw.app.relaunch = vi.fn(async () => ({
      ok: false as const,
      reason: 'unsaved-documents' as const
    }))
    render(<StartupFailureCard error={error} />)
    fireEvent.click(screen.getByTestId('error-retry'))
    expect(await screen.findByTestId('error-retry-note')).toHaveTextContent(
      '有未保存的文档，请先保存再重启。'
    )
    expect(screen.getByTestId('error-retry')).toHaveTextContent('重启应用')
    expect(screen.getByTestId('error-retry')).toBeEnabled()
  })

  it('relaunch-failed 与 IPC 抛错：都给手动关闭重开的可读提示', async () => {
    window.kyclaw.app.relaunch = vi.fn(async () => ({
      ok: false as const,
      reason: 'relaunch-failed' as const
    }))
    const first = render(<StartupFailureCard error={error} />)
    fireEvent.click(screen.getByTestId('error-retry'))
    expect(await screen.findByTestId('error-retry-note')).toHaveTextContent(
      '重启失败，请手动关闭并重新打开应用。'
    )
    first.unmount()

    window.kyclaw.app.relaunch = vi.fn(async () => {
      throw new Error('ipc broken')
    })
    render(<StartupFailureCard error={error} />)
    fireEvent.click(screen.getByTestId('error-retry'))
    expect(await screen.findByTestId('error-retry-note')).toHaveTextContent(
      '重启失败，请手动关闭并重新打开应用。'
    )
  })

  it('ChatSession 的 endpoint 失败档走 StartupFailureCard（不是普通 ErrorCard 的重试）', () => {
    render(
      <MemoryRouter>
        <ChatSession
          transport={null}
          threadId={null}
          endpointError={error}
          onRetryEndpoint={() => {}}
        />
      </MemoryRouter>
    )
    expect(screen.getByTestId('error-retry')).toHaveTextContent('重启应用')
    expect(screen.queryByText('再跑一次')).not.toBeInTheDocument()
  })
})
