import { useMemo, useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ArchivedProject, ArchivedThread } from '@shared/settings'

/**
 * 设置页「归档」组（round 20 会话；round 25 加项目分区）：归档内容的列表 / 搜索 / 取消归档。
 *
 * 口径：
 *   - 数据 = settings.archivedThreads / archivedProjects（**归档那一刻的快照**：标题/名称/路径
 *     都按当时的值显示；项目后来改了名或删了也不影响这一行）；
 *   - 搜索 = 标题 / 项目名 / 路径子串过滤（大小写不敏感；空关键词 = 全部）；时间倒序；
 *   - 取消归档：会话 → 去掉那条走 settings:update（会话回侧栏原位置）；项目 → 去掉那条
 *     （**项目与它名下会话一并回侧栏**）。失败经 unwrapIpcError 剥包装后行内给原因；
 *   - 归档不删任何数据/磁盘内容（项目归档只影响侧栏可见性）。
 */
function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 分区小标题（与设置组内的二级标题同观感，但不套框） */
function SectionTitle({ children }: { children: string }): React.JSX.Element {
  return <h3 className="pt-2 text-b2 text-ink-secondary">{children}</h3>
}

export function ArchiveSettings(): React.JSX.Element {
  const archived = useSettingsStore((state) => state.settings.archivedThreads)
  const archivedProjects = useSettingsStore((state) => state.settings.archivedProjects)
  const projects = useSettingsStore((state) => state.settings.projects)
  const unarchiveThread = useSettingsStore((state) => state.unarchiveThread)
  const unarchiveProject = useSettingsStore((state) => state.unarchiveProject)
  const [query, setQuery] = useState('')
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const threadRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...archived]
      .sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0))
      .map((entry) => ({
        entry,
        title: entry.title ?? '新会话',
        projectName:
          entry.projectId === null
            ? null
            : (projects.find((project) => project.id === entry.projectId)?.name ?? null)
      }))
      .filter((row) => q === '' || row.title.toLowerCase().includes(q))
  }, [archived, projects, query])

  const projectRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...archivedProjects]
      .sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0))
      .filter(
        (entry) =>
          q === '' || entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q)
      )
  }, [archivedProjects, query])

  const run = (key: string, action: () => Promise<void>): void => {
    setPendingKey(key)
    setError(null)
    action().then(
      () => setPendingKey(null),
      (cause: unknown) => {
        setPendingKey(null)
        setError(messageOf(cause))
      }
    )
  }

  const restoreThread = (entry: ArchivedThread): void => {
    run(`thread:${entry.threadId}`, () => unarchiveThread(entry.threadId))
  }

  const restoreProject = (entry: ArchivedProject): void => {
    run(`project:${entry.projectId}`, () => unarchiveProject(entry.projectId))
  }

  return (
    <div data-testid="archive-settings" className="flex flex-col gap-4">
      <Input
        data-testid="archive-search"
        aria-label="搜索归档内容"
        placeholder="搜索归档的会话或项目"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {error === null ? null : (
        <p data-testid="archive-error" className="text-c1 text-danger">
          取消归档失败：{error}
        </p>
      )}

      {archived.length === 0 && archivedProjects.length === 0 ? (
        <p data-testid="archive-empty" className="text-b2 text-ink-secondary">
          还没有归档的会话或项目：在会话/项目行的 ⋯ 菜单里选「归档」，它就出现在这里。
        </p>
      ) : threadRows.length === 0 && projectRows.length === 0 ? (
        <p data-testid="archive-no-match" className="text-b2 text-ink-secondary">
          没有匹配的归档内容。
        </p>
      ) : (
        <>
          <SectionTitle>会话</SectionTitle>
          {archived.length === 0 ? (
            <p className="text-c1 text-ink-tertiary">还没有归档的会话。</p>
          ) : threadRows.length === 0 ? (
            <p className="text-c1 text-ink-tertiary">没有匹配的会话。</p>
          ) : (
            threadRows.map((row) => (
              <section
                key={row.entry.threadId}
                data-testid={`archive-row-${row.entry.threadId}`}
                className="flex flex-wrap items-center gap-3 rounded-panel border border-surface-border p-3"
              >
                <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
                  <span
                    data-testid={`archive-title-${row.entry.threadId}`}
                    className="text-b2 text-ink"
                  >
                    {row.title}
                  </span>
                  <span className="text-c1 text-ink-secondary">
                    {row.projectName === null ? '无项目' : row.projectName} · 归档于{' '}
                    {localTime(row.entry.archivedAt)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`archive-restore-${row.entry.threadId}`}
                  loading={pendingKey === `thread:${row.entry.threadId}`}
                  disabled={pendingKey !== null && pendingKey !== `thread:${row.entry.threadId}`}
                  onClick={() => restoreThread(row.entry)}
                >
                  {/* 图标随字号 scale（task-69）：走 --icon-size-sm token，不写死 16px */}
                  <ArchiveRestore aria-hidden="true" className="size-(--icon-size-sm)" />
                  取消归档
                </Button>
              </section>
            ))
          )}

          <SectionTitle>项目</SectionTitle>
          {archivedProjects.length === 0 ? (
            <p className="text-c1 text-ink-tertiary">还没有归档的项目。</p>
          ) : projectRows.length === 0 ? (
            <p className="text-c1 text-ink-tertiary">没有匹配的项目。</p>
          ) : (
            projectRows.map((entry) => (
              <section
                key={entry.projectId}
                data-testid={`archive-project-row-${entry.projectId}`}
                className="flex flex-wrap items-center gap-3 rounded-panel border border-surface-border p-3"
              >
                <div className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
                  <span
                    data-testid={`archive-project-title-${entry.projectId}`}
                    className="text-b2 text-ink"
                  >
                    {entry.name}
                  </span>
                  <span className="min-w-0 truncate text-c1 text-ink-secondary">
                    {entry.path} · 归档于 {localTime(entry.archivedAt)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`archive-project-restore-${entry.projectId}`}
                  loading={pendingKey === `project:${entry.projectId}`}
                  disabled={pendingKey !== null && pendingKey !== `project:${entry.projectId}`}
                  onClick={() => restoreProject(entry)}
                >
                  {/* 图标随字号 scale（task-69）：走 --icon-size-sm token，不写死 16px */}
                  <ArchiveRestore aria-hidden="true" className="size-(--icon-size-sm)" />
                  取消归档
                </Button>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
