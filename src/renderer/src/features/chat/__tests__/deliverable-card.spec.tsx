import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  resetWorkbenchStore,
  useWorkbenchStore
} from '@renderer/features/workbench/workbench-store'
import { defaultSettings } from '@shared/settings'
import { DeliverableCard } from '../DeliverableCard'
import { deliverableOf, type Deliverable } from '../deliverable'
import { Message } from '../Message'
import type { ToolCardPart } from '../parts/tool-part'

/**
 * 交付卡（round 50）：deliver_file 的结果在消息里画成一张卡 —— 图标块 + 文件名 + 副行，
 * 右侧「预览」与 ▾ 菜单（复制路径 / 在文件资源管理器中定位）。
 *
 * 钉住：① 卡的样子（文件名 / 副行 / 两个动作入口）；②「预览」= openPreviewTab(相对路径) + 开右栏
 * （与文件区「在新标签页中查看」同一条路）；③ 菜单两项各走既有通道（剪贴板 / workbench:reveal）；
 * ④ 卡只吃"交付完成"的 part（调用中 / 出错 / 别的工具都不接管，回落普通工具行）；
 * ⑤ Message 把交付卡放在**过程块之外**（过程块这一轮跑完会收起，交付物不该被收进去）。
 */
const THREAD_ID = 'thread-1'
const ROOT = 'D:\\工作区'
const FILE_PATH = 'docs/项目交接文档.md'

interface Bed {
  bridge: KyclawBridgeStubs
  writeText: ReturnType<typeof vi.fn>
}

function setup(options: { workspaces?: Array<{ path: string; mode: 'ask' | 'full' }> } = {}): Bed {
  resetWorkbenchStore()
  const workspaces = options.workspaces ?? [{ path: ROOT, mode: 'ask' as const }]
  const settings = { ...defaultSettings(), workspaces }
  const bridge = installKyclawBridge(settings)
  useSettingsStore.setState({ settings, loaded: true })
  useSessionsStore.setState({ activeId: THREAD_ID, loaded: true })
  useShellStore.setState({ workPanelOpen: false })

  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { bridge, writeText }
}

/** 工具的返回形状（deliver.ts 的 deliverResultSchema） */
function outputOf(extra: Record<string, unknown> = {}): object {
  return {
    path: FILE_PATH,
    name: '项目交接文档.md',
    size: 2048,
    mimeType: 'text/markdown',
    message: '已交付 docs/项目交接文档.md（2048 字节）',
    ...extra
  }
}

function partOf(overrides: Partial<ToolCardPart> = {}): ToolCardPart {
  return {
    toolName: 'deliver_file',
    state: 'output-available',
    input: { path: FILE_PATH },
    output: outputOf(),
    ...overrides
  }
}

/** 卡的直接入参（等价于 Message 从 part 里剥出来的那份） */
function deliverableOfOrThrow(extra: Record<string, unknown> = {}): Deliverable {
  const deliverable = deliverableOf(partOf({ output: outputOf(extra) }))
  if (deliverable === null) throw new Error('这份 part 应该能被认成交付卡')
  return deliverable
}

/** Radix 的 DropdownMenu：键盘 ArrowDown 打开（与本仓其它菜单 spec 同一手法） */
function openMenu(): void {
  fireEvent.keyDown(screen.getByTestId('deliverable-more'), { key: 'ArrowDown' })
}

afterEach(() => {
  clearKyclawBridge()
  resetWorkbenchStore()
})

describe('deliverableOf：只认"交付完成"的 deliver_file', () => {
  it('结果齐：取相对路径 / 文件名 / 字节数 / MIME / 说明', () => {
    expect(deliverableOfOrThrow({ note: '交接材料' })).toEqual({
      path: FILE_PATH,
      name: '项目交接文档.md',
      size: 2048,
      mimeType: 'text/markdown',
      note: '交接材料'
    })
  })

  it('还没结果（调用中）/ 出错 / 别的工具：都不接管（回落普通工具行）', () => {
    expect(deliverableOf(partOf({ state: 'input-available', output: undefined }))).toBeNull()
    expect(deliverableOf(partOf({ state: 'output-error', output: undefined }))).toBeNull()
    expect(deliverableOf(partOf({ toolName: 'read' }))).toBeNull()
  })

  it('结果形状不对（缺 path / 不是对象 / 空串）：回 null，不炸', () => {
    expect(deliverableOf(partOf({ output: { name: 'a.md', size: 1 } }))).toBeNull()
    expect(deliverableOf(partOf({ output: '已交付 docs/a.md' }))).toBeNull()
    expect(deliverableOf(partOf({ output: { path: '', name: 'a.md', size: 1 } }))).toBeNull()
  })

  it('size 缺失按 0；mimeType / note 缺失就不带字段', () => {
    expect(deliverableOf(partOf({ output: { path: 'a.txt', name: 'a.txt' } }))).toEqual({
      path: 'a.txt',
      name: 'a.txt',
      size: 0
    })
  })
})

describe('DeliverableCard：卡的样子与「预览」', () => {
  it('图标块 + 文件名 + 副行（大小），右侧「预览」与 ▾ 菜单', () => {
    setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    expect(screen.getByTestId('deliverable-card')).toHaveAttribute('data-path', FILE_PATH)
    expect(screen.getByTestId('deliverable-name')).toHaveTextContent('项目交接文档.md')
    expect(screen.getByTestId('deliverable-meta')).toHaveTextContent('2.0 KB')
    expect(screen.getByTestId('deliverable-preview')).toHaveTextContent('预览')
    expect(screen.getByTestId('deliverable-more')).toBeInTheDocument()
    // round 56：图标块画的是交付文件类型那张彩色图标（.md → markdown；不再是写死的 FileText）
    expect(
      screen.getByTestId('deliverable-card').querySelector('svg')?.getAttribute('data-file-icon')
    ).toBe('markdown')
    // 零 emoji（雷点 1）
    expect(screen.getByTestId('deliverable-card').textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })

  it('交付说明（note）接在副行里；没有就不显示', () => {
    setup()
    const { unmount } = render(
      <DeliverableCard deliverable={{ path: 'a.md', name: 'a.md', size: 10, note: '来龙去脉' }} />
    )
    expect(screen.getByTestId('deliverable-meta')).toHaveTextContent('10 B · 来龙去脉')

    unmount()
    render(<DeliverableCard deliverable={{ path: 'a.md', name: 'a.md', size: 10 }} />)
    expect(screen.getByTestId('deliverable-meta')).toHaveTextContent('10 B')
  })

  it('点「预览」：按相对路径开预览标签 + 打开右栏（与文件区同一条路）', () => {
    setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    expect(useShellStore.getState().workPanelOpen).toBe(false)
    fireEvent.click(screen.getByTestId('deliverable-preview'))

    const state = useWorkbenchStore.getState()
    const tab = state.tabs.find((candidate) => candidate.kind === 'preview')
    expect(tab?.path).toBe(FILE_PATH)
    expect(state.activeTabId).toBe(tab?.id)
    expect(useShellStore.getState().workPanelOpen).toBe(true)
  })

  it('再点一次同一份文件：不重复开标签，只激活它', () => {
    setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    fireEvent.click(screen.getByTestId('deliverable-preview'))
    fireEvent.click(screen.getByTestId('deliverable-preview'))

    expect(
      useWorkbenchStore.getState().tabs.filter((candidate) => candidate.kind === 'preview')
    ).toHaveLength(1)
  })
})

describe('DeliverableCard：▾ 菜单的两项', () => {
  it('复制路径：给会话根下的绝对路径', async () => {
    const bed = setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-copy-path'))

    await waitFor(() =>
      expect(bed.writeText).toHaveBeenCalledWith('D:\\工作区\\docs\\项目交接文档.md')
    )
  })

  it('会话根判不出（多工作区并列）：复制退回相对路径，「定位」置灰', () => {
    const bed = setup({
      workspaces: [
        { path: 'D:\\工作区', mode: 'ask' },
        { path: 'D:\\另一个', mode: 'ask' }
      ]
    })
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    expect(screen.getByTestId('deliverable-reveal')).toHaveAttribute('data-disabled')

    fireEvent.click(screen.getByTestId('deliverable-copy-path'))
    expect(bed.writeText).toHaveBeenCalledWith(FILE_PATH)
  })

  it('在文件资源管理器中定位：走既有 workbench:reveal（threadId + 相对路径）', async () => {
    const bed = setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-reveal'))

    await waitFor(() =>
      expect(bed.bridge.workbench.reveal).toHaveBeenCalledWith(THREAD_ID, FILE_PATH)
    )
  })
})

describe('Message：交付卡单出（过程块之外）', () => {
  const OUTPUT = {
    path: FILE_PATH,
    name: '项目交接文档.md',
    size: 2048,
    mimeType: 'text/markdown',
    message: '已交付 docs/项目交接文档.md（2048 字节）'
  }

  it('交付卡与过程块平级：卡在 DOM 里，不在「使用 N 个工具」的折叠块里', () => {
    setup()
    render(
      <Message
        message={{
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'text', text: '材料整理好了。' },
            {
              type: 'tool-deliver_file',
              toolCallId: 'call-1',
              state: 'output-available',
              input: { path: FILE_PATH },
              output: OUTPUT
            } as UIMessage['parts'][number]
          ]
        }}
      />
    )

    const card = screen.getByTestId('deliverable-card')
    expect(card.closest('[data-testid="trace-block"]')).toBeNull()
    expect(screen.getByTestId('message-a1')).toContainElement(card)
  })

  it('还在调用中的 deliver_file：走普通工具行（过程块里），不出交付卡', () => {
    setup()
    render(
      <Message
        message={{
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-deliver_file',
              toolCallId: 'call-1',
              state: 'input-available',
              input: { path: FILE_PATH }
            } as UIMessage['parts'][number]
          ]
        }}
      />
    )

    expect(screen.queryByTestId('deliverable-card')).not.toBeInTheDocument()
    const block = screen.getByTestId('trace-block')
    // 过程块里的普通工具行（展开后可见；块这一轮跑完会自动收起）
    fireEvent.click(within(block).getByTestId('trace-toggle'))
    expect(within(block).getByTestId('tool-card')).toHaveAttribute('data-tool', 'deliver_file')
    expect(within(block).getByTestId('tool-state')).toHaveTextContent('已调用')
  })
})
