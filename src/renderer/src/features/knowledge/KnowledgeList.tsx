/**
 * 知识库左列（300px）：搜索框 + 文档列表 + 「打开数据文件夹」页脚。
 *
 * 搜索走主进程（`knowledge:search`），输入 200ms 防抖；非搜索态显示全量列表（按加入时间倒序）。
 * 行高 44–52：标题 b2 单行省略 + 次行 meta c1；选中 = `bg-selected`（现有 token，不新增色）。
 */
import { useEffect, useState } from 'react'
import { FolderOpen, Search } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { formatBytes, formatDateTime } from '@renderer/features/workbench/format'
import { useKnowledgeStore } from './knowledge-store'

export function KnowledgeList(): React.JSX.Element {
  const documents = useKnowledgeStore((state) => state.documents)
  const selectedId = useKnowledgeStore((state) => state.selectedId)
  const loaded = useKnowledgeStore((state) => state.loaded)
  const loading = useKnowledgeStore((state) => state.loading)
  const select = useKnowledgeStore((state) => state.select)
  const search = useKnowledgeStore((state) => state.search)
  const openFolder = useKnowledgeStore((state) => state.openFolder)

  const [draft, setDraft] = useState('')
  // 输入防抖：200ms 后再发 IPC（清空立刻回全量列表）
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void search(draft)
    }, 200)
    return () => window.clearTimeout(handle)
  }, [draft, search])

  const searchingNow = draft.trim() !== ''

  return (
    <div data-testid="knowledge-list-column" className="flex min-h-0 flex-1 flex-col">
      <label className="mx-3 mt-3 flex h-9 shrink-0 items-center gap-2 rounded-control px-2 text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover focus-within:bg-hover">
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <input
          data-testid="knowledge-search"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="搜索标题和正文"
          aria-label="搜索知识库"
          className="min-w-0 flex-1 bg-transparent text-b2 text-ink outline-none placeholder:text-ink-tertiary"
        />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!loaded || loading ? (
          <div data-testid="knowledge-list-loading" className="flex flex-col gap-2 px-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : searchingNow ? (
          <HitList />
        ) : documents.length === 0 ? (
          <p data-testid="knowledge-list-empty" className="px-2 py-3 text-c1 text-ink-tertiary">
            还没有资料。点上方「导入资料」把本机文本收进库。
          </p>
        ) : (
          <ul data-testid="knowledge-list" className="flex flex-col gap-0.5">
            {documents.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  data-testid="knowledge-item"
                  data-doc-id={doc.id}
                  data-selected={doc.id === selectedId ? 'true' : 'false'}
                  onClick={() => select(doc.id)}
                  className={cn(
                    'flex w-full min-h-11 flex-col justify-center gap-0.5 rounded-control px-2 py-1.5 text-left transition-colors duration-(--motion-fast) ease-main',
                    doc.id === selectedId
                      ? 'bg-selected text-ink'
                      : 'text-ink-secondary hover:bg-hover'
                  )}
                >
                  <span className="truncate text-b2 font-medium">{doc.title}</span>
                  {/* meta = 读数声部：时间/大小 mono + tabular（与主 chat 数字口径一致） */}
                  <span className="truncate font-mono text-c1 text-ink-tertiary tabular-nums">
                    {formatDateTime(doc.addedAt)} · {formatBytes(doc.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline p-2">
        <button
          type="button"
          data-testid="knowledge-open-folder"
          onClick={() => void openFolder()}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-c1 text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink"
        >
          <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
          打开数据文件夹
        </button>
      </div>
    </div>
  )
}

/** 搜索命中列表（标题 + 主进程给的 snippet；没有命中给一句空话） */
function HitList(): React.JSX.Element {
  const hits = useKnowledgeStore((state) => state.hits)
  const selectedId = useKnowledgeStore((state) => state.selectedId)
  const select = useKnowledgeStore((state) => state.select)

  if (hits === null) {
    return (
      <div data-testid="knowledge-search-loading" className="flex flex-col gap-2 px-2 py-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (hits.length === 0) {
    return (
      <p data-testid="knowledge-search-empty" className="px-2 py-3 text-c1 text-ink-tertiary">
        没有匹配的资料。
      </p>
    )
  }
  return (
    <ul data-testid="knowledge-hit-list" className="flex flex-col gap-0.5">
      {hits.map((hit) => (
        <li key={hit.id}>
          <button
            type="button"
            data-testid="knowledge-hit"
            data-doc-id={hit.id}
            onClick={() => select(hit.id)}
            className={cn(
              'flex w-full flex-col justify-center gap-0.5 rounded-control px-2 py-1.5 text-left transition-colors duration-(--motion-fast) ease-main',
              hit.id === selectedId ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
            )}
          >
            <span className="truncate text-b2 font-medium">{hit.title}</span>
            <span className="line-clamp-2 text-c1 text-ink-tertiary">{hit.snippet}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
