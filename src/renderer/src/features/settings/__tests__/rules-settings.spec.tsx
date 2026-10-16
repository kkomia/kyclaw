import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { tick } from '@renderer/components/ui/__tests__/tick'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import { RulesSettings } from '../RulesSettings'

/**
 * 设置页「记忆」栏里的**记忆指令**块（008/009 用户口径 + 本轮合栏）：一个输入框 + 一句说明；
 * 页面上不再有面向开发者的内部文案（globalRules 键名、处理器注册状态、刷新按钮、读取范围）。
 *
 * 名字口径（别搞混）：**左列菜单只有「记忆」一项**，没有单独的「记忆指令」菜单 ——
 * 「记忆指令」是那一栏里这一块的可见名（全局/项目两个文本域 + 项目下拉的无障碍名都按它取名）；
 * 旧深链 /settings/rules 由 sections.ts 的别名落回「记忆」栏（routes.spec / settings-page.spec 钉）。
 * 行为层没变：全局走 settings:update、项目走 projects 通道。
 *
 * 状态行的新口径：只有"本次运行还没接上记忆指令"才在页面上说话（正常运行这行不出现），
 * 窗口 focus 时重读一次 —— 撤掉「刷新规则状态」按钮不丢能力。
 */
beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

/**
 * 项目下拉（002 起是产品自定义下拉，不再用原生 select）：ArrowDown 开菜单，再点条目
 * ——与对话页「选择项目」胶囊（project-chip.spec.tsx）同一套开/选动作。
 */
function openProjectMenu(): HTMLElement {
  const trigger = screen.getByTestId('rules-project-select')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  return trigger
}

function pickProject(testId: string): void {
  openProjectMenu()
  fireEvent.click(screen.getByTestId(testId))
}

describe('记忆指令（「记忆」栏里的第三块）', () => {
  it('全局显式保存/清空，超限禁用保存；保存后有结果反馈', async () => {
    const bridge = installKyclawBridge()
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '你好' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '你好' }))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')
    fireEvent.click(screen.getByText('清空并保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '' }))
    fireEvent.change(screen.getByLabelText('全局记忆指令'), {
      target: { value: '中'.repeat(5462) }
    })
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true)
  })

  it('落盘失败：行内给原因（不假装已保存），草稿留着', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    render(<RulesSettings />)

    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '没写进去的' } })
    fireEvent.click(screen.getByText('保存'))

    expect(await screen.findByTestId('rules-error')).toHaveTextContent('磁盘满了')
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
    expect(screen.getByLabelText('全局记忆指令')).toHaveValue('没写进去的')
  })

  it('012：保存成功后「已保存」在输入又改动时立刻消失（不显示假成功）', async () => {
    const bridge = installKyclawBridge()
    render(<RulesSettings />)
    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '第一版' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '第一版' }))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')

    // 又改了一个字：这份新内容还没落盘，「已保存」不该还挂着
    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '第一版改了' } })
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
    expect(screen.getByLabelText('全局记忆指令')).toHaveValue('第一版改了')
  })

  it('012：保存进行中输入框与按钮都锁着（写下去的就是点保存那一刻看到的内容）', async () => {
    const bridge = installKyclawBridge()
    // 落盘挂着不回来：这一挂就是"保存中"的那段窗口
    bridge.update.mockImplementationOnce(() => new Promise<AppSettings>(() => {}))
    render(<RulesSettings />)

    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '落盘中' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '落盘中' }))
    expect(screen.getByLabelText('全局记忆指令')).toBeDisabled()
    expect(screen.getByText('保存')).toBeDisabled()
    expect(screen.getByText('清空并保存')).toBeDisabled()
  })

  it('008：页面上不再有面向开发者的内部文案（这一块的可见名是「记忆指令」，菜单不占位）', async () => {
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
    // 用户需要知道的上限这类信息留着（一句人话）：24 KiB
    expect(text).toContain('最多 24 KiB')
  })

  it('更名：可见名字统一叫「记忆指令」（旧名「约束」在栏内不再出现）', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByTestId('rules-not-active')

    // 两个文本域的可见名、项目下拉的无障碍名都换了（旧名一个都不剩）
    expect(screen.getByLabelText('全局记忆指令')).toBeInTheDocument()
    expect(screen.getByLabelText('选择项目记忆指令')).toBeInTheDocument()
    expect(screen.queryByLabelText('全局约束')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('选择项目约束')).not.toBeInTheDocument()
    const text = screen.getByTestId('settings-group-rules').textContent ?? ''
    expect(text).not.toContain('约束')
    expect(text).toContain('记忆指令')
  })

  it('没接上记忆指令时给一行提示；接上了不显示；focus 重读失败给错误行', async () => {
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
    expect(await screen.findByTestId('rules-not-active')).toHaveTextContent(
      '本次运行还没接上记忆指令'
    )
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
    pickProject('rules-project-p')
    await screen.findByText('合并超限，保留全局')
    expect(screen.getByText(/项目记忆指令不生效/)).toBeTruthy()
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
    pickProject('rules-project-p')
    await waitFor(() => expect(screen.getByLabelText('项目记忆指令')).toHaveValue('第一版'))
    expect(bridge.projects.readRules).toHaveBeenCalledTimes(1)

    bridge.projects.readRules.mockResolvedValue({
      projectId: 'p',
      source: 'D:\\P\\.kyclaw\\rules.md',
      text: '第二版',
      processorRegistered: false,
      projectIncluded: true,
      diagnostics: []
    })
    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '全局改过了' } })
    // 项目编辑器也挂着一对同名按钮：DOM 顺序里全局那份在前
    fireEvent.click(screen.getAllByText('保存')[0])

    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('项目记忆指令')).toHaveValue('第二版'))
  })

  it('受控草稿（二级弹窗那条路）：草稿由外部持有 —— 改动回调出去，保存成功回调 null 清掉', async () => {
    const bridge = installKyclawBridge()
    /** 模拟 RulesEntry：草稿挂在外面（弹窗卸载也不丢） */
    function Host(): React.JSX.Element {
      const [draft, setDraft] = useState<string | null>(null)
      return (
        <>
          <span data-testid="host-draft">{draft === null ? '(无草稿)' : draft}</span>
          <RulesSettings draft={draft} onDraftChange={setDraft} />
        </>
      )
    }
    render(<Host />)
    await screen.findByTestId('rules-not-active')

    // 改动只回调出去（受控方持有），文本域显示的就是那份草稿
    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '外面的草稿' } })
    expect(screen.getByTestId('host-draft')).toHaveTextContent('外面的草稿')
    expect(screen.getByLabelText('全局记忆指令')).toHaveValue('外面的草稿')

    // 保存成功 = 回调 null（清草稿）→ 当前文本回到落盘值，并给真反馈
    fireEvent.click(screen.getAllByText('保存')[0])
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '外面的草稿' }))
    await waitFor(() => expect(screen.getByTestId('host-draft')).toHaveTextContent('(无草稿)'))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')
    expect(screen.getByLabelText('全局记忆指令')).toHaveValue('外面的草稿')
  })

  it('全局未保存草稿不被外部设置改动顶掉（未保存内容保护）', async () => {
    installKyclawBridge()
    render(<RulesSettings />)
    await screen.findByTestId('rules-not-active')

    fireEvent.change(screen.getByLabelText('全局记忆指令'), { target: { value: '没保存的草稿' } })
    act(() => {
      useSettingsStore.setState({
        settings: { ...defaultSettings(), globalRules: '别处写进来的' }
      })
    })

    expect(screen.getByLabelText('全局记忆指令')).toHaveValue('没保存的草稿')
  })
})

/**
 * 002：项目那一栏是**产品自定义下拉**（components/ui/menu，与对话页「选择项目」胶囊同一件东西），
 * 不再是原生 select。项目 / 全局两条读写路径、保存、草稿、空列表这些行为口径一字不动 ——
 * 这几条用例钉的是换控件之后**这些能力还在**，以及自定义下拉新带来的键盘 / Escape / 长名表现。
 */
describe('「选择项目」下拉（002 换掉原生 select）', () => {
  const LONG_NAME = '一个名字很长很长很长的项目（跨机器交接用的仓库）'
  const PROJECTS = [
    { id: 'p', name: 'P', path: 'D:\\P', createdAt: '' },
    { id: 'long', name: LONG_NAME, path: 'D:\\Long', createdAt: '' }
  ]

  function mountWithProjects(projects = PROJECTS): ReturnType<typeof installKyclawBridge> {
    const bridge = installKyclawBridge()
    useSettingsStore.setState({ settings: { ...defaultSettings(), projects } })
    render(<RulesSettings />)
    return bridge
  }

  it('页面上没有原生 select；触发元素带菜单语义，选中即读那个项目的记忆指令', async () => {
    const bridge = mountWithProjects()

    expect(screen.getByTestId('settings-group-rules').querySelector('select')).toBeNull()
    const trigger = screen.getByTestId('rules-project-select')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('请选择项目')

    openProjectMenu()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByTestId('rules-project-p'))

    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledWith('p'))
    expect(trigger).toHaveTextContent('P')
  })

  it('键盘走到条目上回车即选中；Escape 关面板并把焦点还给触发元素（不顺手清选择）', async () => {
    const bridge = mountWithProjects()
    const trigger = openProjectMenu()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    const first = screen.getByRole('menuitem', { name: 'P' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Enter' })

    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledWith('p'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    openProjectMenu()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await tick()

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
    expect(trigger).toHaveTextContent('P')
  })

  it('空列表：给一条禁用的「还没有项目」，也不会冒出项目编辑器', async () => {
    mountWithProjects([])

    expect(screen.getByLabelText('选择项目记忆指令')).toHaveTextContent('请选择项目')
    openProjectMenu()

    const empty = screen.getByTestId('rules-project-empty')
    expect(empty).toHaveAttribute('data-disabled')
    fireEvent.click(empty)

    expect(screen.queryByLabelText('项目记忆指令')).not.toBeInTheDocument()
  })

  it('长名：触发元素截断显示（全名挂 title），面板里的条目仍给全名', async () => {
    mountWithProjects([PROJECTS[1]])

    openProjectMenu()
    expect(screen.getByRole('menuitem', { name: LONG_NAME })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rules-project-long'))

    const value = screen.getByTestId('rules-project-value')
    expect(value).toHaveTextContent(LONG_NAME)
    expect(value).toHaveClass('truncate')
    expect(value).toHaveAttribute('title', LONG_NAME)
  })

  it('选过项目后能退回「请选择项目」（原 select 那个空选项的能力不丢）', async () => {
    const bridge = mountWithProjects()

    pickProject('rules-project-p')
    await waitFor(() => expect(bridge.projects.readRules).toHaveBeenCalledWith('p'))
    await waitFor(() => expect(screen.getByLabelText('项目记忆指令')).toBeInTheDocument())

    pickProject('rules-project-none')

    expect(screen.queryByLabelText('项目记忆指令')).not.toBeInTheDocument()
    expect(screen.getByTestId('rules-project-select')).toHaveTextContent('请选择项目')
  })
})
