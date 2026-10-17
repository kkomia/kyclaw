import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 59 · 对话初始页（空会话）：品牌标题 + 输入框竖直居中。
 *
 * 触发：当前会话消息为空、没有错误、没有待审批（草稿与空会话都算）。
 * 布局：标题 `absolute bottom-full` 挂在页脚（输入框那一格）之上、**不占布局高度** ——
 *   消息区与 welcome-spacer 等分剩余高度，输入框因此是真·竖直居中（用户实拍"偏下"的修正）。
 * 标题形态：`<kyclaw>`（尖括号强调色 / 中间主文字色）+ 英文 tagline
 *   「What needs doing, done.」（衬线 16/1.6）+ 一行中文小字「本地运行，文件不出这台机器」。
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

describe('空会话的初始页', () => {
  it('初始页可见：`<kyclaw>`（尖括号强调色 / 中间主色）+ 次级品牌语', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'true')
    expect(hero).toHaveClass('animate-message-in')

    const title = screen.getByTestId('welcome-title')
    expect(title.textContent).toBe('<kyclaw>')
    expect(title).toHaveClass('welcome-title') // 展示级字号（tailwind.css 的配方，跟着 UI 字号档缩放）
    expect(title).toHaveClass('text-ink') // 中间的品牌名用主文字色
    // 尖括号用强调色（双色法从 claw 移到括号上，对齐 KIMI <Code>）
    const brackets = title.querySelectorAll('span')
    expect(brackets).toHaveLength(2)
    expect(brackets[0]?.textContent).toBe('<')
    expect(brackets[1]?.textContent).toBe('>')
    for (const bracket of brackets) expect(bracket).toHaveClass('text-accent-text')

    expect(screen.getByTestId('welcome-tagline')).toHaveTextContent('What needs doing, done.')
    // P0（章程 §9.2/D-25）：英文 tagline 走阅读声部（衬线 16/1.6）+ 次墨色
    expect(screen.getByTestId('welcome-tagline')).toHaveClass(
      'welcome-tagline',
      'text-ink-secondary'
    )
    // 字标下保留中文小字「本地运行，文件不出这台机器」（sans 12、三级可读档）
    expect(screen.getByTestId('welcome-local-note')).toHaveTextContent('本地运行，文件不出这台机器')
    expect(screen.getByTestId('welcome-local-note')).toHaveClass(
      'text-c1',
      'text-ink-tertiary-readable'
    )
    // 不多加任何小字/提示/菜单：标题块里只有字标 + 两行文案（tagline / 本地小字）
    expect(hero.querySelectorAll('h1, p')).toHaveLength(3)

    // round 66：初始页三样各就各位 —— 标题（页脚之上）→「选择项目」行（卡片上方）→ 输入卡 →
    // PPT 行（卡片下方）。两枚 chip 都在**卡片外**，见下面那条竖排顺序用例
    const composer = screen.getByTestId('composer')
    expect(composer.contains(screen.getByTestId('composer-project'))).toBe(false)
    expect(composer.contains(screen.getByTestId('composer-ppt-template'))).toBe(false)
  })

  it('初始页的竖排顺序：选择项目行 → 输入卡 → PPT 行（都在卡片外；DOM 顺序 + 几何方位都钉住）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const ORDER = (a: HTMLElement, b: HTMLElement): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

    const projectRow = screen.getByTestId('composer-project-row')
    const composer = screen.getByTestId('composer')
    const pptRow = screen.getByTestId('composer-capabilities')

    // DOM 顺序：选择项目行在输入卡之前，PPT 行在输入卡之后；两行都不是卡片的孩子
    expect(ORDER(projectRow, composer)).toBe(true)
    expect(ORDER(composer, pptRow)).toBe(true)
    expect(composer.contains(projectRow)).toBe(false)
    expect(composer.contains(pptRow)).toBe(false)

    // 时机：初始页两行都在（与 PPT 同一个生命周期，见下面两个用例）
    expect(screen.getByTestId('composer-project')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ppt-template')).toBeInTheDocument()
    expect(projectRow.contains(screen.getByTestId('composer-project'))).toBe(true)
    expect(pptRow.contains(screen.getByTestId('composer-ppt-template'))).toBe(true)

    // 与卡片同列宽、左对齐（两行都用同一条 mx-auto + max-w + px-1 配方）
    for (const row of [projectRow, pptRow]) {
      expect(row).toHaveClass(
        'mx-auto',
        'w-full',
        'max-w-(--chat-input-max-width)',
        'items-center',
        'px-1'
      )
    }
    // 两行自己都不带描边 / 底色（雷点 7：卡片周围不再叠框线）
    expect(projectRow.className).not.toMatch(/\bborder-/)
    expect(projectRow.className).not.toMatch(/\bbg-/)

    // round 76：初始页这两行是**展开态**的常挂容器（收合只发生在"进对话"那一下）——
    // 同一档动效：主档时长、grid-template-rows 收合 + opacity 淡出（不硬切，雷点 5）
    for (const testId of ['composer-project-row', 'composer-capabilities']) {
      const collapse = screen.getByTestId(`${testId}-collapse`)
      expect(collapse).toHaveAttribute('data-active', 'true')
      expect(collapse).toHaveClass(
        'grid-rows-[1fr]',
        'opacity-100',
        'transition-[grid-template-rows,opacity]',
        'duration-(--motion-main)'
      )
    }
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
    // round 66：占位的上提偏移重推成 mt-18（72px）—— 卡片上/下各多一行后，卡片中心仍落在窗口中心
    // 上方 40px（与 round 64/65 用户已看过、未再提"偏下"的位置逐像素一致；推导见 ChatPage 的注释）
    expect(spacer).toHaveClass('mt-18')
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
    expect(spacer).not.toHaveClass('mt-18')
    // round 66（用户口径："进入到对话之后就不要显示这个「选择项目」了"）：
    // 已有对话里**两枚 chip 都不渲染** —— 卡片上方的选择项目行与卡片下方的 PPT 行整行消失
    expect(screen.queryByTestId('composer-project')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-project-row')).not.toBeInTheDocument()
    // round 76：常挂的收合容器同样不渲染（压根没进过初始页 = 没有对象可收）
    expect(screen.queryByTestId('composer-project-row-collapse')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-capabilities-collapse')).not.toBeInTheDocument()
    // 输入卡照旧在（只是不再有那两行）
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
    // round 66/76：发出去之后**两行一起退场**（「选择项目」在卡片上方、PPT 在卡片下方；
    // 两枚与初始页同一个生命周期）。退场 ≠ 卸载：两行都还在 DOM 里，只是**收成 0 高 + 淡出**
    // （主档时长、不硬切），收着的行 `inert` + pointer-events-none —— 既不吃点击也进不了 Tab。
    for (const testId of ['composer-project-row', 'composer-capabilities']) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
      const collapse = screen.getByTestId(`${testId}-collapse`)
      expect(collapse).toHaveAttribute('data-active', 'false')
      expect(collapse).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'pointer-events-none')
      expect(collapse).toHaveAttribute('inert')
      expect(collapse).toHaveAttribute('aria-hidden', 'true')
    }
    // 两枚 chip 跟着整行一起收着（不卸载）；输入卡照旧
    expect(screen.getByTestId('composer-project')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ppt-template')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
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
  })
})
