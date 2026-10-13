/**
 * 轨迹页（渲染）：页签式的三件套 —— 工具栏 / 时间轴泳道 / 步骤列表 + 明细面板 + 导出。
 *
 * 渲染端测试写法照抄 chat 既有 spec：直接渲染具名导出、mock 取数那一层（bridge 只在
 * 需要会话标题时用）。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { defaultSettings } from '@shared/settings'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { StoredMessage } from '@shared/threads'
import type { TrajectoryUsageRun } from '@shared/trajectory'
import { TrajectoryView } from '../TrajectoryView'

vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreadMessages: vi.fn(async () => []),
  fetchThreadCompaction: vi.fn(async () => null),
  fetchThreads: vi.fn(async () => []),
  createThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(),
  generateThreadTitle: vi.fn(),
  compactThread: vi.fn()
}))

vi.mock('@renderer/lib/trajectory-api', () => ({
  fetchThreadUsageRuns: vi.fn(async () => [])
}))

import { fetchThreadMessages, fetchThreadCompaction } from '@renderer/lib/threads-api'
import { fetchThreadUsageRuns } from '@renderer/lib/trajectory-api'

const THREAD_ID = 't1'

function message(
  id: string,
  role: 'user' | 'assistant',
  createdAt: number,
  parts: unknown[]
): StoredMessage {
  return {
    id,
    role,
    createdAt: new Date(createdAt).toISOString(),
    content: {
      format: 2,
      parts,
      ...(role === 'assistant'
        ? { metadata: { modelId: 'deepseek-flash', provider: 'deepseek.chat' } }
        : {})
    }
  } as unknown as StoredMessage
}

const MESSAGES: StoredMessage[] = [
  message('u1', 'user', 1000, [{ type: 'text', text: '帮我看看今天有什么新闻', createdAt: 1000 }]),
  message('a1', 'assistant', 2600, [
    { type: 'reasoning', reasoning: '先搜一下', createdAt: 1100 },
    { type: 'text', text: '我先搜索', createdAt: 1200 },
    {
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolName: 'bash',
        toolCallId: 'c1',
        args: { command: 'date' },
        result: '2026-10-13 星期二'
      },
      updatedAt: 2000
    },
    { type: 'step-start', createdAt: 2100, model: 'deepseek-flash' },
    { type: 'text', text: '今天是星期二', createdAt: 2500 }
  ]),
  message('u2', 'user', 3000, [{ type: 'text', text: '再查天气', createdAt: 3000 }]),
  message('a2', 'assistant', 3600, [{ type: 'text', text: '天气晴', createdAt: 3500 }])
]

const USAGE: TrajectoryUsageRun[] = [
  {
    id: 'r1',
    runId: 'run-1',
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    input: 1234,
    output: 56,
    total: 1290,
    cachedInput: 1000,
    contextInput: 4200,
    contextCachedInput: 3900,
    stepCount: 2,
    cost: 0.0123,
    createdAt: new Date(1500).toISOString()
  }
]

function mount(): { click: ReturnType<typeof vi.fn>; createObjectURL: ReturnType<typeof vi.fn> } {
  installKyclawBridge(defaultSettings())
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
  useSessionsStore.setState({
    threads: [{ id: THREAD_ID, title: '新闻会话', updatedAt: '2026-10-13T00:00:00.000Z' }],
    activeId: THREAD_ID,
    loaded: true,
    error: null,
    notices: {}
  })

  vi.mocked(fetchThreadMessages).mockResolvedValue(MESSAGES)
  vi.mocked(fetchThreadUsageRuns).mockResolvedValue(USAGE)
  vi.mocked(fetchThreadCompaction).mockResolvedValue(null)

  const createObjectURL = vi.fn(() => 'blob:kyclaw')
  const click = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click as () => void)

  render(<TrajectoryView threadId={THREAD_ID} active revision="rev-1" />)
  return { click, createObjectURL }
}

beforeEach(() => {
  resetSessionsStore()
  vi.mocked(fetchThreadMessages).mockClear()
  vi.mocked(fetchThreadUsageRuns).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.restoreAllMocks()
})

describe('轨迹页 · 工具栏', () => {
  it('三段视图切换（时长 / 轮次 / 调用）+ 搜索框 + 导出都在', async () => {
    mount()

    const toolbar = await screen.findByTestId('trajectory-toolbar')
    expect(within(toolbar).getByTestId('trajectory-mode-duration')).toHaveTextContent('时长')
    expect(within(toolbar).getByTestId('trajectory-mode-turns')).toHaveTextContent('轮次')
    expect(within(toolbar).getByTestId('trajectory-mode-calls')).toHaveTextContent('调用')
    expect(within(toolbar).getByTestId('trajectory-search')).toHaveAttribute('placeholder', '搜索')
    expect(within(toolbar).getByTestId('trajectory-export')).toHaveTextContent('导出')
  })

  it('切到「调用」档：列表只剩工具行', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    expect(screen.getByTestId('trajectory-row-0')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('trajectory-mode-calls'))

    await waitFor(() => {
      expect(screen.queryByTestId('trajectory-row-0')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('trajectory-row-2')).toBeInTheDocument()
    expect(screen.queryByTestId('trajectory-row-3')).not.toBeInTheDocument()
  })

  it('搜索真的过滤：按正文 / 工具名都能收窄，清空后恢复全量', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')

    fireEvent.change(screen.getByTestId('trajectory-search'), { target: { value: '天气' } })
    await waitFor(() => expect(screen.queryByTestId('trajectory-row-0')).not.toBeInTheDocument())
    expect(screen.getByTestId('trajectory-search-count')).toHaveTextContent('命中')

    fireEvent.change(screen.getByTestId('trajectory-search'), { target: { value: 'bash' } })
    await waitFor(() => expect(screen.getByTestId('trajectory-row-2')).toBeInTheDocument())
    expect(screen.queryByTestId('trajectory-row-1')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('trajectory-search'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId('trajectory-row-0')).toBeInTheDocument())
  })

  it('搜索框是自绘的（不用原生 type=search 的装饰），清除按钮自己画', async () => {
    mount()
    const input = await screen.findByTestId('trajectory-search')
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.queryByTestId('trajectory-search-clear')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '天气' } })
    fireEvent.click(screen.getByTestId('trajectory-search-clear'))

    await waitFor(() => expect(screen.getByTestId('trajectory-search')).toHaveValue(''))
    expect(screen.getByTestId('trajectory-row-0')).toBeInTheDocument()
  })

  it('收起轮次：数据行让位、只留一行摘要，再点一次展开', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')

    fireEvent.click(screen.getByTestId('trajectory-fold-all'))
    await waitFor(() =>
      expect(screen.getByTestId('trajectory-collapsed-1')).toHaveTextContent(
        '2 个步骤 · 1 个工具调用'
      )
    )
    expect(screen.queryByTestId('trajectory-row-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('trajectory-fold-all'))
    await waitFor(() => expect(screen.getByTestId('trajectory-row-2')).toBeInTheDocument())
  })
})

describe('轨迹页 · 时间轴泳道', () => {
  it('三条泳道（输入 / 模型 / 工具）与块都在；块的位置来自真实时刻', async () => {
    mount()
    const timeline = await screen.findByTestId('trajectory-timeline')

    for (const lane of ['输入', '模型', '工具']) {
      expect(within(timeline).getByText(lane)).toBeInTheDocument()
    }
    // 域 = [1000, 3000]（投影后坐标：u2 与最后一条之间的 500ms 空白被压掉）
    const span = screen.getByTestId('trajectory-span-2')
    expect(span).toHaveStyle({ left: `${((1200 - 1000) / 2000) * 100}%` })
    expect(span).toHaveClass('bg-warning')
  })

  it('点时间轴上的块 → 选中的行高亮（与列表双向联动的一半）', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    // 面板常驻（收起时 0 宽 + 透明）：没选中时是收起态
    expect(screen.getByTestId('trajectory-details')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByTestId('trajectory-span-2'))

    await waitFor(() =>
      expect(screen.getByTestId('trajectory-details')).toHaveAttribute('data-open', 'true')
    )
    expect(screen.getByTestId('trajectory-row-2')).toHaveAttribute('data-selected', 'true')
  })

  it('点列表的行 → 时间轴上对应的块被标成选中（另一半）', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')

    fireEvent.click(screen.getByTestId('trajectory-row-1'))

    await waitFor(() =>
      expect(screen.getByTestId('trajectory-span-1')).toHaveAttribute('data-selected', 'true')
    )
  })
})

describe('轨迹页 · 明细面板', () => {
  it('工具行给「概述 / 参数 / 结果 / 计时」四页；参数与结果是可复制的原文', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    fireEvent.click(screen.getByTestId('trajectory-row-2'))

    const panel = await screen.findByTestId('trajectory-details')
    for (const tab of ['overview', 'input', 'output', 'timing']) {
      expect(within(panel).getByTestId(`trajectory-tab-${tab}`)).toBeInTheDocument()
    }

    // 概述：来源 / 状态 / 时长 / 本轮用量
    const overview = within(panel).getByTestId('trajectory-tab-panel-overview')
    expect(within(overview).getByText('工具')).toBeInTheDocument()
    expect(within(overview).getByText('已完成')).toBeInTheDocument()
    expect(within(overview).getByText('800 毫秒')).toBeInTheDocument()
    expect(within(overview).getByText('1,234（2 次调用合计）')).toBeInTheDocument()
    expect(within(overview).getByText('4,200')).toBeInTheDocument()

    // 参数：原始 JSON
    fireEvent.click(within(panel).getByTestId('trajectory-tab-input'))
    expect(screen.getByTestId('trajectory-payload')).toHaveTextContent('"command": "date"')

    // 结果：原样文本
    fireEvent.click(within(panel).getByTestId('trajectory-tab-output'))
    expect(screen.getByTestId('trajectory-result')).toHaveTextContent('2026-10-13 星期二')

    // 计时：开始 / 结束 / 时长 / 来源
    fireEvent.click(within(panel).getByTestId('trajectory-tab-timing'))
    const timing = screen.getByTestId('trajectory-tab-panel-timing')
    expect(timing).toHaveTextContent('会话时间戳')
    expect(timing).toHaveTextContent('800 毫秒')
  })

  it('复制按钮把原文写进剪贴板', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount()
    await screen.findByTestId('trajectory-ledger')
    fireEvent.click(screen.getByTestId('trajectory-row-2'))
    fireEvent.click(await screen.findByTestId('trajectory-tab-input'))
    fireEvent.click(screen.getByTestId('trajectory-payload-copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{\n  "command": "date"\n}'))
  })

  it('消息行给「概述 / 预览 / 原始内容」，没有参数与结果页', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    fireEvent.click(screen.getByTestId('trajectory-row-0'))

    const panel = await screen.findByTestId('trajectory-details')
    expect(within(panel).getByTestId('trajectory-tab-overview')).toBeInTheDocument()
    expect(within(panel).getByTestId('trajectory-tab-preview')).toBeInTheDocument()
    expect(within(panel).getByTestId('trajectory-tab-raw')).toBeInTheDocument()
    expect(within(panel).queryByTestId('trajectory-tab-input')).not.toBeInTheDocument()

    fireEvent.click(within(panel).getByTestId('trajectory-tab-preview'))
    expect(screen.getByTestId('trajectory-tab-panel-preview')).toHaveTextContent(
      '帮我看看今天有什么新闻'
    )

    fireEvent.click(within(panel).getByTestId('trajectory-tab-raw'))
    expect(screen.getByTestId('trajectory-raw')).toHaveTextContent('"role": "user"')
  })

  it('明细面板常驻且开合有过渡（不是条件渲染硬切）', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    const panel = screen.getByTestId('trajectory-details')
    expect(panel).toHaveClass('transition-[width,opacity]')
    expect(panel).toHaveClass('w-0')
    expect(panel).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(screen.getByTestId('trajectory-row-1'))

    await waitFor(() => expect(panel).toHaveClass('w-[22rem]'))
    expect(panel).not.toHaveAttribute('aria-hidden')
  })

  it('关掉明细面板：选中态一起清掉（时间轴的高亮跟着收）', async () => {
    mount()
    await screen.findByTestId('trajectory-ledger')
    fireEvent.click(screen.getByTestId('trajectory-row-1'))
    await screen.findByTestId('trajectory-details')

    fireEvent.click(screen.getByTestId('trajectory-details-close'))

    await waitFor(() =>
      expect(screen.getByTestId('trajectory-details')).toHaveAttribute('data-open', 'false')
    )
    expect(screen.getByTestId('trajectory-span-1')).not.toHaveAttribute('data-selected')
  })
})

describe('轨迹页 · 导出', () => {
  it('点导出：序列化出 JSON 并交给下载（对话 + 轨迹 + 用量三部分都在里面）', async () => {
    const { click, createObjectURL } = mount()
    await screen.findByTestId('trajectory-ledger')

    fireEvent.click(screen.getByTestId('trajectory-export'))

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    const payload = JSON.parse(await blob.text()) as {
      format: string
      thread: { id: string; title: string | null }
      conversation: { messages: unknown[] }
      trajectory: { rows: unknown[] }
      usage: { runs: unknown[]; totals: { input: number } }
    }

    expect(click).toHaveBeenCalled()
    expect(payload.format).toBe('kyclaw-trajectory')
    expect(payload.thread).toEqual({ id: THREAD_ID, title: '新闻会话' })
    expect(payload.conversation.messages).toHaveLength(MESSAGES.length)
    expect(payload.trajectory.rows.length).toBeGreaterThan(0)
    expect(payload.usage.runs).toHaveLength(1)
    expect(payload.usage.totals.input).toBe(1234)
  })
})

describe('轨迹页 · 取数', () => {
  it('error 态给一行人话 + 重试按钮，点了会重新取数', async () => {
    installKyclawBridge(defaultSettings())
    useSessionsStore.setState({
      threads: [],
      activeId: THREAD_ID,
      loaded: true,
      error: null,
      notices: {}
    })
    vi.mocked(fetchThreadMessages).mockRejectedValue(new Error('线程服务返回 500'))
    vi.mocked(fetchThreadUsageRuns).mockResolvedValue([])
    vi.mocked(fetchThreadCompaction).mockResolvedValue(null)

    render(<TrajectoryView threadId={THREAD_ID} active revision="rev-1" />)

    expect(await screen.findByTestId('trajectory-error')).toHaveTextContent('线程服务返回 500')
    vi.mocked(fetchThreadMessages).mockResolvedValue(MESSAGES)
    fireEvent.click(screen.getByTestId('trajectory-retry'))

    await waitFor(() => expect(screen.getByTestId('trajectory-row-0')).toBeInTheDocument())
  })

  it('没在轨迹页签时不发请求（懒取）', async () => {
    installKyclawBridge(defaultSettings())
    useSessionsStore.setState({
      threads: [],
      activeId: THREAD_ID,
      loaded: true,
      error: null,
      notices: {}
    })
    vi.mocked(fetchThreadMessages).mockResolvedValue(MESSAGES)

    render(<TrajectoryView threadId={THREAD_ID} active={false} revision="rev-1" />)

    // 一次请求都没发；界面是空壳（这一层此时本来就被上级隐藏着）
    expect(vi.mocked(fetchThreadMessages)).not.toHaveBeenCalled()
    expect(screen.getByTestId('trajectory-ledger-empty')).toBeInTheDocument()
  })
})
