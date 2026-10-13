import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { UpdateState } from '@shared/ipc'
import { defaultSettings } from '@shared/settings'
import { AboutSettings } from '../AboutSettings'
import { updateStatusText } from '../status-text'

/**
 * 设置页「关于」组（T17 / round 63）：当前版本 + 手动检查 + 一行状态 + 更新源（填地址、保存、校验）。
 * 这里盯的是"用户看到的那几件事"：版本、状态文案随推送走、没配源时按钮不可点（不骚扰）、
 * 下载完成后才出现「重启并安装」、更新源填错了挡在保存这一步。
 */
function renderAbout(initial?: UpdateState): ReturnType<typeof installKyclawBridge> {
  const bridge = installKyclawBridge()
  if (initial) bridge.updates.state.mockResolvedValue(initial)
  render(<AboutSettings />)
  return bridge
}

const STATUS: UpdateState = {
  currentVersion: '1.0.0',
  configured: true,
  builtinUrl: null,
  status: { phase: 'idle' }
}

/** 打包件那套：内置源地址一并给出来（输入框的占位提示就是它） */
const BUNDLED: UpdateState = {
  ...STATUS,
  builtinUrl: 'http://192.168.31.18:9000/kyclaw/releases/'
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('状态文案（纯函数）', () => {
  it('每个相位一句人话；没配源与还没读到分开说', () => {
    const of = (status: UpdateState['status'], configured = true): string =>
      updateStatusText({ currentVersion: '1.0.0', configured, builtinUrl: null, status })

    expect(updateStatusText(null)).toBe('正在读取…')
    expect(of({ phase: 'idle' })).toBe('尚未检查')
    expect(of({ phase: 'idle' }, false)).toBe('未配置更新源')
    expect(of({ phase: 'checking' })).toBe('正在检查更新…')
    expect(of({ phase: 'up-to-date' })).toBe('已是最新版本')
    expect(of({ phase: 'available', version: '1.0.1' })).toBe('发现新版本 1.0.1')
    expect(of({ phase: 'downloading', version: '1.0.1', percent: 42 })).toBe(
      '正在下载 1.0.1（42%）'
    )
    expect(of({ phase: 'downloading' })).toBe('正在下载 0%')
    expect(of({ phase: 'downloaded', version: '1.0.1' })).toBe('新版本 1.0.1 已下载')
    expect(of({ phase: 'error', message: '连不上更新源' })).toBe('检查失败：连不上更新源')
  })
})

describe('「关于」组', () => {
  it('展示当前版本与状态；没配更新源时"检查更新"不可点（不报错、不发请求）', async () => {
    const bridge = renderAbout()

    await waitFor(() => expect(screen.getByTestId('about-version')).toHaveTextContent('版本 1.0.0'))
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('未配置更新源')
    expect(screen.getByTestId('about-check')).toBeDisabled()
    expect(screen.queryByTestId('about-install')).not.toBeInTheDocument()
    expect(bridge.updates.check).not.toHaveBeenCalled()
  })

  it('配了源：点"检查更新"走 updates:check，状态与推送同步（检查中 → 已是最新）', async () => {
    const bridge = installKyclawBridge()
    bridge.updates.state.mockResolvedValue(STATUS)
    bridge.updates.check.mockImplementation(async () => {
      bridge.updates.push({ ...STATUS, status: { phase: 'checking' } })
      return { ...STATUS, status: { phase: 'up-to-date' } }
    })
    render(<AboutSettings />)

    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('尚未检查')

    fireEvent.click(screen.getByTestId('about-check'))

    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('已是最新版本')
    )
    expect(bridge.updates.check).toHaveBeenCalledTimes(1)
  })

  it('推送驱动：下载进度与"已下载"都只从推送来（弹窗/通知一概没有）', async () => {
    const bridge = renderAbout(STATUS)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    bridge.updates.push({
      ...STATUS,
      status: { phase: 'downloading', version: '1.0.1', percent: 40 }
    })
    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('正在下载 1.0.1（40%）')
    )
    expect(screen.queryByTestId('about-install')).not.toBeInTheDocument()

    bridge.updates.push({ ...STATUS, status: { phase: 'downloaded', version: '1.0.1' } })
    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('新版本 1.0.1 已下载')
    )

    fireEvent.click(screen.getByTestId('about-install'))
    await waitFor(() => expect(bridge.updates.install).toHaveBeenCalledTimes(1))
  })

  it('出错也只写一行状态（把原因带出来），不进对话框', async () => {
    const bridge = renderAbout(STATUS)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    bridge.updates.push({ ...STATUS, status: { phase: 'error', message: 'getaddrinfo ENOTFOUND' } })

    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent(
        '检查失败：getaddrinfo ENOTFOUND'
      )
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('读状态失败：状态行说读不到，版本位留占位（不编造版本号）', async () => {
    const bridge = installKyclawBridge()
    bridge.updates.state.mockRejectedValue(new Error('通道不可用'))
    render(<AboutSettings />)

    await waitFor(() => expect(screen.getByTestId('about-error')).toHaveTextContent('通道不可用'))
    expect(screen.getByTestId('about-version')).toHaveTextContent('版本 —')
  })

  it('文案零 emoji（雷点 v1 第 1 条）', async () => {
    renderAbout()
    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('未配置更新源')
    )

    const text = screen.getByTestId('about-settings').textContent ?? ''
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })
})

describe('「关于」组：更新源（round 63）', () => {
  it('打包件里带内置源：输入框留空，占位提示就是那个地址', async () => {
    renderAbout(BUNDLED)

    await waitFor(() =>
      expect(screen.getByTestId('about-update-url')).toHaveAttribute(
        'placeholder',
        'http://192.168.31.18:9000/kyclaw/releases/'
      )
    )
    expect(screen.getByTestId('about-update-url')).toHaveValue('')
  })

  it('填地址 + 保存：写进设置（settings:update），输入框随后以落盘值为准', async () => {
    const bridge = renderAbout(BUNDLED)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    fireEvent.change(screen.getByTestId('about-update-url'), {
      target: { value: '  https://mine.example.com/releases/  ' }
    })
    fireEvent.click(screen.getByTestId('about-update-url-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        updateUrl: 'https://mine.example.com/releases/'
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('about-update-url')).toHaveValue(
        'https://mine.example.com/releases/'
      )
    )
    expect(useSettingsStore.getState().settings.updateUrl).toBe(
      'https://mine.example.com/releases/'
    )
  })

  it('保存成功后主进程的广播自动生效（configured 变了，界面不用自己刷新）', async () => {
    const bridge = installKyclawBridge()
    bridge.updates.state.mockResolvedValue({ ...BUNDLED, configured: false })
    render(<AboutSettings />)
    await waitFor(() => expect(screen.getByTestId('about-check')).toBeDisabled())

    fireEvent.change(screen.getByTestId('about-update-url'), {
      target: { value: 'https://mine.example.com/releases/' }
    })
    fireEvent.click(screen.getByTestId('about-update-url-save'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalled())

    // 主进程重配后推一次新状态（更新源配上了）
    bridge.updates.push({ ...STATUS, status: { phase: 'idle' } })

    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('尚未检查')
  })

  it('填的地址不是 http(s)：挡在保存这一步（不写盘），输入框给出错误态，内容留着好改', async () => {
    const bridge = renderAbout(BUNDLED)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    for (const bad of ['ftp://host/releases', '没写全', 'http://']) {
      fireEvent.change(screen.getByTestId('about-update-url'), { target: { value: bad } })
      fireEvent.click(screen.getByTestId('about-update-url-save'))

      await waitFor(() =>
        expect(screen.getByTestId('about-update-url-error')).toHaveTextContent('地址无效')
      )
      expect(screen.getByTestId('about-update-url')).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByTestId('about-update-url')).toHaveValue(bad)
      expect(bridge.update).not.toHaveBeenCalled()
    }
  })

  it('改一下就把错误态清掉', async () => {
    renderAbout(BUNDLED)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    fireEvent.change(screen.getByTestId('about-update-url'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('about-update-url-save'))
    await waitFor(() =>
      expect(screen.getByTestId('about-update-url-error')).toHaveTextContent('地址无效')
    )

    fireEvent.change(screen.getByTestId('about-update-url'), { target: { value: 'https://ok/' } })

    await waitFor(() =>
      expect(screen.queryByTestId('about-update-url-error')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('about-update-url')).not.toHaveAttribute('aria-invalid')
  })

  it('清空保存 = 跟随内置源（空串也照样落盘）', async () => {
    const bridge = installKyclawBridge()
    useSettingsStore.setState({
      settings: { ...defaultSettings(), updateUrl: 'https://mine.example.com/releases/' },
      loaded: true
    })
    bridge.updates.state.mockResolvedValue(BUNDLED)
    render(<AboutSettings />)

    await waitFor(() =>
      expect(screen.getByTestId('about-update-url')).toHaveValue(
        'https://mine.example.com/releases/'
      )
    )

    fireEvent.change(screen.getByTestId('about-update-url'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('about-update-url-save'))

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ updateUrl: '' }))
    await waitFor(() => expect(screen.getByTestId('about-update-url')).toHaveValue(''))
    expect(useSettingsStore.getState().settings.updateUrl).toBe('')
  })
})
