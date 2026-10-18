import { configure, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@renderer/App'

/**
 * 路由表：/chat、/settings（按栏目）、/plugins、/memory、/usage + 根路径与未知路径落到 /chat。
 * 生产用 HashRouter（file:// 兼容，见 App.tsx），测试里换 MemoryRouter 直接指定起始路由。
 *
 * round 5 后的导航口径：二级菜单只剩「设置」（设置为唯一导航源）；记忆/用量在设置左列里切
 * （/settings/memory、/settings/usage）；插件走侧栏「插件」入口（/plugins）。
 *
 * 本轮（设置页重组）：单独「约束」栏撤掉、并进「记忆」栏（左列不再有那一项）——
 * 老深链 /settings/rules 走 sections.ts 的别名仍落到「记忆」栏（E2E 也在用这个地址）。
 *
 * W7（2026-10-17）：设置 / 插件 / 记忆 / 用量四条路由挪进 ModuleHost —— 切过去时常驻 ChatPage
 * 只 hidden+inert、不卸载（草稿/滚动保活）。所以"进设置后 chat-page 还在 DOM 里"是新口径；
 * 直接深链进这四条时主对话不预挂（chatMounted 初始 false，与 /notes 同口径）。
 */
/**
 * 路由页 lazy 后（P1 包体）：页面 chunk 首次导航才加载，整套并发（~178 files）下可能 >1s。
 * 本文件所有 find/waitFor 的兜底窗口统一提到 15s；断言内容/强度不变（只给异步落定留时间）。
 */
const SUSPENSE_TIMEOUT = 15_000
configure({ asyncUtilTimeout: SUSPENSE_TIMEOUT })

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  )
}

/**
 * 设置入口（task-73：会话侧栏底部齿轮已删，唯一入口是最左 rail 底部的 primary-nav-settings）。
 */
function openSettings(): void {
  fireEvent.click(screen.getByTestId('primary-nav-settings'))
}

describe('路由与页面骨架', () => {
  it('/chat 是对话页，四页的壳都在（三栏 + 侧栏内容 + 插件入口）', async () => {
    renderAt('/chat')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-column')).toBeInTheDocument()
    expect(screen.getByTestId('work-panel')).toBeInTheDocument()
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    // round 61：无项目会话归「任务」组（空态整组不渲染）——侧栏内容用常驻的导航滚动容器认
    expect(screen.getByTestId('sidebar-nav-scroll')).toBeInTheDocument()
    // round 5：插件入口在「新建会话」下方（侧栏里）
    expect(screen.getByTestId('nav-plugins')).toBeInTheDocument()
  })

  it('二级菜单切设置：菜单里只有设置一项；记忆/用量在设置左列里切', async () => {
    renderAt('/chat')

    openSettings()
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    // W7：主对话常驻（不卸载），只是 hidden+inert —— 草稿/滚动因此保住
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-chat')).toHaveClass('hidden')
    expect(screen.getByTestId('module-chat')).toHaveAttribute('inert')

    // 设置左列切「记忆」→ 真实记忆面板（round 5：不再是占位）
    fireEvent.click(screen.getByTestId('settings-nav-memory'))
    expect(await screen.findByTestId('settings-group-memory')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-memory')).toHaveAttribute('aria-current', 'page')

    // 再切「用量」
    fireEvent.click(screen.getByTestId('settings-nav-usage'))
    expect(await screen.findByTestId('settings-group-usage')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-memory')).not.toBeInTheDocument()

    // 「返回」回会话视图（同一挂 ChatPage 重新可见）
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-chat')).not.toHaveClass('hidden')
  })

  it('侧栏「插件」入口：切到 /plugins，选中态联动；返回会话后取消选中', async () => {
    renderAt('/chat')
    const chat = screen.getByTestId('chat-page')

    fireEvent.click(screen.getByTestId('nav-plugins'))
    expect(await screen.findByTestId('plugins-page')).toBeInTheDocument()
    expect(screen.getByTestId('nav-plugins')).toHaveAttribute('aria-current', 'page')
    // W7：插件页也在 ModuleHost 里 —— 主对话常驻隐藏，不卸载
    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getByTestId('module-chat')).toHaveClass('hidden')

    fireEvent.click(screen.getByTestId('new-session'))
    // 新建会话会让 ChatPage 按会话重挂（既有口径"换会话 = 换一挂"），所以这里不比节点身份，
    // 只验主对话回到可见、插件选中态解除
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-chat')).not.toHaveClass('hidden')
    expect(screen.getByTestId('nav-plugins')).not.toHaveAttribute('aria-current')
  })

  it('主列渲染的是路由内容（同一份壳不重新挂载：侧栏与顶栏还在）', async () => {
    renderAt('/chat')
    const sidebar = screen.getByTestId('sidebar')

    openSettings()
    fireEvent.click(screen.getByTestId('settings-nav-usage'))

    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBe(sidebar)
    expect(screen.getByTestId('titlebar')).toBeInTheDocument()
  })

  it('根路径落到 /chat', async () => {
    renderAt('/')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('未知路径也落到 /chat（不让主列空着）', async () => {
    renderAt('/nonsense')

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('/memory 与 /usage 直达保留（不进任何菜单，standalone 页面仍在）', async () => {
    renderAt('/memory')
    expect(await screen.findByTestId('memory-page')).toBeInTheDocument()
    // 侧栏里没有指向它的菜单项（只有设置一项 + 插件入口）
    expect(screen.queryByTestId('nav-memory')).not.toBeInTheDocument()
    // W7：深链进旧页面不预挂聊天（与 /notes 同口径；进过对话后才常驻）
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
  })

  it('设置入口唯一：rail 底部齿轮在、会话侧栏底部不再有第二个（task-73 去重）', async () => {
    renderAt('/chat')

    expect(screen.getByTestId('primary-nav-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-footer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-menu-trigger')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-memory')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-usage')).not.toBeInTheDocument()
  })

  it('设置页按栏目切内容：左列设置菜单 + /settings/:section 深链', async () => {
    renderAt('/settings')

    // W7：设置深链不预挂聊天（chatMounted 初始 false）；页面由 ModuleHost 的 Outlet 渲染
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(await screen.findByTestId('settings-nav')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTestId('settings-group-appearance')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-model')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('settings-nav-model'))

    expect(await screen.findByTestId('settings-group-model')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-appearance')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-model')).toHaveAttribute('aria-current', 'page')
  })

  it('设置左列没有「工具与 MCP」（round 5 迁到插件页）', async () => {
    renderAt('/settings')

    await screen.findByTestId('settings-page')
    expect(screen.queryByTestId('settings-nav-tools')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-tools')).not.toBeInTheDocument()
  })

  it('设置左列没有单独的「约束」（本轮合栏：并进「记忆」栏，不在菜单里再占一项）', async () => {
    renderAt('/settings')

    await screen.findByTestId('settings-page')
    expect(screen.queryByTestId('settings-nav-rules')).not.toBeInTheDocument()
    // 默认栏是「外观」：没切到记忆栏时，规矩那块不该出现在页面上
    expect(screen.queryByTestId('settings-group-rules')).not.toBeInTheDocument()
  })

  it('旧的 /settings/rules 深链落在「记忆」栏（合栏后老地址不掉到默认栏）', async () => {
    renderAt('/settings/rules')

    expect(await screen.findByTestId('settings-group-memory')).toBeInTheDocument()
    // 定位到「记忆指令」入口那一行（编辑器收在二级弹窗里：深链不偷偷弹窗）
    expect(await screen.findByTestId('rules-entry')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-rules')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-group-appearance')).not.toBeInTheDocument()
    // 左列选中态也跟着别名走（老地址 = 记忆栏）
    expect(screen.getByTestId('settings-nav-memory')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('settings-nav-rules')).not.toBeInTheDocument()
  })

  it('设置页脏栏目回落默认栏（URL 手改坏了也不空着）', async () => {
    renderAt('/settings/nonsense')

    expect(await screen.findByTestId('settings-group-appearance')).toBeInTheDocument()
  })

  it('内容列限宽居中：各页面都走 .content-column（侧栏覆盖层不压内容、也不横向裁切）；round 23 起滚动条贴窗口右缘', async () => {
    renderAt('/chat')

    // round 21：对话页套了两层——chat-page = 整幅（摘要轨的定位基准），限宽列是它的子层。
    // task-114 起 chat 的限宽改走 DSH 宽度公式（.chat-content / --chat-content-width），
    // 不再是通用 .content-column；其余二级页面仍走 .content-column（下方断言）。
    expect(screen.getByTestId('chat-column')).toHaveClass('chat-column')
    expect(screen.getByTestId('chat-page')).toContainElement(screen.getByTestId('chat-column'))

    openSettings()
    expect(await screen.findByTestId('settings-page-column')).toHaveClass('content-column')
    // round 23：滚动容器是外层（全宽）——滚动条贴窗口右缘，内容列限宽口径不变
    expect(await screen.findByTestId('settings-page')).toHaveClass('overflow-y-auto')
    expect(screen.getByTestId('settings-page-column')).not.toHaveClass('overflow-y-auto')

    fireEvent.click(screen.getByTestId('settings-nav-memory'))
    expect(screen.getByTestId('settings-page-column')).toHaveClass('content-column')

    fireEvent.click(screen.getByTestId('settings-back'))
    fireEvent.click(screen.getByTestId('nav-plugins'))
    expect(await screen.findByTestId('plugins-page-column')).toHaveClass('content-column')
    expect(await screen.findByTestId('plugins-page')).toHaveClass('overflow-y-auto')
  })
})
/**
 * M3-S4：Office 从"路由内页面"改为"模块宿主常驻页面"（与 /chat 同口径）。
 * `/office` 路由元素为 null，页面由 ModuleHost 挂载；离开路由只 hidden+inert，不卸载。
 */
describe('路由：Office 模块保活（M3-S4）', () => {
  it('深链 /office：Office 页在、聊天不预挂、模块 active；切聊天后 Office 仍在 DOM（hidden+inert）', async () => {
    renderAt('/office')

    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-page-title')).toHaveTextContent('Office')
    expect(screen.getByTestId('module-office')).toHaveAttribute('data-active', 'true')
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    // 非 Office/chat 的 Outlet 内容此时是空的（Office 不再走 Outlet）
    expect(screen.queryByTestId('settings-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('primary-nav-chat'))

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    // 保活口径：Office 页面仍在 DOM，只是隐藏并 inert
    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-office')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('module-office')).toHaveClass('hidden')
    expect(screen.getByTestId('module-office')).toHaveAttribute('inert')
    // 唯一实例：不会出现第二个 OfficePage
    expect(screen.getAllByTestId('office-page')).toHaveLength(1)
  })
})
