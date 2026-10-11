import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKBENCH_LOG_LIMIT } from '@shared/ipc'
import type { GitCommit } from '@shared/workbench'
import type { WorkbenchRoot } from '../use-workbench-root'
import { GitTool } from '../GitTool'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/** Git 工具：分支 + 未提交变更 + 提交历史树（monospace 图形列）+ 单击提交的详情层 */
let bed: Bed

function rootOf(): WorkbenchRoot {
  return {
    threadId: 'thread-1',
    rootPath: 'D:\\工作区',
    rootName: '工作区',
    ready: true,
    notice: null,
    workbench: bed.bridge.workbench,
    terminal: bed.bridge.terminal
  }
}

function commit(overrides: Partial<GitCommit>): GitCommit {
  return {
    sha: 'a'.repeat(40),
    short: 'aaaaaaa',
    graph: '* ',
    refs: 'HEAD -> main',
    subject: '第一个提交',
    author: '张三',
    date: '2026-10-11T10:00:00+08:00',
    ...overrides
  }
}

beforeEach(() => {
  bed = setupWorkbench()
  bed.bridge.workbench.gitOverview.mockResolvedValue({
    isRepo: true,
    empty: false,
    branch: 'main',
    changes: [
      { path: 'src/a.ts', status: 'modified', staged: false },
      { path: 'b.md', status: 'added', staged: true },
      { path: 'c.txt', status: 'untracked', staged: false }
    ]
  })
  bed.bridge.workbench.gitLog.mockResolvedValue({ commits: [commit({})] })
})

afterEach(() => {
  teardownWorkbench()
})

describe('GitTool：总览与历史', () => {
  it('分支、变更的中文标签与"已暂存"标记、历史行的图形列与 refs', async () => {
    render(<GitTool root={rootOf()} />)

    await waitFor(() => expect(screen.getByTestId('git-branch')).toHaveTextContent('main'))
    expect(bed.bridge.workbench.gitLog).toHaveBeenCalledWith('thread-1', WORKBENCH_LOG_LIMIT)

    const changes = screen.getAllByTestId('git-change')
    expect(changes).toHaveLength(3)
    expect(changes[0]).toHaveTextContent('已修改')
    expect(changes[0]).toHaveTextContent('src/a.ts')
    expect(changes[1]).toHaveTextContent('已新增')
    expect(changes[1]).toHaveTextContent('已暂存')
    expect(changes[2]).toHaveTextContent('未跟踪')

    const row = screen.getByTestId('git-commit')
    // 图形列原样保留（monospace 画树；testing-library 的文本匹配会把尾空格归一化，这里直接看 textContent）
    expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe('* ')
    expect(within(row).getByText('aaaaaaa')).toBeInTheDocument()
    expect(within(row).getByText('HEAD -> main')).toBeInTheDocument()
    expect(within(row).getByText('第一个提交')).toBeInTheDocument()
  })

  it('干净的工作区 / 空仓库 / 不是仓库：三种明确形态', async () => {
    bed.bridge.workbench.gitOverview.mockResolvedValue({
      isRepo: true,
      empty: false,
      branch: 'main',
      changes: []
    })
    const { unmount } = render(<GitTool root={rootOf()} />)
    expect(await screen.findByTestId('git-clean')).toHaveTextContent('工作区是干净的')
    unmount()

    bed.bridge.workbench.gitOverview.mockResolvedValue({
      isRepo: true,
      empty: true,
      branch: 'main',
      changes: []
    })
    const second = render(<GitTool root={rootOf()} />)
    expect(await screen.findByTestId('git-empty-repo')).toHaveTextContent('还没有提交')
    second.unmount()

    bed.bridge.workbench.gitOverview.mockResolvedValue({
      isRepo: false,
      empty: false,
      branch: null,
      changes: []
    })
    render(<GitTool root={rootOf()} />)
    expect(await screen.findByTestId('git-not-repo')).toHaveTextContent('这不是一个 git 仓库')
  })

  it('总览失败：把主进程的人话露出来', async () => {
    bed.bridge.workbench.gitOverview.mockRejectedValue(new Error('找不到 git 可执行文件'))
    render(<GitTool root={rootOf()} />)

    expect(await screen.findByTestId('git-error')).toHaveTextContent('找不到 git 可执行文件')
  })

  it('历史读失败：变更照常显示，历史那一节给人话', async () => {
    bed.bridge.workbench.gitLog.mockRejectedValue(new Error('读不了提交历史'))
    render(<GitTool root={rootOf()} />)

    expect(await screen.findByTestId('git-log-error')).toHaveTextContent('读不了提交历史')
    expect(screen.getAllByTestId('git-change')).toHaveLength(3)
  })

  it('刷新按钮重新拉总览与历史', async () => {
    render(<GitTool root={rootOf()} />)
    await waitFor(() => expect(bed.bridge.workbench.gitOverview).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('git-refresh'))
    await waitFor(() => expect(bed.bridge.workbench.gitOverview).toHaveBeenCalledTimes(2))
    expect(bed.bridge.workbench.gitLog).toHaveBeenCalledTimes(2)
  })
})

describe('GitTool：提交详情', () => {
  it('单击提交 → 详情层：作者/时间/完整 message + 变更文件统计', async () => {
    bed.bridge.workbench.gitShow.mockResolvedValue({
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      author: '张三',
      email: 'z@example.com',
      date: '2026-10-11T10:00:00+08:00',
      message: '第一个提交\n\n正文说明',
      files: [
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: 'logo.png', additions: null, deletions: null }
      ]
    })
    render(<GitTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByTestId('git-commit')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('git-commit'))

    await waitFor(() =>
      expect(bed.bridge.workbench.gitShow).toHaveBeenCalledWith('thread-1', 'a'.repeat(40))
    )
    const body = await screen.findByTestId('git-commit-body')
    expect(within(body).getByText('张三')).toBeInTheDocument()
    expect(within(body).getByText(/第一个提交/)).toBeInTheDocument()
    expect(within(body).getByText('+3 −1')).toBeInTheDocument()
    expect(within(body).getByText('二进制')).toBeInTheDocument()
  })

  it('详情读失败：层里给人话；关掉层的按钮在', async () => {
    bed.bridge.workbench.gitShow.mockRejectedValue(new Error('看不了这条提交：fatal: bad revision'))
    render(<GitTool root={rootOf()} />)
    await waitFor(() => expect(screen.getByTestId('git-commit')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('git-commit'))
    expect(await screen.findByTestId('git-commit-error')).toHaveTextContent('fatal: bad revision')

    const sheet = screen.getByTestId('git-commit-detail')
    fireEvent.click(within(sheet).getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('git-commit-detail')).not.toBeInTheDocument()
  })
})
