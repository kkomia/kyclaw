import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings'
import { SettingsPage } from '../SettingsPage'

/**
 * 设置页（UI 返工 R1 起是栏目页）：默认栏是「外观」（主题三选 → setTheme、字号数值 → --ui-scale，
 * task-69）；断言落在 html[data-theme] / html 的 --ui-scale 与落盘调用上；其余栏目各自的占位文案。
 * 栏目切换与左列设置菜单由 routes.spec 走真实路由钉（这里只渲一栏的内容）。
 *
 * 本轮（设置页重组）：「记忆」栏合栏 —— 三块依次是语义召回 / 记忆空间（入口弹窗）/
 * 记忆指令（RulesSettings 自己那块，可见名由它给）；旧的 /settings/rules 深链落这一栏。
 */
function renderPage(path = '/settings'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>
  )
}
const html = (): HTMLElement => document.documentElement

function installMatchMedia(matches: boolean): void {
  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true
  }
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia
}

/** 一个会话：摆进 store 就是"当前活动会话"（草稿 / 没有会话用下面的 setDraft） */
function setActiveSession(threadId: string, title: string | null = null): void {
  useSessionsStore.setState({
    threads: [{ id: threadId, title, updatedAt: new Date().toISOString() }],
    activeId: threadId,
    loaded: true,
    error: null
  })
}

/** 草稿会话（还没落库、不在会话列表里）：记忆面板按"没有会话"处理 */
function setDraftSession(threadId: string): void {
  useSessionsStore.setState({ threads: [], activeId: threadId, loaded: true, error: null })
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

interface MemoryCall {
  method: string
  path: string
  threadId: string | null
}

/**
 * 记忆接口的假服务（与 memory-page.spec 同一套手写 fetch 桩）：只记"方法 + 路径 + threadId"，
 * 够钉"弹窗看的是当前会话那一份、Esc 关窗不发 DELETE"。
 * `/api/memory/recall`（「会话记忆（语义召回）」状态行那一条腿）不进 calls —— 那不是记忆接口。
 */
function installFakeMemory(initial: Record<string, string> = {}): { calls: MemoryCall[] } {
  const contents: Record<string, string | null> = { ...initial }
  const calls: MemoryCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/memory/recall') {
        return json({
          // 形状照 shared/memory 的 recallStatusSchema（source 是 remote / localEngine 两档）
          recall: {
            state: 'off',
            active: false,
            enabled: false,
            source: 'remote',
            detail: '未开启'
          }
        })
      }
      const method = init.method ?? 'GET'
      const threadId = url.searchParams.get('threadId')
      calls.push({ method, path: url.pathname, threadId })
      if (url.pathname !== '/api/memory') throw new Error(`假服务没实现：${method} ${url.pathname}`)
      const key = threadId ?? ''
      if (method === 'GET') return json({ content: contents[key] ?? null })
      if (method === 'DELETE') {
        contents[key] = null
        return json({ ok: true })
      }
      throw new Error(`假服务没实现：${method} ${url.pathname}`)
    })
  )
  return { calls }
}

beforeEach(() => {
  html().removeAttribute('data-theme')
  html().style.removeProperty('--ui-scale')
  window.matchMedia = undefined as unknown as typeof window.matchMedia
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  resetSessionsStore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('设置页骨架（栏目页）', () => {
  it('默认栏是「外观」：只渲当前栏，其余栏不进 DOM', () => {
    renderPage()

    expect(screen.getByTestId('settings-page')).toBeInTheDocument()
    // round 23：限宽列在里层（滚动条在外层全宽容器上，贴窗口右缘）
    expect(screen.getByTestId('settings-page-column')).toHaveClass('content-column')
    expect(screen.getByTestId('settings-page')).toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-usage')).not.toBeInTheDocument()
  })

  it('「模型」栏：新增入口在这一栏里（round 48 起渠道收进弹窗；round 32 起同栏还有「思考翻译」组）', () => {
    renderPage('/settings/model')

    expect(screen.getByTestId('settings-group-model')).toHaveTextContent('新增')
    expect(screen.getByTestId('model-add')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-reasoning-translate')).toHaveTextContent(
      '启用思考翻译'
    )
  })

  it('round 48：联网搜索不再占设置页的一格——配置只在内置插件里（去重口径）', () => {
    const model = render(
      <MemoryRouter initialEntries={['/settings/model']}>
        <SettingsPage />
      </MemoryRouter>
    )
    expect(screen.queryByTestId('settings-group-web-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('web-search-settings')).not.toBeInTheDocument()
    expect(screen.queryByText('联网搜索')).not.toBeInTheDocument()
    model.unmount()

    renderPage()
    expect(screen.queryByTestId('settings-group-web-search')).not.toBeInTheDocument()
    expect(screen.queryByTestId('web-search-settings')).not.toBeInTheDocument()
  })

  it('「记忆」栏（返工）：两张卡 —— 语义召回 + 记忆空间一张、记忆指令单独一张，重的都收进弹窗', () => {
    installKyclawBridge()
    setActiveSession('settings-memory-thread')
    renderPage('/settings/memory')

    const group = screen.getByTestId('settings-group-memory')
    expect(group).not.toHaveTextContent('暂无可调整的设置')
    // 两张卡同一套皮（bg-secondary + rounded-panel），卡片之间由 outer 的 gap 分开
    const base = screen.getByTestId('memory-card-base')
    const rulesCard = screen.getByTestId('memory-card-rules')
    expect(group).toContainElement(base)
    expect(group).toContainElement(rulesCard)
    expect([...base.children].map((child) => child.getAttribute('data-testid'))).toEqual([
      'recall-settings',
      'memory-space'
    ])
    expect([...rulesCard.children].map((child) => child.getAttribute('data-testid'))).toEqual([
      'rules-entry'
    ])
    // task-100 去卡片矩阵：记忆卡片与其它设置组统一为 1px hairline 分组（纸面，无卡片）
    for (const card of [base, rulesCard]) {
      expect(card).toHaveClass('border-t', 'border-hairline')
      expect(card).not.toHaveClass('rounded-panel')
    }
    // 主页面**不再铺**这些重家伙：记忆面板、规则编辑器、项目下拉、保存都不在文档里
    expect(screen.queryByTestId('memory-space-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('rules-open')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-rules')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('全局记忆指令')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rules-project-select')).not.toBeInTheDocument()
    expect(screen.queryByText('保存', { selector: 'button' })).not.toBeInTheDocument()
  })

  it('旧的 /settings/rules 深链落在「记忆」栏并**定位到入口**（不自动开弹窗，路由没动）', () => {
    installKyclawBridge()
    renderPage('/settings/rules')

    expect(screen.getByRole('heading', { level: 1, name: '记忆' })).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-memory')).toBeInTheDocument()
    // 定位的是入口那一行（按钮就在眼前），编辑器还收在弹窗里 —— 深链不偷偷弹窗
    expect(screen.getByTestId('rules-entry')).toBeInTheDocument()
    expect(screen.getByTestId('rules-open')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-rules')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-appearance')).not.toBeInTheDocument()
  })

  it('「用量」栏（round 5）：真实管理面（复用独立页的面板），不再是占位', async () => {
    renderPage('/settings/usage')

    expect(screen.getByTestId('settings-group-usage')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-usage')).not.toHaveTextContent('暂无可调整的设置')
    // 无桥环境下也要落到面板自己的错误态（= 真实面板接管了内容区，不是静态占位）
    await screen.findByTestId('usage-error')
  })

  it('「工作区」栏：工作区组件在这一栏里（不是占位）', () => {
    renderPage('/settings/workspaces')

    expect(screen.getByTestId('settings-group-workspaces')).toHaveTextContent('添加文件夹')
    expect(screen.getByTestId('settings-group-workspaces')).not.toHaveTextContent(
      '暂无可调整的设置'
    )
  })

  it('「工具与 MCP」栏已迁出（round 5）：深链 /settings/tools 回落默认栏，不再有 MCP 组', () => {
    renderPage('/settings/tools')

    expect(screen.queryByTestId('settings-group-tools')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-group-appearance')).toBeInTheDocument()
  })
})

/**
 * 记忆空间（「记忆」栏第二块）：入口按钮开弹窗，弹窗体里就是 MemoryPanel（不另做一份）。
 * 这里钉四件产品口径：看的是**当前活动会话**那一份（说明写明会话名）、正文区限高自己滚、
 * 没有会话时给"当前没有会话"空态（且一次请求都不发）、清空确认框是**弹窗套弹窗**
 * （Esc 只关最上面那层，焦点一级一级还回去）。
 */
describe('记忆空间（「记忆」栏的入口弹窗）', () => {
  it('打开后只看当前会话那一份：说明写明会话名、内容在限高滚动区里、正文只一处标题', async () => {
    const server = installFakeMemory({ 'space-thread': '# 用户信息\n- 姓名：张三' })
    installKyclawBridge()
    setActiveSession('space-thread', '杭州攻略')
    renderPage('/settings/memory')

    // 没点开之前：面板不在 DOM 里，也不发记忆请求
    expect(screen.queryByTestId('memory-space-body')).not.toBeInTheDocument()
    expect(server.calls).toHaveLength(0)

    fireEvent.click(screen.getByTestId('memory-space-open'))

    // 记忆是一整块 markdown，长起来会把弹窗撑破 —— 正文区封顶 60vh 里面滚
    expect(screen.getByTestId('memory-space-body')).toHaveClass('max-h-[60vh]', 'overflow-y-auto')
    expect(await screen.findByTestId('memory-content')).toHaveTextContent('张三')
    // 拉的是当前活动会话那一份（一条 GET，带 threadId）
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/memory',
      threadId: 'space-thread'
    })

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('杭州攻略') // 会话范围明确到名字
    // 内外不重复标题：弹窗里只有标题那一处「记忆空间」（正文不再套一层）
    expect(within(dialog).getAllByText('记忆空间')).toHaveLength(1)
    // 没有底部动作区的弹窗要有看得见的出口（蒙层/Esc 之外）
    expect(within(dialog).getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it('没有活动会话（草稿）：弹窗给"当前没有会话"空态，一次记忆请求都不发，也不编会话名', async () => {
    const server = installFakeMemory()
    installKyclawBridge()
    setDraftSession('draft-1')
    renderPage('/settings/memory')

    fireEvent.click(screen.getByTestId('memory-space-open'))

    expect(await screen.findByTestId('memory-no-session')).toHaveTextContent('当前没有会话')
    expect(screen.queryByTestId('memory-edit')).not.toBeInTheDocument()
    expect(server.calls).toHaveLength(0)
    // 没有那一份就不给"只显示「…」"的会话范围说明（空态由面板那句自己说）
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby')
  })

  it('清空确认框是嵌套弹窗：Esc 只关确认框（焦点还给「清空」），再 Esc 关记忆空间（焦点还给入口）', async () => {
    const server = installFakeMemory({ 'space-thread': '# 用户信息\n- 姓名：张三' })
    installKyclawBridge()
    setActiveSession('space-thread', '杭州攻略')
    renderPage('/settings/memory')

    fireEvent.click(screen.getByTestId('memory-space-open'))
    await screen.findByTestId('memory-content')

    fireEvent.click(screen.getByTestId('memory-clear'))
    expect(screen.getByTestId('memory-clear-confirm')).toBeInTheDocument()

    // Esc 只吃最上面那层：确认框关掉、记忆空间还开着，焦点回到「清空」
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('memory-clear-confirm')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('memory-space-body')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('memory-clear')).toHaveFocus())

    // 再 Esc：记忆空间关掉，焦点回到入口按钮
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('memory-space-body')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('memory-space-open')).toHaveFocus())

    // 全程只是关窗，没清空过（没有 DELETE）
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false)
  })
})

/**
 * 记忆指令（「记忆」栏第三行；返工：编辑器搬进二级弹窗）。
 *
 * 这里钉的是"页面收干净了 + 开合不丢没保存的输入 + 只有保存才清草稿"；
 * 写盘口径、项目文件、上限诊断那些行为层的东西仍在 rules-settings.spec 里钉着。
 */
describe('记忆指令（「记忆」栏第三行的二级弹窗）', () => {
  const PROJECT = { id: 'p1', name: '示例项目', path: 'D:\\P1', createdAt: '' }

  function renderWithProject(): ReturnType<typeof installKyclawBridge> {
    const settings = { ...defaultSettings(), projects: [PROJECT] }
    const bridge = installKyclawBridge(settings)
    useSettingsStore.setState({ settings })
    bridge.projects.readRules.mockResolvedValue({
      projectId: PROJECT.id,
      source: 'D:\\P1\\.kyclaw\\rules.md',
      text: '项目原文',
      diagnostics: [],
      processorRegistered: false,
      projectIncluded: true
    })
    renderPage('/settings/memory')
    return bridge
  }

  /** 项目下拉：ArrowDown 开菜单，再点条目（与 rules-settings.spec 同一套开/选动作） */
  function pickProject(testId: string): void {
    fireEvent.keyDown(screen.getByTestId('rules-project-select'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId(testId))
  }

  it('打开：弹窗标题「记忆指令」、正文限高自己滚、编辑器在里面、正文不重复标题', async () => {
    installKyclawBridge()
    renderPage('/settings/memory')

    expect(screen.queryByTestId('rules-dialog-body')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rules-open'))

    const body = screen.getByTestId('rules-dialog-body')
    expect(body).toHaveClass('max-h-[60vh]', 'overflow-y-auto')
    expect(await within(body).findByLabelText('全局记忆指令')).toBeInTheDocument()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('保存后下一轮对话生效') // 说明就一句
    // 内外不重复标题：弹窗里只有标题那一处「记忆指令」（正文不再套一层）
    expect(within(dialog).getAllByText('记忆指令')).toHaveLength(1)
  })

  it('Esc 关掉（焦点回到「编辑」）；再打开：没保存的全局草稿还在，且没写盘、没有假「已保存」', async () => {
    const bridge = installKyclawBridge()
    renderPage('/settings/memory')

    fireEvent.click(screen.getByTestId('rules-open'))
    const editor = await screen.findByLabelText('全局记忆指令')
    fireEvent.change(editor, { target: { value: '没保存的全局草稿' } })

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rules-dialog-body')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('rules-open')).toHaveFocus())

    fireEvent.click(screen.getByTestId('rules-open'))
    expect(await screen.findByLabelText('全局记忆指令')).toHaveValue('没保存的全局草稿')
    // 关掉 ≠ 保存：没写盘、也没挂一句假的「已保存」
    expect(bridge.update).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
  })

  it('项目那份也不丢：选中项目 + 改项目文本，关掉重开两者都在；换项目才清（换的是另一份文件）', async () => {
    renderWithProject()

    fireEvent.click(screen.getByTestId('rules-open'))
    await screen.findByLabelText('全局记忆指令')
    pickProject('rules-project-p1')
    const projectEditor = await screen.findByLabelText('项目记忆指令')
    expect(projectEditor).toHaveValue('项目原文')

    fireEvent.change(projectEditor, { target: { value: '项目没保存的草稿' } })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rules-dialog-body')).not.toBeInTheDocument())

    fireEvent.click(screen.getByTestId('rules-open'))
    // 选中的项目还在（不再回到「请选择项目」），项目文本也还是那份草稿
    expect(screen.getByTestId('rules-project-value')).toHaveTextContent('示例项目')
    await waitFor(() =>
      expect(screen.getByLabelText('项目记忆指令')).toHaveValue('项目没保存的草稿')
    )

    // 换项目 = 换一份文件：上一份没保存的输入不带到新项目上（旧行为不变）
    pickProject('rules-project-none')
    expect(screen.queryByLabelText('项目记忆指令')).not.toBeInTheDocument()
    pickProject('rules-project-p1')
    await waitFor(() => expect(screen.getByLabelText('项目记忆指令')).toHaveValue('项目原文'))
  })

  it('只有保存才清草稿：保存过就跟着落盘值走（别处改了设置，重开显示新的那份）', async () => {
    const bridge = installKyclawBridge()
    renderPage('/settings/memory')

    fireEvent.click(screen.getByTestId('rules-open'))
    const editor = await screen.findByLabelText('全局记忆指令')
    fireEvent.change(editor, { target: { value: '这一份要保存' } })

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ globalRules: '这一份要保存' }))
    expect(await screen.findByTestId('rules-notice')).toHaveTextContent('已保存')

    // 落盘之后**别处又改了设置**：草稿若还在，重开会显示"这一份要保存"（旧草稿）；
    // 草稿已清就该显示新的落盘值 —— 这一下正好把两者区分开
    act(() => {
      useSettingsStore.setState({
        settings: { ...defaultSettings(), globalRules: '别处写进来的' }
      })
    })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rules-dialog-body')).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId('rules-open'))

    expect(await screen.findByLabelText('全局记忆指令')).toHaveValue('别处写进来的')
    // 提示不跨开合常驻（那是上一次动作的回执，不是常亮状态）
    expect(screen.queryByTestId('rules-notice')).not.toBeInTheDocument()
  })
})

describe('外观 · 主题三选', () => {
  it('三档都在（跟随系统 / 亮色 / 暗色），默认档是跟随系统', () => {
    renderPage()

    expect(screen.getByTestId('theme-system')).toHaveTextContent('跟随系统')
    expect(screen.getByTestId('theme-light')).toHaveTextContent('亮色')
    expect(screen.getByTestId('theme-dark')).toHaveTextContent('暗色')

    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'false')
  })

  it('点「暗色」→ html[data-theme]=dark、选中态跟着走、落盘 {theme:dark}', async () => {
    const bridge = installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('theme-dark')).toHaveClass('bg-selected')
    expect(screen.getByTestId('theme-system')).not.toHaveClass('bg-selected')
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ theme: 'dark' }))
  })

  it('点「亮色」→ html[data-theme]=light（即使系统是深色）', () => {
    installMatchMedia(true)
    installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-light'))

    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('点「跟随系统」→ 立刻按当前系统值解析（系统深色就是 dark）', () => {
    installMatchMedia(true)
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'light' })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } })
    renderPage()
    expect(html().getAttribute('data-theme')).toBeNull()

    fireEvent.click(screen.getByTestId('theme-system'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'true')
  })

  it('落盘失败不改 UI（本次改动仍在，只留日志）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(console.error).toHaveBeenCalled())
  })
})

describe('外观 · 字号（task-69：三档 → 12–18 连续数值，默认 14）', () => {
  it('默认显示「14 px」；步进/滑杆都在，两端按钮按范围禁用', () => {
    renderPage()

    expect(screen.getByTestId('font-size-value')).toHaveTextContent('14 px')
    const slider = screen.getByTestId('font-size-slider') as HTMLInputElement
    expect(slider).toHaveAttribute('min', '12')
    expect(slider).toHaveAttribute('max', '18')
    expect(slider).toHaveValue('14')
    expect(screen.getByTestId('font-size-decrease')).toBeEnabled()
    expect(screen.getByTestId('font-size-increase')).toBeEnabled()
  })

  it('−/+ 与滑杆各改一次 → --ui-scale 跟着走、落盘只带 { uiFontSize }', async () => {
    const bridge = installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('font-size-increase'))
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.071')
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('15 px')

    fireEvent.click(screen.getByTestId('font-size-decrease'))
    fireEvent.click(screen.getByTestId('font-size-decrease'))
    expect(html().style.getPropertyValue('--ui-scale')).toBe('0.929')
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('13 px')

    fireEvent.change(screen.getByTestId('font-size-slider'), { target: { value: '18' } })
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.286')
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('18 px')

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ uiFontSize: 15 }))
    expect(bridge.update).toHaveBeenCalledWith({ uiFontSize: 13 })
    expect(bridge.update).toHaveBeenCalledWith({ uiFontSize: 18 })
  })

  it('12 与 18 两端：按钮各自禁用；滑杆夹在 range 内', () => {
    renderPage()

    fireEvent.change(screen.getByTestId('font-size-slider'), { target: { value: '12' } })
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('12 px')
    expect(screen.getByTestId('font-size-decrease')).toBeDisabled()

    fireEvent.change(screen.getByTestId('font-size-slider'), { target: { value: '18' } })
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('18 px')
    expect(screen.getByTestId('font-size-increase')).toBeDisabled()
  })

  it('切字号不动主题（显式暗色仍是暗色）', () => {
    installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('theme-dark'))
    fireEvent.click(screen.getByTestId('font-size-increase'))

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('15 px')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('外观 · 与落盘设置一致', () => {
  it('启动读到 dark + 16px 后，页面显示的值与 html scale 一致', async () => {
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'dark', uiFontSize: 16 })
    await useSettingsStore.getState().load()

    renderPage()

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.143')
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('font-size-value')).toHaveTextContent('16 px')
  })
})

/**
 * 外观 · 关闭窗口行为（0.1.3 托盘驻留）：三档偏好（每次询问 / 最小化到托盘 / 直接退出）走
 * settings:update 的补丁（可以在设置页改、也能改回来）；说明文案要交代适用范围
 * （Windows / Linux 才有效、macOS 沿 Dock、托盘不可用不硬藏）。
 */
describe('外观 · 关闭窗口行为（三档偏好）', () => {
  it('三档都在，默认「每次询问」，边界说明收敛为一行（Win/Linux 有效；macOS 跟随 Dock）', () => {
    renderPage()

    expect(screen.getByTestId('close-mode-ask')).toHaveTextContent('每次询问')
    expect(screen.getByTestId('close-mode-tray')).toHaveTextContent('最小化到托盘')
    expect(screen.getByTestId('close-mode-quit')).toHaveTextContent('直接退出')

    expect(screen.getByTestId('close-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('close-mode-tray')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('close-mode-quit')).toHaveAttribute('aria-pressed', 'false')

    // task-100 第三轮：UI 不解释控件功能；Windows/Linux 与 macOS 的边界语义收进 tooltip
    expect(screen.queryByTestId('close-mode-hint')).not.toBeInTheDocument()
    expect(screen.getByTitle('Windows / Linux 有效；macOS 跟随 Dock。')).toBeInTheDocument()
  })

  it('点「直接退出」→ 选中态跟着走、落盘 {closeToTrayMode:"quit"}；再点回「每次询问」能撤销', async () => {
    const bridge = installKyclawBridge()
    renderPage()

    fireEvent.click(screen.getByTestId('close-mode-quit'))

    expect(screen.getByTestId('close-mode-quit')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('close-mode-ask')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('close-mode-quit')).toHaveClass('bg-selected')
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ closeToTrayMode: 'quit' }))

    // 能撤销（不是单向设置）：切回「每次询问」同样落盘
    fireEvent.click(screen.getByTestId('close-mode-ask'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ closeToTrayMode: 'ask' }))
    expect(screen.getByTestId('close-mode-ask')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('close-mode-quit')).toHaveAttribute('aria-pressed', 'false')
  })

  it('落盘里是 tray 时选中态一致（读完设置再渲）', async () => {
    installKyclawBridge({ ...DEFAULT_SETTINGS, closeToTrayMode: 'tray' })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, closeToTrayMode: 'tray' } })

    renderPage()

    expect(screen.getByTestId('close-mode-tray')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('close-mode-ask')).toHaveAttribute('aria-pressed', 'false')
  })

  it('落盘失败不改 UI（本次改动仍在，只留日志）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    renderPage()

    fireEvent.click(screen.getByTestId('close-mode-tray'))

    expect(screen.getByTestId('close-mode-tray')).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(console.error).toHaveBeenCalled())
  })
})

describe('「追踪」/「关于」栏（T17）', () => {
  it('「追踪」栏：Langfuse 组在这一栏里（默认关的口径）', async () => {
    installKyclawBridge()
    renderPage('/settings/tracing')

    expect(screen.getByTestId('settings-group-tracing')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-tracing')).toHaveTextContent('Langfuse')
    await screen.findByTestId('langfuse-status')
  })

  it('「关于」栏：版本与更新组在这一栏里（当前版本 + 检查更新入口）', async () => {
    installKyclawBridge()
    renderPage('/settings/about')

    expect(screen.getByTestId('settings-group-about')).toBeInTheDocument()
    expect(screen.getByTestId('settings-group-about')).toHaveTextContent('版本与更新')
    await screen.findByTestId('about-check')
  })

  it('两栏都只渲自己那一组（栏目页口径不变）', () => {
    installKyclawBridge()
    renderPage('/settings/about')

    expect(screen.queryByTestId('settings-group-tracing')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-appearance')).not.toBeInTheDocument()
  })

  it('round 20：/settings/archived 渲染「归档」栏（标题 + 空态），其余组不出现', () => {
    installKyclawBridge()
    renderPage('/settings/archived')

    expect(screen.getByTestId('settings-group-archived')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: '归档' })).toBeInTheDocument()
    expect(screen.getByTestId('archive-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-usage')).not.toBeInTheDocument()
  })

  it('字体声部（task-64）：页面大标题与分组标题走衬线 reading；表单区仍是 sans', () => {
    installKyclawBridge()
    renderPage('/settings/appearance')

    // h1 = 章程「设置大标题」衬线档（22/600）
    const h1 = screen.getByRole('heading', { level: 1 })
    // task-100：页面 h1 走全站统一 PageTitle 档（衬线 22/30 × --ui-scale）
    expect(h1).toHaveClass('ui-page-title')
    expect(h1).not.toHaveClass('font-sans')
    // task-100：字号不再写行内 style，统一由 PageTitle 的 ui-page-title 规格（22/30 × --ui-scale）给
    expect(h1.closest('[data-testid="settings-page-column"]')).not.toBeNull()

    // 分组标题（SettingsGroup 的 h2）= 16/600 衬线
    const group = screen.getByTestId('settings-group-appearance')
    const groupTitle = within(group).getByRole('heading', { level: 2 })
    expect(groupTitle).toHaveClass('font-serif', 'font-semibold')
    expect(groupTitle).not.toHaveClass('font-sans')
  })
})
