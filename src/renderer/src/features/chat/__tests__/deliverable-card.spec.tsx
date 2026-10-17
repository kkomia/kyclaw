import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import { resetOfficeOpenState } from '@renderer/features/workbench/office-open'
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
  resetOfficeTabsStore()
  resetOfficeOpenState()
  window.location.hash = ''
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

  it('会话根判不出（多工作区并列）：复制退回相对路径，「定位」与「用本地应用打开」置灰', () => {
    const bed = setup({
      workspaces: [
        { path: 'D:\\工作区', mode: 'ask' },
        { path: 'D:\\另一个', mode: 'ask' }
      ]
    })
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    expect(screen.getByTestId('deliverable-reveal')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('deliverable-open')).toHaveAttribute('data-disabled')

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

  it('定位失败也不再静默：把主进程的人话露在卡下面（原先只写 console）', async () => {
    const bed = setup()
    bed.bridge.workbench.reveal.mockRejectedValue(new Error('打不开这个文件夹：拒绝访问'))
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-reveal'))

    expect(await screen.findByTestId('deliverable-action-error')).toHaveTextContent(
      '打不开这个文件夹：拒绝访问'
    )
  })
})

/* round 77：交付物交回用户本机装的那件应用（Word / WPS / Excel）—— workbench:open */
describe('DeliverableCard：「用本地应用打开」', () => {
  it('菜单里有这一项，点了走 workbench:open（threadId + 相对路径，绝对路径只在主进程）', async () => {
    const bed = setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    const item = screen.getByTestId('deliverable-open')
    expect(item).toHaveTextContent('用本地应用打开')

    fireEvent.click(item)

    await waitFor(() =>
      expect(bed.bridge.workbench.open).toHaveBeenCalledWith(THREAD_ID, FILE_PATH)
    )
    // 失败才露错误行；成功时一个字都不多说
    expect(screen.queryByTestId('deliverable-action-error')).not.toBeInTheDocument()
  })

  it('打不开（没装能开这种文件的应用 / 文件被删）：把主进程的人话露在卡下面，不假装打开', async () => {
    const bed = setup()
    bed.bridge.workbench.open.mockRejectedValue(
      new Error(
        "Error invoking remote method 'workbench:open': Error: 打不开这个文件（系统没能用默认应用打开它）：没有与此文件关联的应用"
      )
    )
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open'))

    const alert = await screen.findByTestId('deliverable-action-error')
    expect(alert).toHaveAttribute('role', 'alert')
    // 剥掉 Electron 的包装层，用户看到的是主进程那句人话
    expect(alert).toHaveTextContent('打不开这个文件（系统没能用默认应用打开它）')
    expect(alert).not.toHaveTextContent('Error invoking remote method')
  })

  it('失败之后再点一次成功：错误行收回去（不留一条早就不成立的报错）', async () => {
    const bed = setup()
    bed.bridge.workbench.open.mockRejectedValueOnce(new Error('打不开这个文件'))
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open'))
    await screen.findByTestId('deliverable-action-error')

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open'))
    await waitFor(() =>
      expect(screen.queryByTestId('deliverable-action-error')).not.toBeInTheDocument()
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

/* M3-S4：docx 交付物 →「在 Office 标签页中打开」（与文件树共用 workbench/office-open 的同一份逻辑） */
describe('DeliverableCard：在 Office 标签页中打开（M3-S4）', () => {
  const DOCX_PATH = 'docs/方案.docx'

  function docxDeliverable(): Deliverable {
    return deliverableOfOrThrow({
      path: DOCX_PATH,
      name: '方案.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    })
  }

  function stubOpenSuccess(bridge: KyclawBridgeStubs): void {
    bridge.office.openFromSession.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({
        displayPath: DOCX_PATH,
        absolutePath: 'D:\\工作区\\docs\\方案.docx'
      }),
      alreadyOpen: false
    })
  }

  it('菜单只为 .docx 出「在 Office 标签页中打开」；非 docx 交付物没有这一项（不给假入口）', () => {
    setup()
    render(<DeliverableCard deliverable={deliverableOfOrThrow()} />)

    openMenu()
    expect(screen.queryByTestId('deliverable-open-office')).not.toBeInTheDocument()
  })

  it('点了：openFromSession(threadId, 相对路径) → 标签落位并切 /office；不复制聊天状态', async () => {
    const bed = setup()
    stubOpenSuccess(bed.bridge)
    render(<DeliverableCard deliverable={docxDeliverable()} />)

    openMenu()
    const item = screen.getByTestId('deliverable-open-office')
    expect(item).toHaveTextContent('在 Office 标签页中打开')

    fireEvent.click(item)

    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(1))
    expect(bed.bridge.office.openFromSession).toHaveBeenCalledWith(THREAD_ID, DOCX_PATH)
    const tab = useOfficeTabsStore.getState().tabs[0]
    expect(tab).toMatchObject({
      documentId: 'doc-1',
      title: '方案.docx',
      path: DOCX_PATH,
      kind: 'docx'
    })
    expect(useOfficeTabsStore.getState().activeTabId).toBe(tab?.id)
    await waitFor(() => expect(window.location.hash).toBe('#/office'))

    // 只跳转不复制聊天状态：不开右栏预览标签、不开面板、成功不露错误
    expect(
      useWorkbenchStore.getState().tabs.filter((candidate) => candidate.kind === 'preview')
    ).toHaveLength(0)
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(screen.queryByTestId('deliverable-action-error')).not.toBeInTheDocument()
  })

  it('同一份文件点两次：只开一个标签（按 documentId 去重，第二次只激活）', async () => {
    const bed = setup()
    stubOpenSuccess(bed.bridge)
    render(<DeliverableCard deliverable={docxDeliverable()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open-office'))
    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(1))
    const firstId = useOfficeTabsStore.getState().tabs[0]?.id

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open-office'))

    await waitFor(() => expect(bed.bridge.office.openFromSession).toHaveBeenCalledTimes(2))
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(firstId)
  })

  it('失败（文件没了 / 不是 docx / 未授权）：卡下面给主进程的人话；标签不落、不跳转', async () => {
    const bed = setup()
    bed.bridge.office.openFromSession.mockResolvedValue({
      ok: false,
      code: 'unreadable',
      message: '读不了这个文件：它可能已损坏、无权限，或不是普通文件'
    })
    render(<DeliverableCard deliverable={docxDeliverable()} />)

    openMenu()
    fireEvent.click(screen.getByTestId('deliverable-open-office'))

    const alert = await screen.findByTestId('deliverable-action-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('读不了这个文件')
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
    expect(window.location.hash).not.toBe('#/office')
  })

  it('会话根判不出（多工作区并列）也照样能开：Office 只依赖 threadId，rootPath 不是门槛', async () => {
    const bed = setup({
      workspaces: [
        { path: 'D:\\工作区', mode: 'ask' },
        { path: 'D:\\另一个', mode: 'ask' }
      ]
    })
    stubOpenSuccess(bed.bridge)
    render(<DeliverableCard deliverable={docxDeliverable()} />)

    openMenu()
    const item = screen.getByTestId('deliverable-open-office')
    // 与「定位 / 用本地应用打开」不同：这一项不因 rootPath 判不出而置灰
    expect(item).not.toHaveAttribute('data-disabled')

    fireEvent.click(item)

    await waitFor(() => expect(useOfficeTabsStore.getState().tabs).toHaveLength(1))
    await waitFor(() => expect(window.location.hash).toBe('#/office'))
  })
})
