import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { WelcomeHero } from '@renderer/features/chat/WelcomeHero'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 59 · 对话初始页（空会话）：品牌标题 + 输入框竖直居中；task-50 起为 A · 信笺报头，task-53 收口。
 *
 * 触发：当前会话消息为空、没有错误、没有待审批（草稿与空会话都算）。
 * 布局：标题 `absolute bottom-full` 挂在页脚（输入框那一格）之上、**不占布局高度** ——
 *   消息区与 welcome-spacer 等分剩余高度，输入框因此是真·竖直居中（用户实拍"偏下"的修正）。
 * 标题形态：报头 lockup（海獭印章 96 │ 竖线 │ `<kyclaw>` 56）+ 552 细线 + tagline
 *   「What needs doing, done.」（17/1.6）；task-53 删掉了「本地运行，文件不出这台机器」小字，
 *   并删除初始页角落的第二只海獭（一屏一只：初始页只有报头那只，进对话后只有 header 状态灯）。
 * 动效：进场淡入 + 上浮（`animate-message-in`；页脚晚 80ms 起步）；离场换 `animate-fade-out`
 *   —— 绝对定位没有高度可收合，"收过"内容仍在 DOM（不硬切、也不重挂，输入框全程可用）。
 * 有历史消息的会话（挂载时就没有初始页）压根不渲染它。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

const THREAD_ID = 'thread-hero'

function runtimeOf(control: MockTransport, history: UIMessage[] = []): ThreadChatRuntime {
  return {
    transport: control.transport,
    loadHistory: vi.fn(async () => history),
    onTurnEnd: vi.fn()
  }
}

async function renderSession(control: MockTransport, runtime: ThreadChatRuntime): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession transport={control.transport} threadId={THREAD_ID} runtime={runtime} />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

function send(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('空会话的初始页', () => {
  it('初始页可见：`<kyclaw>`（尖括号强调色 / 中间主色）+ 次级品牌语', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'true')
    expect(hero).toHaveClass('animate-message-in')

    const title = screen.getByTestId('welcome-title')
    expect(title.textContent).toBe('<kyclaw>')
    expect(title).toHaveClass('welcome-title') // 报头 display 档（welcome.css：56px，900 以下 ×0.85）
    expect(title).toHaveClass('text-ink') // 中间的品牌名用主文字色
    // 尖括号用强调色（双色法从 claw 移到括号上，对齐 KIMI <Code>）；A 起走衬线细尖括号声部
    const brackets = title.querySelectorAll('span')
    expect(brackets).toHaveLength(2)
    expect(brackets[0]?.textContent).toBe('<')
    expect(brackets[1]?.textContent).toBe('>')
    for (const bracket of brackets) {
      expect(bracket).toHaveClass('text-accent-text')
      expect(bracket).toHaveClass('welcome-bracket')
    }

    // A · 信笺（task-50）：报头 lockup = 海獭印章 96（task-96 起 v4-pixel inline SVG）│ 1px 竖线 │ 字标
    expect(hero.querySelector('.welcome-lockup')).not.toBeNull()
    const seal = hero.querySelector('.welcome-seal')
    expect(seal).not.toBeNull()
    expect(seal).toHaveAttribute('data-size', '96')
    expect(seal).toHaveAttribute('data-testid', 'otter-mark')
    expect(hero.querySelectorAll('.welcome-mark-rule')).toHaveLength(1)
    const hair = screen.getByTestId('welcome-hair')
    expect(hair).toHaveClass('welcome-hair')
    expect(hair).toHaveAttribute('aria-hidden', 'true')
    // 顺序：报头 → 细线 → tagline（细线在字标之后）
    expect(hair.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    expect(screen.getByTestId('welcome-tagline')).toHaveTextContent('What needs doing, done.')
    // A：英文 tagline 走阅读声部 17/1.6（welcome.css 覆盖 P0 的 16 档）+ 次墨色
    expect(screen.getByTestId('welcome-tagline')).toHaveClass(
      'welcome-tagline',
      'text-ink-secondary'
    )
    // task-53（用户口径「把本地运行文件不出这台机器的文字干掉」）：那一行小字整行删除
    expect(screen.queryByTestId('welcome-local-note')).not.toBeInTheDocument()
    expect(hero.textContent).not.toContain('本地运行')
    // 不多加任何小字/提示/菜单：标题块里只有字标 + 一行 tagline
    expect(hero.querySelectorAll('h1, p')).toHaveLength(2)

    // A 的纸感底（点阵 + 暖光两层伪元素，可一键关）与项目行引线
    const paper = screen.getByTestId('welcome-paper')
    expect(paper).toHaveClass('welcome-paper')
    expect(paper).toHaveAttribute('data-active', 'true')
    expect(paper).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('welcome-project-rule')).toBeInTheDocument()

    // task-96 收口「一屏一只」：初始页 = 报头 lockup 那只（v4 inline SVG）；
    // 顶栏品牌位（TitleBar，全局）在 /chat 路由不渲染（见 title-bar.spec）；
    // ChatHeader 不出海獭；Composer 状态海獭 hero 时不渲染。
    expect(screen.queryByTestId('welcome-ambient-otter')).not.toBeInTheDocument()
    expect(document.querySelector('.welcome-corner-slot')).toBeNull()
    expect(screen.queryByTestId('composer-otter')).not.toBeInTheDocument()
    expect(document.querySelectorAll('[data-testid="pixel-otter"]')).toHaveLength(0)
    expect(document.querySelectorAll('[data-testid="otter-mark"]')).toHaveLength(1)
    expect(hero.querySelectorAll('[data-testid="otter-mark"]')).toHaveLength(1)
    expect(screen.getByTestId('chat-header').querySelector('[data-testid="otter-mark"]')).toBeNull()

    // round 66：初始页「选择项目」行在卡片上方、输入卡在流内、能力行在卡片下方。
    // 2026-10-18 用户口径（"chat页面下面这一排按钮可以去掉了"）：卡片下方那排能力/PPT 胶囊
    // **整行移除** —— 初始页现在只有「选择项目」一行卡外控件。
    const composer = screen.getByTestId('composer')
    expect(composer.contains(screen.getByTestId('composer-project'))).toBe(false)
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capability-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()
  })

  it('初始页的竖排顺序：选择项目行 → 输入卡（卡片下方不再有任何行）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const ORDER = (a: HTMLElement, b: HTMLElement): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

    const projectRow = screen.getByTestId('composer-project-row')
    const composer = screen.getByTestId('composer')

    // DOM 顺序：选择项目行在输入卡之前；选择项目行不是卡片的孩子（卡外独立控件）
    expect(ORDER(projectRow, composer)).toBe(true)
    expect(composer.contains(projectRow)).toBe(false)

    // 能力行整行移除：composer 之后不再有任何 `composer-capabilities*` 容器/胶囊
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities-collapse')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capability-row')).not.toBeInTheDocument()
    // 四枚能力胶囊（文档 / 表格 / 报告 / 研究）与 PPT 模板胶囊都不在初始页
    for (const id of ['docx', 'xlsx', 'report', 'research']) {
      expect(screen.queryByTestId(`composer-capability-${id}`)).not.toBeInTheDocument()
    }
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()

    // 时机：初始页「选择项目」行在（它自己还是常挂 + 收合的那一行）
    expect(screen.getByTestId('composer-project')).toBeInTheDocument()
    expect(projectRow.contains(screen.getByTestId('composer-project'))).toBe(true)

    // 与卡片同列宽、左对齐（同一条 mx-auto + max-w + px-1 配方）
    expect(projectRow).toHaveClass(
      'mx-auto',
      'w-full',
      'max-w-(--chat-input-max-width)',
      'items-center',
      'px-1'
    )
    // 行自己不带描边 / 底色（雷点 7：卡片周围不再叠框线）
    expect(projectRow.className).not.toMatch(/\bborder-/)
    expect(projectRow.className).not.toMatch(/\bbg-/)

    // round 76：初始页这一行是**展开态**的常挂容器（收合只发生在"进对话"那一下）——
    // 同一档动效：主档时长、grid-template-rows 收合 + opacity 淡出（不硬切，雷点 5）
    const collapse = screen.getByTestId('composer-project-row-collapse')
    expect(collapse).toHaveAttribute('data-active', 'true')
    expect(collapse).toHaveClass(
      'grid-rows-[1fr]',
      'opacity-100',
      'transition-[grid-template-rows,opacity]',
      'duration-(--motion-main)'
    )
  })

  it('标题挂法：绝对定位在页脚（输入框那一格）之上，不占布局高度 → 输入框真·竖直居中', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const footer = screen.getByTestId('chat-footer')
    const hero = screen.getByTestId('welcome-hero')
    // 挂点：标题是页脚那一格的绝对定位子元素（页脚带 relative），不参与流内高度
    expect(footer).toHaveClass('relative')
    expect(footer).toContainElement(screen.getByTestId('composer'))
    expect(hero).toHaveClass('absolute', 'bottom-full', 'pointer-events-none')
    // 进场：页脚与标题同一套动画，页脚晚 80ms 起步
    expect(footer).toHaveClass('animate-message-in')
    expect(footer.className).toContain('[animation-delay:80ms]')

    // 分界线/消息区都还在（限宽列的既有口径不变），只是消息为空；下半格弹性占位撑着居中
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    const spacer = screen.getByTestId('welcome-spacer')
    expect(spacer).toHaveClass('grow')
    // 2026-10-18 A · 信笺重定基线（task-50）：mock 卡片中心 ≈478，现状实拍 ≈445（mt-28/112 时），
    // 下移 ~33px ⇒ mt 减 ~66 ⇒ 112 − 66 = 46，取整到 16 的倍数 = mt-12（48px）
    // （A 版 hero 绝对定位、不占布局高度，换报头/字号不改 above/below；推导见 ChatPage 注释）
    expect(spacer).toHaveClass('mt-12')
    expect(spacer).not.toHaveClass('mt-28')
    expect(spacer).not.toHaveClass('mt-18')
    expect(spacer).not.toHaveClass('mt-8')
    expect(spacer).toHaveClass('transition-[flex-grow,margin-top]')
  })

  it('有历史消息的会话：不渲染初始页', async () => {
    const control = createMockTransport()
    await renderSession(
      control,
      runtimeOf(control, [
        { id: 'h1', role: 'user', parts: [{ type: 'text', text: '上次聊到哪了' }] }
      ])
    )

    await screen.findByTestId('message-h1')
    expect(screen.queryByTestId('welcome-hero')).not.toBeInTheDocument()
    const spacer = screen.getByTestId('welcome-spacer')
    expect(spacer).toHaveClass('grow-0')
    // round 64/66：常规布局不带那段上提偏移（输入框贴底、消息区占满剩余高度）
    expect(spacer).not.toHaveClass('mt-12')
    expect(spacer).not.toHaveClass('mt-28')
    expect(spacer).not.toHaveClass('mt-18')
    // round 66（用户口径："进入到对话之后就不要显示这个「选择项目」了"）：
    // 已有对话里选择项目行不渲染；2026-10-18 起卡片下方的能力/PPT 行也已整行移除，
    // 所以两个 testid 在整个初始页生命周期里都不存在。
    expect(screen.queryByTestId('composer-project')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-project-row')).not.toBeInTheDocument()
    // round 76：常挂的收合容器同样不渲染（压根没进过初始页 = 没有对象可收）
    expect(screen.queryByTestId('composer-project-row-collapse')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities-collapse')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capability-row')).not.toBeInTheDocument()
    // 输入卡照旧在（只是不再有那些卡外行）
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })
})

describe('首条消息发出：标题离场、布局落到常规', () => {
  it('标题淡出（内容留 DOM）、占位收到 0、消息正常渲染，且输入框接着能用', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-active', 'true')

    await act(async () => {
      send('第一个问题')
    })

    // 离场 = 换成淡出（绝对定位没有高度可收合；两段动画首尾状态相接，不硬切）
    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'false')
    expect(hero).toHaveClass('animate-fade-out')
    expect(hero).not.toHaveClass('animate-message-in')
    expect(screen.getByTestId('chat-footer')).not.toHaveClass('animate-message-in')
    // 离场 ≠ 卸载：内容还在 DOM 里（有对象可动）
    expect(screen.getByTestId('welcome-title')).toBeInTheDocument()
    // 常规布局：页脚不再被弹性占位顶上去
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow-0')
    // round 66/76：发出去之后「选择项目」行退场（2026-10-18 起卡片下方那排能力/PPT 胶囊
    // 已整行移除，初始页只剩这一行卡外控件）。退场 ≠ 卸载：行还在 DOM 里，只是**收成 0 高 + 淡出**
    // （主档时长、不硬切），收着的行 `inert` + pointer-events-none —— 既不吃点击也进不了 Tab。
    const projectRow = screen.getByTestId('composer-project-row')
    expect(projectRow).toBeInTheDocument()
    const projectCollapse = screen.getByTestId('composer-project-row-collapse')
    expect(projectCollapse).toHaveAttribute('data-active', 'false')
    expect(projectCollapse).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'pointer-events-none')
    expect(projectCollapse).toHaveAttribute('inert')
    expect(projectCollapse).toHaveAttribute('aria-hidden', 'true')
    // 能力行整行移除：初始页生命周期内**不存在**（没有容器、没有胶囊、没有 PPT 模板 chip）
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities-collapse')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capability-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()
    // 选择项目 chip 跟着整行一起收着（不卸载）；输入卡照旧
    expect(screen.getByTestId('composer-project')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    // A 纸感底：hero 离场后只淡出（DOM 保留、data-active=false），不残留可见纹理
    expect(screen.getByTestId('welcome-paper')).toHaveAttribute('data-active', 'false')
    // 消息正常渲染
    expect(screen.getByTestId('message-list')).toHaveTextContent('第一个问题')
    expect(control.requests).toHaveLength(1)

    // 落位过程输入框保持可用：这一轮跑完还能接着发第二条
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await act(async () => {
      send('第二个问题')
    })
    expect(control.requests).toHaveLength(2)
    expect(screen.getByTestId('message-list')).toHaveTextContent('第二个问题')
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-active', 'false')

    // task-96 收口「一屏一只」：进对话后 /chat 的唯一海獭 = 输入卡右上角状态灯（task-62）；
    // ChatHeader 不出海獭；顶栏品牌位在 TitleBar 且 /chat 路由不渲染（title-bar.spec 钉）。
    expect(screen.queryByTestId('welcome-ambient-otter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('welcome-local-note')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-otter')).toBeInTheDocument()
    expect(screen.getByTestId('chat-header').querySelector('[data-testid="otter-mark"]')).toBeNull()
  })
})

/**
 * v4-pixel 守护海獭欢迎 logo（A · 信笺报头印章，task-96）：inline SVG，首帧即完整（无 sheet 空窗）。
 */
describe('v4-pixel 守护海獭欢迎 logo（A · 信笺报头印章，task-96）', () => {
  it('报头左侧印章：96 档 inline SVG + aria-hidden + 装饰性，不动 <kyclaw> 结构', () => {
    render(<WelcomeHero active />)

    const hero = screen.getByTestId('welcome-hero')
    const otter = screen.getByTestId('otter-mark')
    expect(hero).toContainElement(otter)
    expect(otter).toHaveAttribute('aria-hidden', 'true')
    expect(otter).toHaveAttribute('data-size', '96')
    expect(otter).toHaveAttribute('data-variant', 'animated')
    expect(otter).toHaveClass('welcome-otter', 'welcome-seal')
    expect(otter).toHaveAttribute('title', 'kyclaw')
    // inline SVG：首帧同步就有真实 path（不是等图片/sheet 加载的空窗）
    const svg = otter.querySelector('svg')
    expect(svg).toHaveAttribute('viewBox', '0 0 48 48')
    expect(svg?.querySelectorAll('path').length ?? 0).toBeGreaterThan(10)
    expect(otter.querySelector('img, image')).toBeNull()
    // 印章在字标左侧（DOM 里先于 h1，与竖线同属 lockup）；字标结构没被改动
    expect(otter.closest('.welcome-lockup')).not.toBeNull()
    expect(
      otter.compareDocumentPosition(screen.getByTestId('welcome-title')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.getByTestId('welcome-title').textContent).toBe('<kyclaw>')
  })

  it('离场：整块淡出、otter 暂停在当帧（不卸载、不挡输入框）', () => {
    const view = render(<WelcomeHero active />)
    expect(screen.getByTestId('otter-mark')).toHaveAttribute('data-paused', 'false')

    view.rerender(<WelcomeHero active={false} />)

    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'false')
    expect(hero).toHaveClass('animate-fade-out')
    // 离场 ≠ 卸载：内容还在（有对象可动），只是暂停
    expect(screen.getByTestId('welcome-title')).toBeInTheDocument()
    expect(screen.getByTestId('otter-mark')).toHaveAttribute('data-paused', 'true')
  })
})
