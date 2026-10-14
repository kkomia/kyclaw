import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { RulesSettings } from '../RulesSettings'

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

describe('我的规矩编辑', () => {
  it('全局显式保存/清空，超限禁用保存；未接线提示不误称生效', async () => {
    const bridge = installKyclawBridge()
    render(<RulesSettings />)
    expect(screen.getByText(/正在确认规则处理器注册状态/)).toBeTruthy()
    await screen.findByText(/当前运行尚未注册规则处理器/)
    fireEvent.change(screen.getByLabelText('全局规矩'), { target: { value: '你好' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '你好' }))
    fireEvent.click(screen.getByText('清空并保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '' }))
    fireEvent.change(screen.getByLabelText('全局规矩'), { target: { value: '中'.repeat(5462) } })
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
  })

  it('刷新规则状态改次级小按钮（缩到内容宽），主操作仍是「保存」', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByText(/当前运行尚未注册规则处理器/)

    const refresh = screen.getByText('刷新规则状态')
    expect(refresh.className).toContain('bg-transparent')
    expect(refresh.className).toContain('self-start')
    expect(refresh.className).not.toContain('bg-(--button-primary-bg)')
    expect(screen.getByText('保存').className).toContain('bg-(--button-primary-bg)')
  })

  it('真实状态从未知转注册，窗口 focus 重读失败回未知，显式刷新恢复未注册', async () => {
    const bridge = installKyclawBridge()
    bridge.projects.rulesStatus.mockResolvedValueOnce({ processorRegistered: true })
    render(<RulesSettings />)
    expect(screen.getByText(/正在确认规则处理器注册状态/)).toBeTruthy()
    await screen.findByText(/规则处理器已注册；保存后下一轮/)
    bridge.projects.rulesStatus.mockRejectedValueOnce(new Error('状态读取失败'))
    fireEvent(window, new Event('focus'))
    await screen.findByText('状态读取失败')
    expect(screen.getByText(/正在确认规则处理器注册状态/)).toBeTruthy()
    fireEvent.click(screen.getByText('刷新规则状态'))
    await screen.findByText(/当前运行尚未注册规则处理器/)
    expect(bridge.projects.rulesStatus).toHaveBeenCalledTimes(3)
  })

  it('项目合并超限诊断可见，项目来源明确', async () => {
    const bridge = installKyclawBridge()
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        projects: [{ id: 'p', name: 'P', path: 'D:\\P', createdAt: '' }]
      }
    })
    bridge.projects.readRules.mockResolvedValue({
      projectId: 'p',
      source: 'D:\\P\\.kyclaw\\rules.md',
      text: '项目偏好',
      processorRegistered: false,
      projectIncluded: false,
      diagnostics: [{ scope: 'project', code: 'combined-too-large', message: '合并超限，保留全局' }]
    })
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('选择项目规矩'), { target: { value: 'p' } })
    await screen.findByText('合并超限，保留全局')
    expect(screen.getByText(/项目规矩不生效/)).toBeTruthy()
    expect(screen.getByText(/来源：D:/)).toBeTruthy()
    expect(bridge.projects.readRules).toHaveBeenCalledWith('p')
  })

  it('全局规矩落盘后项目编辑器重挂重读（合计上限受全局影响）', async () => {
    const withProject = {
      ...defaultSettings(),
      projects: [{ id: 'p', name: 'P', path: 'D:\\P', createdAt: '' }]
    }
    const bridge = installKyclawBridge(withProject)
    useSettingsStore.setState({ settings: withProject })
    bridge.projects.readRules.mockResolvedValue({
      projectId: 'p',
      source: 'D:\\P\\.kyclaw\\rules.md',
      text: '第一版',
      processorRegistered: false,
      projectIncluded: true,
      diagnostics: []
    })
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('选择项目规矩'), { target: { value: 'p' } })
    await waitFor(() => expect(screen.getByLabelText('项目规矩')).toHaveValue('第一版'))
    expect(bridge.projects.readRules).toHaveBeenCalledTimes(1)

    bridge.projects.readRules.mockResolvedValue({
      projectId: 'p',
      source: 'D:\\P\\.kyclaw\\rules.md',
      text: '第二版',
      processorRegistered: false,
      projectIncluded: true,
      diagnostics: []
    })
    fireEvent.change(screen.getByLabelText('全局规矩'), { target: { value: '全局改过了' } })
    // 项目编辑器也挂着一对同名按钮：DOM 顺序里全局那份在前
    fireEvent.click(screen.getAllByText('保存')[0])

    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('项目规矩')).toHaveValue('第二版'))
  })

  it('全局未保存草稿不被外部设置改动顶掉（未保存内容保护）', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByText(/当前运行尚未注册规则处理器/)

    fireEvent.change(screen.getByLabelText('全局规矩'), { target: { value: '没保存的草稿' } })
    act(() => {
      useSettingsStore.setState({
        settings: { ...defaultSettings(), globalRules: '别处写进来的' }
      })
    })

    expect(screen.getByLabelText('全局规矩')).toHaveValue('没保存的草稿')
  })
})
