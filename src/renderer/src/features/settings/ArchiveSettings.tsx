import { useMemo, useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'

/**
 * 设置页「归档」组（round 20）：归档会话的列表 / 搜索 / 取消归档。
 *
 * 口径：
 *   - 列表数据 = settings.archivedThreads（**归档那一刻的快照**：标题与来源项目都按当时的值显示；
 *     项目后来被删了也不影响这一行——只是名字查不到，就只显示标题）；
 *   - 搜索 = 标题子串过滤（大小写不敏感；空关键词 = 全部）；时间倒序（最近归档的在前）；
 *   - 取消归档 = 把这条从 archivedThreads 去掉（走 settings:update；失败行内给原因）。
 *     会话数据一直没动过，去掉就回侧栏原位置（项目映射也还在，回原项目分组）；
 *   - 进入归档会话本身的入口留到后续（本轮只做用户点名的"查看 / 搜索 / 取消归档"三项）。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function ArchiveSettings(): React.JSX.Element {
  const archived = useSettingsStore((state) => state.settings.archivedThreads)
  const projects = useSettingsStore((state) => state.settings.projects)
  const unarchiveThread = useSettingsStore((state) => state.unarchiveThread)
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
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

  const restore = (threadId: string): void => {
    setPendingId(threadId)
    setError(null)
    unarchiveThread(threadId).then(
      () => setPendingId(null),
      (cause: unknown) => {
        setPendingId(null)
        setError(messageOf(cause))
      }
    )
  }

  return (
    <div data-testid="archive-settings" className="flex flex-col gap-4">
      <Input
        data-testid="archive-search"
        aria-label="搜索归档会话"
        placeholder="搜索归档会话"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {error === null ? null : (
        <p data-testid="archive-error" className="text-c1 text-danger">
          取消归档失败：{error}
        </p>
      )}

      {archived.length === 0 ? (
        <p data-testid="archive-empty" className="text-b2 text-ink-secondary">
          还没有归档的会话：在会话行的 ⋯ 菜单里选「归档」，它就出现在这里。
        </p>
      ) : rows.length === 0 ? (
        <p data-testid="archive-no-match" className="text-b2 text-ink-secondary">
          没有匹配的归档会话。
        </p>
      ) : (
        rows.map((row) => (
          <section
            key={row.entry.threadId}
            data-testid={`archive-row-${row.entry.threadId}`}
            className="flex flex-wrap items-center gap-3 rounded-panel border border-hairline p-3"
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
              loading={pendingId === row.entry.threadId}
              disabled={pendingId !== null && pendingId !== row.entry.threadId}
              onClick={() => restore(row.entry.threadId)}
            >
              <ArchiveRestore aria-hidden="true" className="size-4" />
              取消归档
            </Button>
          </section>
        ))
      )}
    </div>
  )
}
