/**
 * 「Git」工具：当前分支 + 工作区未提交变更 + 提交历史树（`git log --graph` 的结构化渲染）。
 * 单击一条提交 → 底部详情（作者/时间/完整 message + 变更文件统计）。
 *
 * 数据全部来自主进程（`workbench:git-*`，在会话根里跑 git，不加依赖）：这里只做展示与解析结果的
 * 分组。非仓库 / 空仓库是**明确的空态**（不是错误）：git 那边用 isRepo / empty 表达。
 * 历史上限 200（与主进程的 WORKBENCH_LOG_LIMIT 一致）。
 */
import { GitBranch, History } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { WORKBENCH_LOG_LIMIT } from '@shared/ipc'
import type { GitCommit, GitCommitDetail, GitOverview } from '@shared/workbench'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/spinner'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { BottomSheet, RefreshButton, SectionLabel, ToolBar, ToolEmpty, ToolError } from './bits'
import {
  formatDateTime,
  formatLineStat,
  GIT_STATUS_LABEL,
  GIT_STATUS_TONE,
  refTone,
  splitRefs
} from './format'
import type { WorkbenchRoot } from './use-workbench-root'

interface OverviewState {
  status: 'loading' | 'ready' | 'error'
  value?: GitOverview
  error?: string
}

interface DetailState {
  status: 'loading' | 'ready' | 'error'
  value?: GitCommitDetail
  error?: string
}

export function GitTool({ root }: { root: WorkbenchRoot }): React.JSX.Element {
  const { threadId, ready, notice, workbench } = root
  // 初始就是"加载中"：挂载那次拉数据因此不用在 effect 里同步 setState（级联渲染）
  const [overview, setOverview] = useState<OverviewState>({ status: 'loading' })
  const [commits, setCommits] = useState<readonly GitCommit[]>([])
  const [logError, setLogError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ sha: string; state: DetailState } | null>(null)

  /**
   * 只拉数据、**不碰加载态**：挂载时走它（初始状态本来就在"加载中"，再 setState 一遍
   * 既是多余的、也会变成 effect 里的同步 setState）。
   * 换会话由 Workbench 用 key 重挂本组件（状态自然清空），所以不用代次防串台。
   */
  const fetchAll = useCallback((): void => {
    if (workbench === null || threadId === null) return
    void workbench.gitOverview(threadId).then(
      (value) => setOverview({ status: 'ready', value }),
      (error: unknown) => setOverview({ status: 'error', error: unwrapIpcError(error) })
    )
    void workbench.gitLog(threadId, WORKBENCH_LOG_LIMIT).then(
      (result) => setCommits(result.commits),
      (error: unknown) => {
        setCommits([])
        setLogError(unwrapIpcError(error))
      }
    )
  }, [threadId, workbench])

  useEffect(() => {
    if (ready) fetchAll()
  }, [ready, fetchAll])

  /** 用户点刷新：先回到"加载中"（用户主动动作，同步置位没问题），再拉 */
  const refresh = useCallback((): void => {
    setOverview({ status: 'loading' })
    setLogError(null)
    setSelected(null)
    fetchAll()
  }, [fetchAll])

  const openCommit = useCallback(
    (sha: string): void => {
      if (workbench === null || threadId === null) return
      setSelected({ sha, state: { status: 'loading' } })
      void workbench.gitShow(threadId, sha).then(
        (value) => setSelected({ sha, state: { status: 'ready', value } }),
        (error: unknown) =>
          setSelected({ sha, state: { status: 'error', error: unwrapIpcError(error) } })
      )
    },
    [threadId, workbench]
  )

  const repo = overview.status === 'ready' ? overview.value : undefined

  if (!ready) {
    return <ToolEmpty testId="git-notice" icon={GitBranch} title={notice ?? 'Git 不可用'} />
  }

  return (
    <div data-testid="git-tool" className="flex min-h-0 flex-1 flex-col">
      <ToolBar className="justify-between">
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <GitBranch aria-hidden="true" className="size-(--icon-size-sm) text-ink-secondary" />
          <span data-testid="git-branch" className="truncate text-b2 text-ink">
            {repo?.branch ?? '—'}
          </span>
        </span>
        <RefreshButton label="刷新仓库状态" testId="git-refresh" onClick={refresh} />
      </ToolBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {overview.status === 'loading' ? (
          <div className="flex justify-center py-3">
            <Spinner label="加载中" className="text-ink-tertiary" />
          </div>
        ) : overview.status === 'error' ? (
          <ToolError testId="git-error" message={overview.error ?? '读不了仓库状态'} />
        ) : repo === undefined || !repo.isRepo ? (
          <ToolEmpty testId="git-not-repo" icon={GitBranch} title="这不是一个 git 仓库" />
        ) : (
          <>
            <SectionLabel>未提交的变更</SectionLabel>
            {repo.changes.length === 0 ? (
              <p data-testid="git-clean" className="px-3 py-1 text-b2 text-ink-tertiary">
                工作区是干净的
              </p>
            ) : (
              repo.changes.map((change) => (
                <div
                  key={`${change.status}:${change.path}`}
                  data-testid="git-change"
                  className="flex h-8 items-center gap-2 px-3"
                >
                  <span className={cn('shrink-0 text-c1', GIT_STATUS_TONE[change.status])}>
                    {GIT_STATUS_LABEL[change.status]}
                  </span>
                  {change.staged ? (
                    <span className="shrink-0 text-c1 text-ink-tertiary">已暂存</span>
                  ) : null}
                  <span className="min-w-0 truncate text-b2 text-ink" title={change.path}>
                    {change.path}
                  </span>
                </div>
              ))
            )}

            <SectionLabel>提交历史</SectionLabel>
            {logError === null ? null : <ToolError testId="git-log-error" message={logError} />}
            {repo.empty ? (
              <p data-testid="git-empty-repo" className="px-3 py-1 text-b2 text-ink-tertiary">
                这个仓库还没有提交
              </p>
            ) : commits.length === 0 && logError === null ? (
              <p className="px-3 py-1 text-b2 text-ink-tertiary">读不到提交历史</p>
            ) : (
              commits.map((commit) => (
                <button
                  key={commit.sha}
                  type="button"
                  data-testid="git-commit"
                  data-sha={commit.short}
                  onClick={() => openCommit(commit.sha)}
                  className={cn(
                    'flex w-full cursor-default items-start gap-1 px-2 py-1 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover',
                    selected?.sha === commit.sha && 'bg-selected'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="shrink-0 font-mono text-b2 whitespace-pre text-ink-tertiary"
                  >
                    {commit.graph}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="font-mono text-c1 text-ink-tertiary">{commit.short}</span>
                      {splitRefs(commit.refs).map((ref) => (
                        <span key={ref} className={cn('text-c1', refTone(ref))}>
                          {ref}
                        </span>
                      ))}
                    </span>
                    <span className="block truncate text-b2 text-ink" title={commit.subject}>
                      {commit.subject}
                    </span>
                  </span>
                </button>
              ))
            )}
          </>
        )}
      </div>

      {selected === null ? null : (
        <BottomSheet
          testId="git-commit-detail"
          title={
            <span className="flex items-center gap-1.5">
              <History aria-hidden="true" className="size-(--icon-size-sm) text-ink-tertiary" />
              <span className="font-mono">
                {selected.state.value?.short ?? selected.sha.slice(0, 7)}
              </span>
            </span>
          }
          onClose={() => setSelected(null)}
        >
          <DetailBody state={selected.state} />
        </BottomSheet>
      )}
    </div>
  )
}

/** 提交详情：作者/时间/完整 message + 变更文件统计（`--numstat` 的结构化行） */
function DetailBody({ state }: { state: DetailState }): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-4">
        <Spinner label="加载中" className="text-ink-tertiary" />
      </div>
    )
  }
  if (state.status === 'error') {
    return <ToolError testId="git-commit-error" message={state.error ?? '读不了这条提交'} />
  }

  const detail = state.value
  if (detail === undefined) return <div />

  return (
    <div data-testid="git-commit-body" className="px-3 py-2">
      <p className="text-b2 text-ink">{detail.author}</p>
      <p className="pb-2 text-c1 text-ink-tertiary">{formatDateTime(detail.date)}</p>
      <pre className="font-mono text-b2 whitespace-pre-wrap break-all text-ink">
        {detail.message}
      </pre>
      <div className="pt-3">
        {detail.files.length === 0 ? (
          <p className="text-b2 text-ink-tertiary">没有文件变更</p>
        ) : (
          detail.files.map((file) => (
            <div key={file.path} className="flex items-baseline gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate text-b2 text-ink" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 font-mono text-c1 text-ink-tertiary">
                {formatLineStat(file.additions, file.deletions)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
