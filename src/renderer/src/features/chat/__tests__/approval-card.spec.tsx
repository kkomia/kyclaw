import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type McpServerConfig, type Workspace } from '@shared/settings'
import { ApprovalCard, type ApprovalDecision } from '../ApprovalCard'
import type { ApprovalRequest } from '../approval'

/**
 * 审批卡（T13，RTL）：四个决策按钮各自 dispatch 正确的决策；diff 预览按行标注增删；
 * "永久允许"只在判得出工作区时出现。
 * round 14：MCP 工具的标题显示「服务名 · 工具名」（与 ToolCard 同一口径）。
 * round28：bash 显示要执行的命令、fetch 显示 URL、move 显示目标位置；bash 按 cwd / fetch 按
 * save_to 判工作区（记忆入口能造出来）。
 * round 76（用户口径"允许就是永久允许"）：delete / move 与其它写类**同一套入口** ——
 * 只要工作区判得出、目标没踩区外，卡上就有「本会话允许 / 永久允许」。
 */
const WS: Workspace = { path: 'D:\\项目\\demo', mode: 'ask' }
const WS2: Workspace = { path: 'E:\\另一个', mode: 'ask' }

function mcpServer(): McpServerConfig {
  return {
    id: 'mcp-1',
    name: '知识库',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    enabled: true,
    readOnlyTools: []
  }
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'run-1::call-1',
    toolCallId: 'call-1',
    toolName: 'write',
    input: { path: 'a.txt', content: '第一行\n第二行' },
    path: 'a.txt',
    ...overrides
  }
}

function decideWith(
  overrides: Partial<ApprovalRequest> = {},
  workspaces: Workspace[] = [WS]
): { onDecide: ReturnType<typeof vi.fn<(decision: ApprovalDecision) => void>> } {
  const onDecide = vi.fn<(decision: ApprovalDecision) => void>()
  render(<ApprovalCard request={request(overrides)} workspaces={workspaces} onDecide={onDecide} />)
  return { onDecide }
}

describe('ApprovalCard · 内容', () => {
  it('工具名、目标路径、等待审批签都在（与工具卡同一族形状）', () => {
    decideWith()

    const card = screen.getByTestId('approval-card')
    expect(card).toHaveAttribute('data-tool', 'write')
    expect(card).toHaveAttribute('data-workspace', WS.path)
    expect(card).toHaveTextContent('写入文件')
    expect(card).toHaveTextContent('等待审批')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
  })

  it('write：内容按新增行预览（+ 行、DiffAdd 取色）', () => {
    decideWith()

    const lines = screen.getAllByTestId('approval-diff-line')
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['add', 'add'])
    expect(lines[0]).toHaveTextContent('+')
    expect(lines[0]).toHaveTextContent('第一行')
    expect(lines[0].className).toContain('text-diff-add')
  })

  it('edit：行级 diff 标出删除与新增两色', () => {
    decideWith({
      toolName: 'edit',
      input: { path: 'a.txt', oldText: '旧的一行', newText: '新的一行' }
    })

    const lines = screen.getAllByTestId('approval-diff-line')
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['remove', 'add'])
    expect(lines[0].className).toContain('text-diff-delete')
    expect(lines[1].className).toContain('text-diff-add')
  })

  it('认不出的工具：没有 diff 区，只给可见信息（不猜）', () => {
    decideWith({ toolName: 'mcp__x__do', input: { anything: 1 }, path: null })

    expect(screen.getByTestId('approval-card')).toHaveTextContent('mcp__x__do')
    expect(screen.queryByTestId('approval-diff')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-target')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-detail')).not.toBeInTheDocument()
  })

  it('模块 4 产出物：中文标签 + 目标路径，没有 diff 区（不是文本改写，没有行级差异）', () => {
    decideWith({
      toolName: 'create_report',
      input: { title: '季度复盘', html: '<h2>结论</h2>', path: 'reports/q3.html' },
      path: 'reports/q3.html'
    })

    const card = screen.getByTestId('approval-card')
    expect(card).toHaveAttribute('data-tool', 'create_report')
    expect(card).toHaveTextContent('生成报告')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('reports/q3.html')
    expect(screen.queryByTestId('approval-diff')).not.toBeInTheDocument()
  })

  it('模块 4 产出物：没给 path 时（按标题派生文件名）卡片不炸，只显示已有信息', () => {
    decideWith({
      toolName: 'create_pdf',
      input: { title: '季度复盘', html: '<p>x</p>' },
      path: null
    })

    const card = screen.getByTestId('approval-card')
    expect(card).toHaveTextContent('导出 PDF')
    expect(screen.queryByTestId('approval-target')).not.toBeInTheDocument()
  })
})

describe('ApprovalCard · 四决策', () => {
  it('允许一次 / 本会话允许 / 永久允许 / 拒绝各自 dispatch 对应决策', () => {
    const { onDecide } = decideWith()

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    expect(onDecide).toHaveBeenLastCalledWith('once')

    fireEvent.click(screen.getByTestId('approval-allow-session'))
    expect(onDecide).toHaveBeenLastCalledWith('session')

    fireEvent.click(screen.getByTestId('approval-allow-forever'))
    expect(onDecide).toHaveBeenLastCalledWith('forever')

    fireEvent.click(screen.getByTestId('approval-deny'))
    expect(onDecide).toHaveBeenLastCalledWith('deny')

    expect(onDecide).toHaveBeenCalledTimes(4)
  })

  it('判不出工作区（没有 path 的写类工具）：只给允许一次与拒绝，不给记忆入口', () => {
    decideWith({ toolName: 'mcp__x__do', input: { anything: 1 }, path: null })

    expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()
    expect(screen.getByTestId('approval-deny')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-session')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('路径判不出工作区（不在授权列表里）：同样不给记忆入口', () => {
    decideWith({
      input: { path: 'C:\\Windows\\evil.txt', content: 'x' },
      path: 'C:\\Windows\\evil.txt'
    })

    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', '')
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('MCP 工具：标题显示「服务名 · 工具名」（round 14，与 ToolCard 同一口径）', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), mcpServers: [mcpServer()] },
      loaded: true
    })
    try {
      render(
        <ApprovalCard
          request={request({ toolName: 'mcp__mcp-1__search', input: { query: 'x' } })}
          workspaces={[WS]}
          onDecide={vi.fn()}
        />
      )

      const card = screen.getByTestId('approval-card')
      expect(card).toHaveTextContent('知识库 · search')
      expect(card).not.toHaveTextContent('mcp__mcp-1__search')
      // 内部名仍留在 data 属性里（身份不丢，只是换个显示）
      expect(card).toHaveAttribute('data-tool', 'mcp__mcp-1__search')
    } finally {
      useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    }
  })
})

describe('ApprovalCard · 看得见在批什么（round28）', () => {
  it('bash：命令原样展示（多行不丢）；cwd 判出工作区 → 记忆入口在（出口真能造出来）', () => {
    decideWith({
      toolName: 'bash',
      input: { command: 'pnpm test\n  --watch=false', cwd: 'D:\\项目\\demo' },
      path: 'D:\\项目\\demo'
    })

    const detail = screen.getByTestId('approval-detail')
    expect(detail).toHaveAttribute('data-kind', 'command')
    expect(detail).toHaveTextContent('pnpm test')
    expect(detail).toHaveTextContent('--watch=false')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('D:\\项目\\demo')
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', WS.path)
    expect(screen.getByTestId('approval-allow-session')).toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('bash 没给 cwd 且授权列表恰好一条：仍给记忆入口（与服务端 guard 同口径）', () => {
    decideWith({ toolName: 'bash', input: { command: 'echo hi' }, path: null }, [WS])

    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('bash 没给 cwd 且多个工作区：判不出目标，只给允许一次 / 拒绝', () => {
    decideWith({ toolName: 'bash', input: { command: 'echo hi' }, path: null }, [WS, WS2])

    expect(screen.getByTestId('approval-detail')).toHaveAttribute('data-kind', 'command')
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', '')
    expect(screen.queryByTestId('approval-allow-session')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('bash 的 cwd 在工作区之外（可跑但要每次问）：给命令、判不出工作区、不给记忆入口', () => {
    decideWith({
      toolName: 'bash',
      input: { command: 'git log', cwd: 'C:\\别的目录' },
      path: 'C:\\别的目录'
    })

    expect(screen.getByTestId('approval-detail')).toHaveTextContent('git log')
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('fetch：URL 展示；save_to 判出工作区 → 记忆入口在', () => {
    decideWith({
      toolName: 'fetch',
      input: { url: 'https://example.com/api?q=1', save_to: 'D:\\项目\\demo\\out.bin' },
      path: 'D:\\项目\\demo\\out.bin'
    })

    const detail = screen.getByTestId('approval-detail')
    expect(detail).toHaveAttribute('data-kind', 'url')
    expect(detail).toHaveTextContent('https://example.com/api?q=1')
    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('fetch 没给 save_to：单工作区兜底给记忆入口（多工作区不给，已由 approval.spec 钉死）', () => {
    decideWith({ toolName: 'fetch', input: { url: 'https://example.com' }, path: null }, [WS])

    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('move：展示目标位置（→ 前缀，与目标路径区分）', () => {
    decideWith({
      toolName: 'move',
      input: { path: 'a.txt', to: 'docs/a.txt' },
      path: 'a.txt'
    })

    const detail = screen.getByTestId('approval-detail')
    expect(detail).toHaveAttribute('data-kind', 'move-to')
    expect(detail).toHaveTextContent('→ docs/a.txt')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
  })
})

/**
 * round 86（用户实报 013 的后半）：审批卡的**目标路径**也收成工作区相对路径 —— 上一轮只改了工具卡，
 * 审批卡上那条整条绝对路径同样太长。口径与工具卡一字不差（同一份 `display-path.ts`、同一份会话根
 * `sessionRootPathOf`）：根内 → 相对；根外 / 判不出根 → 原样。
 * **绝对路径不丢**：那一行的 tooltip 里始终是原文 —— 审批卡的决策面就是"到底动哪个文件"。
 */
describe('round 86 · 审批卡的目标路径显示（根内相对、绝对路径在 tooltip 里）', () => {
  const ROOT = 'D:\\ws'

  function withRoot(): void {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        workspaces: [{ path: ROOT, mode: 'ask' }],
        defaultWorkspace: ROOT
      },
      loaded: true
    })
    // 没有会话（activeId null）时真根就是默认工作区本身 —— 这里量的是展示转换（工具卡同一手法）
    useSessionsStore.setState({ activeId: null })
  }

  function restore(): void {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    useSessionsStore.setState({ activeId: null })
  }

  /** focus 唤出 Radix 的 Tooltip，取出它的原文（键盘可达，与应用内其它 tooltip 同一读法） */
  async function tooltipTextOf(target: HTMLElement): Promise<string> {
    fireEvent.focus(target)
    let text = ''
    await waitFor(() => {
      const describedBy = target.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      text = document.getElementById(describedBy ?? '')?.textContent ?? ''
      expect(text).not.toBe('')
    })
    return text
  }

  it('根内文件：卡面是相对路径，tooltip 里是绝对路径原文（决策面不丢）', async () => {
    withRoot()
    try {
      decideWith({
        toolName: 'write',
        input: { path: 'D:\\ws\\src\\a.txt', content: 'x' },
        path: 'D:\\ws\\src\\a.txt'
      })

      const target = screen.getByTestId('approval-target')
      expect(target).toHaveTextContent('src/a.txt')
      expect(target).not.toHaveTextContent('D:\\ws')
      expect(await tooltipTextOf(target)).toBe('D:\\ws\\src\\a.txt')
    } finally {
      restore()
    }
  })

  it('根外文件：原样显示绝对路径（不改写、也不假装它在工作区里）', async () => {
    withRoot()
    try {
      decideWith({
        toolName: 'write',
        input: { path: 'C:\\Windows\\evil.txt', content: 'x' },
        path: 'C:\\Windows\\evil.txt'
      })

      const target = screen.getByTestId('approval-target')
      expect(target).toHaveTextContent('C:\\Windows\\evil.txt')
      expect(await tooltipTextOf(target)).toBe('C:\\Windows\\evil.txt')
    } finally {
      restore()
    }
  })

  it('判不出根（没有工作区）：交出来的绝对路径照原样显示，不硬凑相对路径', async () => {
    useSessionsStore.setState({ activeId: null })
    decideWith({
      toolName: 'write',
      input: { path: 'D:\\ws\\docs\\a.md', content: 'x' },
      path: 'D:\\ws\\docs\\a.md'
    })

    expect(screen.getByTestId('approval-target')).toHaveTextContent('D:\\ws\\docs\\a.md')
  })

  it('bash 的 cwd 目标（同一个显示口径，不挑工具名）：根内 → 相对', async () => {
    withRoot()
    try {
      decideWith({
        toolName: 'bash',
        input: { command: 'git status', cwd: 'D:\\ws\\sub' },
        path: 'D:\\ws\\sub'
      })

      expect(screen.getByTestId('approval-target')).toHaveTextContent('sub')
      // bash 的命令体是另一件事（approval-detail），一个字符不改
      expect(screen.getByTestId('approval-detail')).toHaveTextContent('git status')
    } finally {
      restore()
    }
  })

  it('对照组：没有目标路径（path: null）时什么都不铺（入口条件没动）', () => {
    decideWith({ toolName: 'mcp__x__do', input: { anything: 1 }, path: null })

    expect(screen.queryByTestId('approval-target')).not.toBeInTheDocument()
  })
})

describe('ApprovalCard · 破坏性工具的决策入口（round 76：允许就是永久允许）', () => {
  it('delete / move（含 MCP 末段命中）：与其它写类同一套入口（工作区判得出、没踩区外就给）', () => {
    for (const toolName of ['delete', 'move', 'mcp__x__delete']) {
      const view = render(
        <ApprovalCard
          request={request({
            toolName,
            input: { path: 'D:\\项目\\demo\\a.txt' },
            path: 'D:\\项目\\demo\\a.txt'
          })}
          workspaces={[WS]}
          onDecide={vi.fn()}
        />
      )

      expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', WS.path)
      expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()
      expect(screen.getByTestId('approval-allow-session')).toBeInTheDocument()
      expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
      expect(screen.getByTestId('approval-scope')).toHaveTextContent(
        '点击永久允许后，此工具在当前工作区内的后续操作不再逐次询问；仅放行此工具'
      )
      expect(screen.getByTestId('approval-scope')).toHaveTextContent('工作区之外仍按区外权限处理')
      expect(screen.getByTestId('approval-deny')).toBeInTheDocument()
      view.unmount()
    }
  })

  it('风险提示照旧：move 的目标位置 + "为什么这次要问你"那一行都在（入口多两个，不多不少）', () => {
    decideWith({
      toolName: 'move',
      input: { path: 'D:\\项目\\demo\\a.txt', to: 'docs/a.txt' },
      path: 'D:\\项目\\demo\\a.txt'
    })

    expect(screen.getByTestId('approval-detail')).toHaveAttribute('data-kind', 'move-to')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('D:\\项目\\demo\\a.txt')
    expect(screen.getByTestId('approval-scope')).toHaveTextContent('每次询问')
  })

  it('对照组：普通写类工具的入口一字不变（回归护栏）', () => {
    decideWith({
      toolName: 'write',
      input: { path: 'D:\\项目\\demo\\a.txt', content: 'x' },
      path: 'D:\\项目\\demo\\a.txt'
    })

    expect(screen.getByTestId('approval-allow-session')).toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('对照组：判不出工作区时照旧只有允许一次 / 拒绝（入口条件里那条没动）', () => {
    decideWith({ toolName: 'delete', input: { anything: 1 }, path: null })

    expect(screen.queryByTestId('approval-scope')).not.toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()
    expect(screen.getByTestId('approval-deny')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-session')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })
})

describe('ApprovalCard · 为什么这次要问你（round 75）', () => {
  it('区内的 ask 档：写明"这一档是每次询问"+ 去哪儿改（记忆入口照旧）', () => {
    decideWith({
      toolName: 'bash',
      input: { command: 'rm -rf build', cwd: 'D:\\项目\\demo' },
      path: 'D:\\项目\\demo'
    })

    const scope = screen.getByTestId('approval-scope')
    expect(scope).toHaveAttribute('data-kind', 'workspace-ask')
    expect(scope).toHaveTextContent('每次询问')
    expect(scope).toHaveTextContent('设置 → 工作区')
    // 区内命令：工作区判得出来 → 记忆入口在（递归删除不再"永远问"）
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', WS.path)
    expect(screen.getByTestId('approval-allow-session')).toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
  })

  it('工作区之外的删除目标：说清按「工作区之外」那一档，并且不给记忆入口', () => {
    decideWith({
      toolName: 'bash',
      input: { command: 'rm -f "E:\\别的地方\\a.txt"', cwd: 'D:\\项目\\demo' },
      path: 'D:\\项目\\demo'
    })

    const scope = screen.getByTestId('approval-scope')
    expect(scope).toHaveAttribute('data-kind', 'outside-workspace')
    expect(scope).toHaveTextContent('授权工作区之外')
    expect(scope).toHaveTextContent('「工作区之外」那一档')
    // 区外的目标绑不上某个工作区 → 不给记忆入口（点了也造不出生效的规则）
    expect(screen.queryByTestId('approval-allow-session')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('落不到工作区里的形态（磁盘级）：说清按区外那一档', () => {
    decideWith({
      toolName: 'bash',
      input: { command: 'diskpart', cwd: 'D:\\项目\\demo' },
      path: 'D:\\项目\\demo'
    })

    expect(screen.getByTestId('approval-scope')).toHaveAttribute('data-kind', 'disk-destructive')
  })

  it('对照组：普通命令 + full 工作区判得出但与解释无关时不写提示（宁缺勿错）', () => {
    decideWith({ toolName: 'write', input: { path: 'D:\\项目\\demo\\a.txt', content: 'x' } }, [
      { path: 'D:\\项目\\demo', mode: 'full' }
    ])

    expect(screen.queryByTestId('approval-scope')).not.toBeInTheDocument()
  })
})
