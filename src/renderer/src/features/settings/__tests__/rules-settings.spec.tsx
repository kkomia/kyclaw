import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import { RulesSettings } from '../RulesSettings'

/**
 * 设置页「约束」栏（008/009 用户口径）：一个输入框 + 一句说明；页面上不再有面向开发者的
 * 内部文案（globalRules 键名、处理器注册状态、刷新按钮、读取范围），菜单名与页面标题都叫「约束」。
 * 行为层没变：全局走 settings:update、项目走 projects 通道。
 *
 * 状态行的新口径：只有"本次运行还没接上约束"才在页面上说话（正常运行这行不出现），
 * 窗口 focus 时重读一次 —— 撤掉「刷新规则状态」按钮不丢能力。
 */
beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

describe('「约束」栏', () => {
  it('全局显式保存/清空，超限禁用保存；保存后有结果反馈', async () => {
    const bridge = installKyclawBridge()
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '你好' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '你好' }))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')
    fireEvent.click(screen.getByText('清空并保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '' }))
    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '中'.repeat(5462) } })
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
  })

  it('落盘失败：行内给原因（不假装已保存），草稿留着', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    render(<RulesSettings />)

    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '没写进去的' } })
    fireEvent.click(screen.getByText('保存'))

    expect(await screen.findByTestId('rules-error')).toHaveTextContent('磁盘满了')
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
    expect(screen.getByLabelText('全局约束')).toHaveValue('没写进去的')
  })

  it('012：保存成功后「已保存」在输入又改动时立刻消失（不显示假成功）', async () => {
    const bridge = installKyclawBridge()
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '第一版' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '第一版' }))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')

    // 又改了一个字：这份新内容还没落盘，「已保存」不该还挂着
    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '第一版改了' } })
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
    expect(screen.getByLabelText('全局约束')).toHaveValue('第一版改了')
  })

  it('012：保存进行中输入框与按钮都锁着（写下去的就是点保存那一刻看到的内容）', async () => {
    const bridge = installKyclawBridge()
    // 落盘挂着不回来：这一挂就是"保存中"的那段窗口
    bridge.update.mockImplementationOnce(() => new Promise<AppSettings>(() => {}))
    render(<RulesSettings />)

    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '落盘中' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '落盘中' }))
    expect(screen.getByLabelText('全局约束')).toBeDisabled()
    expect(screen.getByText('保存')).toBeDisabled()
    expect(screen.getByText('清空并保存')).toBeDisabled()
  })

  it('008：页面上不再有面向开发者的内部文案，菜单名与标题都叫「约束」', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByTestId('rules-not-active')

    const text = screen.getByTestId('settings-group-rules').textContent ?? ''
    expect(text).not.toContain('globalRules')
    expect(text).not.toContain('处理器')
    expect(text).not.toContain('刷新规则状态')
    expect(text).not.toContain('本轮明确要求')
    expect(text).not.toContain('不读取默认工作区或父目录')
    expect(text).not.toContain('应用硬约束最高')
    expect(screen.queryByText('我的规矩')).not.toBeInTheDocument()
    // 用户需要知道的约束留着（一句人话）：24 KiB 这类上限
    expect(text).toContain('最多 24 KiB')
  })

  it('没接上约束时给一行提示；接上了不显示；focus 重读失败给错误行', async () => {
    const bridge = installKyclawBridge()
    bridge.projects.rulesStatus.mockResolvedValueOnce({ processorRegistered: true })
    render(<RulesSettings />)

    await waitFor(() => expect(bridge.projects.rulesStatus).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('rules-not-active')).not.toBeInTheDocument()

    bridge.projects.rulesStatus.mockRejectedValueOnce(new Error('状态读取失败'))
    fireEvent(window, new Event('focus'))
    await screen.findByText('状态读取失败')

    // 再读一次：这回是"没注册" → 出现那一行提示（读取失败与运行事实分开说）
    fireEvent(window, new Event('focus'))
    expect(await screen.findByTestId('rules-not-active')).toHaveTextContent('本次运行还没接上约束')
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
    fireEvent.change(screen.getByLabelText('选择项目约束'), { target: { value: 'p' } })
    await screen.findByText('合并超限，保留全局')
    expect(screen.getByText(/项目约束不生效/)).toBeTruthy()
    // 008：来源只说项目内的相对位置；长绝对路径挂在 tooltip 上（不占版面）
    const source = screen.getByText('.kyclaw/rules.md（项目内）')
    expect(source).toHaveAttribute('title', 'D:\\P\\.kyclaw\\rules.md')
    expect(screen.getByTestId('settings-group-rules').textContent).not.toContain('D:\\P')
    expect(bridge.projects.readRules).toHaveBeenCalledWith('p')
  })

  it('全局落盘后项目编辑器重挂重读（合计上限受全局影响）', async () => {
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
    fireEvent.change(screen.getByLabelText('选择项目约束'), { target: { value: 'p' } })
    await waitFor(() => expect(screen.getByLabelText('项目约束')).toHaveValue('第一版'))
    expect(bridge.projects.readRules).toHaveBeenCalledTimes(1)

    bridge.projects.readRules.mockResolvedValue({
      projectId: 'p',
      source: 'D:\\P\\.kyclaw\\rules.md',
      text: '第二版',
      processorRegistered: false,
      projectIncluded: true,
      diagnostics: []
    })
    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '全局改过了' } })
    // 项目编辑器也挂着一对同名按钮：DOM 顺序里全局那份在前
    fireEvent.click(screen.getAllByText('保存')[0])

    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('项目约束')).toHaveValue('第二版'))
  })

  it('全局未保存草稿不被外部设置改动顶掉（未保存内容保护）', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByTestId('rules-not-active')

    fireEvent.change(screen.getByLabelText('全局约束'), { target: { value: '没保存的草稿' } })
    act(() => {
      useSettingsStore.setState({
        settings: { ...defaultSettings(), globalRules: '别处写进来的' }
      })
    })

    expect(screen.getByLabelText('全局约束')).toHaveValue('没保存的草稿')
  })
})
