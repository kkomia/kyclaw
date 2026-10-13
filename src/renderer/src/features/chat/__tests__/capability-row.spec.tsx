import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { CAPABILITIES } from '@renderer/features/chat/capabilities'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 75 · 初始页的**能力入口**（输入卡下方那一排胶囊）+ 点一下的落地。
 *
 * 为什么要有（用户口径：功能完整度）：空会话时只有一个输入框，「第一次打开不知道这个 agent
 * 能干什么」——参照 Kimi 初始页，输入卡下面一排能力胶囊把"能干的活"摆出来。
 *
 * 这里钉住四条：
 *   1. 入口集合与 `capabilities.ts` **一一对应**（数量、顺序、标签、testid 都由数据来）；
 *   2. **只在初始页**：与「选择项目」「PPT」同一个生命周期，进对话整行不渲染；
 *   3. 点一下把**该条原文**填进输入框、聚焦、**不自动发送**（回车才发）；
 *   4. 落点：整行在输入卡**外**、与 PPT 胶囊**同一行**（卡片下方那一行现在是一排）。
 * 走的是真 ChatSession + 真 Composer（显示链路 + composer-inbox 的草稿通道一起验），
 * 不重建宿主。
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

const THREAD_ID = 'thread-capabilities'

/** 数据里的这一条（spec 自己找不到就是数据被改名了——直接报出来，别静默） */
function capabilityOf(id: string): (typeof CAPABILITIES)[number] {
  const found = CAPABILITIES.find((capability) => capability.id === id)
  if (found === undefined) throw new Error(`capabilities.ts 里没有 ${id}`)
  return found
}

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

/** 输入框（发送的唯一入口还是它） */
function textarea(): HTMLTextAreaElement {
  return screen.getByTestId('composer-input') as HTMLTextAreaElement
}

function send(text: string): void {
  fireEvent.change(textarea(), { target: { value: text } })
  fireEvent.keyDown(textarea(), { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
})

describe('入口集合：数据与渲染一一对应（防漂）', () => {
  it('一排胶囊的数量、顺序、标签全部来自 capabilities.ts', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const row = screen.getByTestId('composer-capability-row')
    const chips = within(row).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(
      CAPABILITIES.map((capability) => capability.label)
    )
    for (const [index, capability] of CAPABILITIES.entries()) {
      // 每条数据的 id 都真的渲染出一个胶囊（id 改名 = testid 跟着改，不会漏）
      expect(chips[index]).toHaveAttribute('data-testid', `composer-capability-${capability.id}`)
      // 图标走 lucide（雷点 4）：每个胶囊里都有一个 svg，且没有 emoji 字符混在标签里
      expect(chips[index].querySelector('svg')).not.toBeNull()
      expect(capability.label).not.toMatch(/\p{Extended_Pictographic}/u)
      // 提示词是"可读可改的起始提示词"，不是空话：有骨架换行、也带着我们的纪律
      expect(capability.prompt.split('\n').length).toBeGreaterThan(3)
      expect(capability.prompt).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it('这一排就是四枚「文档 / 表格 / 报告 / 研究」（产品口径：少而准，不含 PPT）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    // 入口集合本身是产品决定，钉在这里：增删一条必须同时改数据与这条断言（不是随手加的）
    expect(CAPABILITIES.map((capability) => `${capability.id}:${capability.label}`)).toEqual([
      'docx:文档',
      'xlsx:表格',
      'report:报告',
      'research:研究'
    ])
    // PPT 不在这里：那枚胶囊是模板选择器，同一排里不该出现第二个「PPT」（用户口径：不重复）
    expect(screen.queryByTestId('composer-capability-ppt')).toBeNull()
    expect(
      within(screen.getByTestId('composer-capability-row')).queryByText('PPT')
    ).not.toBeInTheDocument()
  })
})

describe('落点：卡片下方那一行现在是一排（能力胶囊 + PPT）', () => {
  it('整行在输入卡外，与 PPT 胶囊同一行、同一条列宽配方', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const row = screen.getByTestId('composer-capability-row')
    const host = screen.getByTestId('composer-capabilities')
    const composer = screen.getByTestId('composer')
    const ppt = screen.getByTestId('composer-ppt-template')

    // 卡片外（与「选择项目」「PPT」一样，是卡片下方那一行的独立控件）
    expect(composer.contains(row)).toBe(false)
    // **同一行**：能力胶囊与 PPT 胶囊是同一个宿主的兄弟（不是各占一行 → 首页仍是一排）。
    // PPT 那里多一层（Popover 的 Trigger 外面还有那枚胶囊自己的 flex 包裹），所以差一跳。
    expect(host.contains(row)).toBe(true)
    expect(host.contains(ppt)).toBe(true)
    expect(row.parentElement).toBe(host)
    expect(ppt.parentElement?.parentElement).toBe(host)
    // 宿主那一行的既有配方不变（同列宽、左对齐、无框线）
    expect(host).toHaveClass('mx-auto', 'mt-2', 'w-full', 'max-w-(--chat-input-max-width)', 'px-1')
    expect(host.className).not.toMatch(/\bborder-/)
  })
})

describe('只在初始页：与「选择项目」「PPT」同一个生命周期', () => {
  it('草稿 / 空会话：整排在；发出去之后整排收合（还在 DOM，不卸载）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    // 初始页：一排入口 + PPT 都在（展开态）
    expect(screen.getByTestId('composer-capability-row')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ppt-template')).toBeInTheDocument()
    expect(screen.getByTestId('composer-capabilities-collapse')).toHaveAttribute(
      'data-active',
      'true'
    )

    await act(async () => {
      send('随便问一句')
    })

    // 进对话：卡片下方那一行**收合**（宿主 ChatPage 的 heroRows 判定，与两枚 chip 同一处）。
    // round 76：收合 ≠ 卸载 —— 行与胶囊都还在 DOM 里，收成 0 高 + 淡出（主档时长，不硬切）
    const collapse = screen.getByTestId('composer-capabilities-collapse')
    expect(collapse).toHaveAttribute('data-active', 'false')
    expect(collapse).toHaveClass('grid-rows-[0fr]', 'opacity-0', 'pointer-events-none')
    expect(collapse).toHaveAttribute('inert')
    expect(screen.getByTestId('composer-capability-row')).toBeInTheDocument()
    for (const capability of CAPABILITIES) {
      expect(screen.getByTestId(`composer-capability-${capability.id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('composer-capabilities')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ppt-template')).toBeInTheDocument()
    // 输入卡照旧在（只是下面那一行收着了）
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })
})

describe('点一下有着手点：填进输入框、聚焦、不自动发送', () => {
  it('点「研究」：提示词原文进输入框 + 焦点在输入框 + 一个请求都没发', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const research = capabilityOf('research')
    fireEvent.click(screen.getByTestId('composer-capability-research'))

    // 输入框本来是空的 → **原文一字不差**（不是截断；空框的"追加"就是填入）
    expect(textarea().value).toBe(research.prompt)
    // 聚焦（同一条通道的落位：光标交回输入框，用户接着就能改）
    expect(document.activeElement).toBe(textarea())
    // **没有自动发送**：一个请求都没有
    expect(control.requests).toHaveLength(0)
    // 输入卡还在初始页态（没被这一下带进对话）
    expect(screen.getByTestId('composer-capability-row')).toBeInTheDocument()
  })

  it('四条都填得进去（各自填各自的），互不串味', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    for (const capability of CAPABILITIES) {
      // 每一条都在**空输入框**上试（"已有草稿追加"是下一条用例的事）
      fireEvent.change(textarea(), { target: { value: '' } })
      fireEvent.click(screen.getByTestId(`composer-capability-${capability.id}`))
      expect(textarea().value).toBe(capability.prompt)
      expect(control.requests).toHaveLength(0)
    }
  })

  it('已有草稿：追加到末尾（原文一个字不丢）、光标落在末尾、不自动发送', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    fireEvent.change(textarea(), { target: { value: '先把这句留着' } })
    const research = capabilityOf('research')
    fireEvent.click(screen.getByTestId('composer-capability-research'))

    const value = textarea().value
    // 用户写的那半句**原样还在**，提示词追加在它后面（用一次换行隔开，不粘成一个词）
    expect(value.startsWith('先把这句留着\n')).toBe(true)
    expect(value).toContain(research.prompt)
    expect(value).toBe(`先把这句留着\n${research.prompt}`)
    // 光标落在末尾、焦点在输入框：接着就能改
    expect(textarea().selectionStart).toBe(value.length)
    expect(document.activeElement).toBe(textarea())
    // 仍然不自动发送
    expect(control.requests).toHaveLength(0)
  })

  it('只有空白的草稿算"空框"：直接填入整段提示词（不留一串空行）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    fireEvent.change(textarea(), { target: { value: '   \n  ' } })
    fireEvent.click(screen.getByTestId('composer-capability-xlsx'))

    expect(textarea().value).toBe(capabilityOf('xlsx').prompt)
    expect(control.requests).toHaveLength(0)
  })

  it('填进去的东西是可发的：回车才真的发出去（点胶囊本身不发）', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    fireEvent.click(screen.getByTestId('composer-capability-docx'))
    expect(control.requests).toHaveLength(0)

    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' })
    })

    expect(control.requests).toHaveLength(1)
    const sent = control.requests[0].messages.at(-1)
    expect(sent?.role).toBe('user')
    expect(JSON.stringify(sent?.parts)).toContain('帮我写一份 Word 文档')
  })
})
