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
    // 012：保存要有结果反馈
    expect(screen.getByTestId('about-update-url-notice')).toHaveTextContent('已保存')
  })

  it('012：落盘失败也要有反馈（原因带出来，不静默）', async () => {
    const bridge = renderAbout(BUNDLED)
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    fireEvent.change(screen.getByTestId('about-update-url'), {
      target: { value: 'https://mine.example.com/releases/' }
    })
    fireEvent.click(screen.getByTestId('about-update-url-save'))

    expect(await screen.findByTestId('about-error')).toHaveTextContent('磁盘满了')
    expect(screen.queryByTestId('about-update-url-notice')).not.toBeInTheDocument()
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

/** 这一版的更新说明（下面几个用例共用同一段文本） */
const NOTES = '这一版：\n- 更新内容会显示出来'

describe('「关于」组：更新内容（发行日志，0.1.1）', () => {
  it('有新版本就显示更新内容：发行名 + 发行日期 + 日志原文', async () => {
    renderAbout({
      ...STATUS,
      status: {
        phase: 'available',
        version: '0.1.1',
        notes: NOTES,
        releaseName: 'kyclaw 0.1.1',
        releaseDate: '2026-10-15T02:30:00.000Z'
      }
    })

    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('发现新版本 0.1.1')
    )
    expect(screen.getByTestId('about-release-name')).toHaveTextContent('kyclaw 0.1.1')
    expect(screen.getByTestId('about-release-notes')).toHaveTextContent('更新内容会显示出来')
    // 发行日期按本地时间显示成"年月日 时分"（源上给的是 ISO 串）
    expect(screen.getByTestId('about-release-date')).toHaveTextContent(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    )
    // 日志就是一行普通文字，不是对话框、也不是新窗口
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('源上没给发行名：标题退回「更新内容」；日期解析不出来就原样显示', async () => {
    renderAbout({
      ...STATUS,
      status: { phase: 'available', version: '0.1.1', notes: NOTES, releaseDate: '待定' }
    })

    await waitFor(() =>
      expect(screen.getByTestId('about-release-name')).toHaveTextContent('更新内容')
    )
    expect(screen.getByTestId('about-release-date')).toHaveTextContent('待定')
  })

  it('日志按纯文本渲染：HTML / 图片 / 脚本一律当字面量（不插 DOM、不拉远程图片）', async () => {
    const hostile =
      '<img src="http://127.0.0.1:9/pixel.png"> <script>window.__pwned = 1</script> [点我](http://x)'
    renderAbout({ ...STATUS, status: { phase: 'available', version: '0.1.1', notes: hostile } })

    const region = await screen.findByTestId('about-release-notes')
    expect(region).toHaveTextContent(hostile)
    expect(region.querySelector('img')).toBeNull()
    expect(region.querySelector('script')).toBeNull()
  })

  it('缺说明 = 那一块整块不出现，检查/安装照旧（日志不拦更新）', async () => {
    const bridge = renderAbout({ ...STATUS, status: { phase: 'available', version: '0.1.1' } })
    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('发现新版本 0.1.1')
    )
    expect(screen.queryByTestId('about-release')).not.toBeInTheDocument()
    expect(screen.getByTestId('about-check')).not.toBeDisabled()

    // 换一次检查（换源/换版本同理）：旧日志跟着状态一起消失，不留在界面上
    bridge.updates.push({
      ...STATUS,
      status: { phase: 'available', version: '0.1.1', notes: NOTES }
    })
    await waitFor(() => expect(screen.getByTestId('about-release-notes')).toBeInTheDocument())

    bridge.updates.push({ ...STATUS, status: { phase: 'up-to-date' } })
    await waitFor(() => expect(screen.queryByTestId('about-release')).not.toBeInTheDocument())
  })

  it('下载中与已下载都留着这一版的日志（状态行换文案，更新内容不消失）', async () => {
    const bridge = renderAbout(STATUS)
    await waitFor(() => expect(screen.getByTestId('about-check')).not.toBeDisabled())

    bridge.updates.push({
      ...STATUS,
      status: { phase: 'downloading', version: '0.1.1', percent: 42, notes: NOTES }
    })
    await waitFor(() =>
      expect(screen.getByTestId('about-update-status')).toHaveTextContent('正在下载 0.1.1（42%）')
    )
    expect(screen.getByTestId('about-release-notes')).toHaveTextContent('更新内容会显示出来')

    bridge.updates.push({
      ...STATUS,
      status: { phase: 'downloaded', version: '0.1.1', notes: NOTES }
    })
    await waitFor(() => expect(screen.getByTestId('about-install')).toBeInTheDocument())
    expect(screen.getByTestId('about-release-notes')).toHaveTextContent('更新内容会显示出来')

    fireEvent.click(screen.getByTestId('about-install'))
    await waitFor(() => expect(bridge.updates.install).toHaveBeenCalledTimes(1))
  })

  it('长日志先收起，点「展开」后自己滚（再点收起）', async () => {
    const longNotes = Array.from(
      { length: 12 },
      (_, index) => `第 ${index + 1} 行：这一版做了什么`
    ).join('\n')
    renderAbout({ ...STATUS, status: { phase: 'available', version: '0.1.1', notes: longNotes } })

    const region = await screen.findByTestId('about-release-notes')
    expect(region).toHaveTextContent('第 12 行：这一版做了什么')
    expect(region.className).toContain('max-h-24')
    expect(screen.getByTestId('about-release-toggle')).toHaveTextContent('展开')

    fireEvent.click(screen.getByTestId('about-release-toggle'))
    await waitFor(() =>
      expect(screen.getByTestId('about-release-toggle')).toHaveTextContent('收起')
    )
    expect(screen.getByTestId('about-release-notes').className).toContain('overflow-auto')

    fireEvent.click(screen.getByTestId('about-release-toggle'))
    await waitFor(() =>
      expect(screen.getByTestId('about-release-toggle')).toHaveTextContent('展开')
    )
  })

  it('短日志不给「展开」（阈值以下直接全显）', async () => {
    renderAbout({ ...STATUS, status: { phase: 'available', version: '0.1.1', notes: NOTES } })

    await screen.findByTestId('about-release-notes')
    expect(screen.queryByTestId('about-release-toggle')).not.toBeInTheDocument()
  })

  it('同一版但这次没带说明：那一块整块消失（不复用上一份），版本号照报', async () => {
    const bridge = renderAbout({
      ...STATUS,
      status: { phase: 'available', version: '0.1.1', notes: NOTES }
    })
    await screen.findByTestId('about-release-notes')

    bridge.updates.push({ ...STATUS, status: { phase: 'available', version: '0.1.1' } })

    await waitFor(() => expect(screen.queryByTestId('about-release')).not.toBeInTheDocument())
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('发现新版本 0.1.1')
  })

  it('换更新源（主进程推 idle）：那一块跟着消失，不留在界面上', async () => {
    const bridge = renderAbout({
      ...STATUS,
      status: { phase: 'available', version: '0.1.1', notes: NOTES }
    })
    await screen.findByTestId('about-release-notes')

    bridge.updates.push({ ...STATUS, status: { phase: 'idle' } })

    await waitFor(() => expect(screen.queryByTestId('about-release')).not.toBeInTheDocument())
    expect(screen.getByTestId('about-update-status')).toHaveTextContent('尚未检查')
  })
})
