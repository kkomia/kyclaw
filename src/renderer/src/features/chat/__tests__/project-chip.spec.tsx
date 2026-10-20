import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectChip } from '@renderer/features/chat/ProjectChip'
import { resetDraftProjectChoices } from '@renderer/features/chat/draft-project-choices'
import { resetProjectsStore, useProjectsStore } from '@renderer/features/projects/projects-store'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { putSessionProject } from '@renderer/lib/projects-api'
import { defaultSettings, type AppSettings } from '@shared/settings'
import { tick } from '@renderer/components/ui/__tests__/tick'

/**
 * 对话页的「选择项目」胶囊（round 64 起；round 66 定下宿主与时机：挂在对话页、输入卡**上方**
 * 那一行、只在初始页渲染）。本文件是**组件级**用例（行为一字不动）：
 *
 * 钉住的口径：
 *   1. 文案：没归属写「选择项目」，有归属写项目名（强调态）；
 *   2. **已有会话**：选中一个项目 = 立刻写映射（PUT /api/projects/mappings）；
 *   3. **草稿**：选中只记在本地（服务端一个字节都不写），本地映射当场跟上（权限 chip / 附件根靠它），
 *      **物化完成那一刻**才补写那一笔（等价于 startNew(projectId) 的效果）；
 *   4. 「不使用文件夹」= 摘掉归属（PUT null）；
 *   5. 「新建空白项目 / 使用现有文件夹」复用侧栏那份 CreateProjectDialog（不另写创建逻辑），
 *      建好即选中新项目；
 *   6. 项目多时给搜索框（≤5 个不给），没有项目时给一条禁用项；
 *   7. 形态：卡片外的独立控件（无描边 / 无常态底色）。
 * 宿主位置与生命周期（在卡片上方那一行、进对话不渲染）在 welcome-hero.spec.tsx 钉。
 */
vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

const PROJECTS = [
  { id: 'p1', name: '插件工程', path: 'D:\\ws\\插件工程', createdAt: '2026-10-11T00:00:00.000Z' },
  { id: 'p2', name: '资料', path: 'D:\\ws\\资料', createdAt: '2026-10-11T00:00:00.000Z' }
]

/** 造 n 个项目（名字「项目 1…」）——测搜索框的出现线与过滤 */
function manyProjects(count: number): AppSettings['projects'] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `p${index + 1}`,
    name: `项目 ${index + 1}`,
    path: `D:\\ws\\${index + 1}`,
    createdAt: '2026-10-11T00:00:00.000Z'
  }))
}

function mountChip(input: {
  threadId: string
  /** true = 服务端已经有这条会话（threads 里有它）；false = 草稿 */
  materialized: boolean
  projects?: AppSettings['projects']
}): void {
  const initial: AppSettings = { ...defaultSettings(), projects: input.projects ?? PROJECTS }
  installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
  useProjectsStore.setState({ mappings: {}, loaded: true })
  useSessionsStore.setState({
    threads: input.materialized
      ? [{ id: input.threadId, title: null, updatedAt: '2026-10-11T00:00:00.000Z' }]
      : [],
    activeId: input.threadId,
    loaded: true
  })
  render(<ProjectChip threadId={input.threadId} />)
}

/** 打开菜单（Radix 菜单：ArrowDown 开）并点一条 */
function pick(itemTestId: string): void {
  fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })
  fireEvent.click(screen.getByTestId(itemTestId))
}

function chipText(): string {
  return screen.getByTestId('composer-project').textContent ?? ''
}

beforeEach(() => {
  resetDraftProjectChoices()
  resetProjectsStore()
  resetSessionsStore()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.clearAllMocks()
})

describe('胶囊文案', () => {
  it('没有归属：写「选择项目」', () => {
    mountChip({ threadId: 't1', materialized: true })
    expect(chipText()).toBe('选择项目')
  })

  it('已有归属：写项目名；归属的项目已经不在清单里（被删）→ 回「选择项目」', () => {
    mountChip({ threadId: 't1', materialized: true })
    act(() => useProjectsStore.setState({ mappings: { t1: 'p1' } }))
    expect(chipText()).toBe('插件工程')

    act(() => useSettingsStore.setState({ settings: { ...defaultSettings(), projects: [] } }))
    expect(chipText()).toBe('选择项目')
  })

  it('没有会话（threadId 为空）时不渲染这枚胶囊', () => {
    const initial = defaultSettings()
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    render(<ProjectChip threadId={null} />)
    expect(screen.queryByTestId('composer-project')).not.toBeInTheDocument()
  })

  /**
   * 0.2.1（PB-053）：映射通道本版下架（501）→ 旧项目数据不兼容，「选择项目」不出现
   * （没有映射，选了也不生效；不给白点的入口）。
   */
  it('映射通道不可用：整枚胶囊不渲染（旧项目数据不兼容）', () => {
    const initial = { ...defaultSettings(), projects: PROJECTS }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    useProjectsStore.setState({ mappings: {}, loaded: true, unavailable: true })
    render(<ProjectChip threadId="t1" />)
    expect(screen.queryByTestId('composer-project')).not.toBeInTheDocument()
  })
})

describe('已有会话：选中即写映射', () => {
  it('点一个项目 → 本地映射立刻更新 + PUT 一条 + 文案跟上', async () => {
    mountChip({ threadId: 't1', materialized: true })

    pick('project-pick-p1')

    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('t1', 'p1'))
    expect(chipText()).toBe('插件工程')
  })

  it('换一个项目：再选一次直接覆盖（PUT 新的一条）', async () => {
    mountChip({ threadId: 't1', materialized: true })
    act(() => useProjectsStore.setState({ mappings: { t1: 'p1' } }))

    pick('project-pick-p2')

    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p2' })
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('t1', 'p2'))
  })

  it('「不使用文件夹」：摘掉归属（PUT null），文案回「选择项目」', async () => {
    mountChip({ threadId: 't1', materialized: true })
    act(() => useProjectsStore.setState({ mappings: { t1: 'p1' } }))

    pick('project-pick-none')

    expect(useProjectsStore.getState().mappings).toEqual({})
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('t1', null))
    expect(chipText()).toBe('选择项目')
  })
})

describe('草稿：只记在本地，物化那一刻补写', () => {
  it('选中一个项目：PUT 一个字节都不写，本地映射当场跟上', async () => {
    mountChip({ threadId: 'draft-1', materialized: false })

    pick('project-pick-p1')

    // 本地先落（权限 chip / 附件根 / 胶囊文案靠它立刻一致）
    expect(useProjectsStore.getState().mappings).toEqual({ 'draft-1': 'p1' })
    // 这份映射服务端还没回执：跟着标 pending，工作台按 round 49 的口径先不动手
    expect(useProjectsStore.getState().pending).toEqual({ 'draft-1': true })
    expect(chipText()).toBe('插件工程')
    await tick()
    expect(putSessionProject).not.toHaveBeenCalled()
  })

  it('物化完成（threads 里出现这条会话）→ 补写那一笔，且只写一次', async () => {
    mountChip({ threadId: 'draft-1', materialized: false })
    pick('project-pick-p2')

    await act(async () => {
      useSessionsStore.setState({
        threads: [{ id: 'draft-1', title: null, updatedAt: '2026-10-11T00:00:00.000Z' }]
      })
    })

    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('draft-1', 'p2'))
    expect(putSessionProject).toHaveBeenCalledTimes(1)
    // 回执到（assignSession 的 finally）：pending 清空，工作台可以按正确的根开工
    await waitFor(() => expect(useProjectsStore.getState().pending).toEqual({}))
  })

  it('选过又改主意（不使用文件夹）：物化后写的是最后那一次（PUT null）', async () => {
    mountChip({ threadId: 'draft-1', materialized: false })
    pick('project-pick-p2')
    pick('project-pick-none')

    await act(async () => {
      useSessionsStore.setState({
        threads: [{ id: 'draft-1', title: null, updatedAt: '2026-10-11T00:00:00.000Z' }]
      })
    })

    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('draft-1', null))
    expect(useProjectsStore.getState().mappings).toEqual({})
  })

  it('草稿期间没动过它：物化后一个字节都不写（不凭空记账）', async () => {
    mountChip({ threadId: 'draft-1', materialized: false })

    await act(async () => {
      useSessionsStore.setState({
        threads: [{ id: 'draft-1', title: null, updatedAt: '2026-10-11T00:00:00.000Z' }]
      })
    })
    await tick()
    expect(putSessionProject).not.toHaveBeenCalled()
  })
})

describe('菜单下半截：新建两条路复用创建对话框', () => {
  it('「新建空白项目」开的是侧栏那份对话框（名称 + 路径），建好即选中新项目', async () => {
    mountChip({ threadId: 't1', materialized: true })

    pick('project-pick-new-blank')
    expect(screen.getByText('创建项目')).toBeInTheDocument()
    const name = screen.getByTestId('project-name-input')
    expect(name).toHaveAttribute('placeholder', '请输入文件夹名称')

    fireEvent.change(name, { target: { value: '新项目' } })
    // 空白项目的路径 = 基底 + 名称（基底是异步取的：等它出现再保存，否则保存钮还禁用着）
    await waitFor(() =>
      expect(screen.getByTestId('project-path-value')).toHaveTextContent('新项目')
    )
    fireEvent.click(screen.getByTestId('project-create-save'))

    // 桥的 projects.create 回一份新清单（id = project-3）→ 新项目立刻成为当前归属
    await waitFor(() =>
      expect(
        useSettingsStore.getState().settings.projects.map((project) => project.name)
      ).toContain('新项目')
    )
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('t1', 'project-3'))
    expect(chipText()).toBe('新项目')
  })

  it('「使用现有文件夹」走同一条对话框（路径由原生选择器给）', async () => {
    mountChip({ threadId: 't1', materialized: true })

    pick('project-pick-new-folder')
    expect(screen.getByTestId('project-path-value')).toHaveTextContent('选择文件夹')

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '现有' } })
    fireEvent.click(screen.getByTestId('project-path-field'))
    await waitFor(() =>
      expect(screen.getByTestId('project-path-value')).toHaveTextContent('D:\\picked\\现有文件夹')
    )
    fireEvent.click(screen.getByTestId('project-create-save'))

    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith('t1', 'project-3'))
  })

  it('取消对话框：不建项目、归属不动', async () => {
    mountChip({ threadId: 't1', materialized: true })
    pick('project-pick-new-blank')
    fireEvent.click(screen.getByTestId('project-create-cancel'))

    await tick()
    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(putSessionProject).not.toHaveBeenCalled()
  })
})

describe('项目清单：搜索与空态', () => {
  it('项目少（≤5）：不给搜索框，列出的就是全部', () => {
    mountChip({ threadId: 't1', materialized: true })
    fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })

    expect(screen.getByTestId('project-pick-p1')).toBeInTheDocument()
    expect(screen.getByTestId('project-pick-p2')).toBeInTheDocument()
    expect(screen.queryByTestId('project-pick-search')).not.toBeInTheDocument()
  })

  it('项目多（≥6）：给搜索框，按名字过滤；没命中时给一条禁用项', () => {
    mountChip({ threadId: 't1', materialized: true, projects: manyProjects(7) })
    fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })

    const search = screen.getByTestId('project-pick-search')
    expect(screen.getByTestId('project-pick-p3')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '项目 3' } })
    expect(screen.getByTestId('project-pick-p3')).toBeInTheDocument()
    expect(screen.queryByTestId('project-pick-p1')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: '没有这个' } })
    expect(screen.queryByTestId('project-pick-p3')).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '没有匹配的项目' })).toHaveAttribute(
      'data-disabled'
    )
  })

  it('搜索词不留给下一次：关掉菜单再开是空搜索', async () => {
    mountChip({ threadId: 't1', materialized: true, projects: manyProjects(6) })
    fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })
    fireEvent.change(screen.getByTestId('project-pick-search'), { target: { value: '项目 2' } })
    expect(screen.queryByTestId('project-pick-p5')).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('project-pick-search'), { key: 'Escape' })
    await tick()
    expect(screen.queryByTestId('project-pick-search')).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })
    expect(screen.getByTestId('project-pick-search')).toHaveValue('')
    expect(screen.getByTestId('project-pick-p5')).toBeInTheDocument()
  })

  it('一个项目都没有：菜单里给一条禁用项 + 三条动作照旧在', () => {
    mountChip({ threadId: 't1', materialized: true, projects: [] })
    fireEvent.keyDown(screen.getByTestId('composer-project'), { key: 'ArrowDown' })

    expect(screen.getByRole('menuitem', { name: '还没有项目' })).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('project-pick-new-blank')).toBeInTheDocument()
    expect(screen.getByTestId('project-pick-new-folder')).toBeInTheDocument()
    expect(screen.getByTestId('project-pick-none')).toBeInTheDocument()
  })
})

describe('胶囊形态（卡片外的独立顶行控件：无描边、无常态底色）', () => {
  it('文字按钮形态：圆角 10、h-8（与卡片下方那枚 PPT 胶囊同档）、无任何描边 / 无常态底色；展开态铺灰底、有过渡（不硬切）', () => {
    mountChip({ threadId: 't1', materialized: true })

    const chip = screen.getByTestId('composer-project')
    expect(chip).toHaveClass('rounded-control', 'h-8', 'transition-colors')
    // 雷点 6/7：自己不带描边、也不给本色（hover / 展开才铺灰底）
    expect(chip.className).not.toMatch(/\bborder-/)
    const backgrounds = chip.className
      .split(/\s+/)
      .filter((name) => name.includes('bg-'))
      .sort()
    expect(backgrounds).toEqual(['data-[state=open]:bg-hover', 'hover:bg-hover'])
    // 没归属时是安静的一档
    expect(chip).toHaveClass('text-ink-tertiary')
  })

  it('选中项目后转强调色（仍然不带描边 / 底色）', () => {
    mountChip({ threadId: 't1', materialized: true })
    act(() => useProjectsStore.setState({ mappings: { t1: 'p1' } }))

    const chip = screen.getByTestId('composer-project')
    expect(chip).toHaveClass('text-(--accent-text)')
    expect(chip.className).not.toMatch(/\bborder-/)
    expect(chip.className).not.toMatch(/\bbg-(?!hover)/)
    cleanup()
  })
})
