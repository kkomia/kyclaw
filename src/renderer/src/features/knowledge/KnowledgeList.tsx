/**
 * 知识库左列（240px · 索引抽屉，task-95 美术层）：
 *   - 搜索框 = 抽屉头：凹槽底 + hairline 于 focus 时出现 + 有词给清除键；
 *   - 列表行 = 索引卡：标题 + 扩展名标签（mono 10）+ mono 时间/大小；hairline 分隔（不用卡片矩阵）；
 *   - 搜索命中 = 命中计数行（mono tabular）+ 标题/摘要里的命中高亮（accent 薄底 mark）；
 *   - 页脚「打开数据文件夹」= 抽屉底：hairline 上边 + 低饱和 tertiary。
 *
 * 搜索走主进程（`knowledge:search`），输入 200ms 防抖；非搜索态显示全量列表（按加入时间倒序）。
 * 选中 = `bg-selected`（现有 token，不新增色）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, Search, X } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { formatBytes, formatDateTime } from '@renderer/features/workbench/format'
import { useKnowledgeStore } from './knowledge-store'

/** 扩展名标签：md → MD；长后缀保留原样（不做假 mapping） */
function kindOf(ext: string): string {
  return ext.trim().toUpperCase()
}

/** 在文本里给 query 的每次出现套 mark（大小写不敏感；空 query 原样返回） */
function highlightHits(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (needle === '') return text
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  for (;;) {
    const index = lowerText.indexOf(lowerNeedle, cursor)
    if (index < 0) break
    if (index > cursor) nodes.push(text.slice(cursor, index))
    nodes.push(
      <mark key={`hit-${String(key)}`} className="knowledge-hit-mark">
        {text.slice(index, index + needle.length)}
      </mark>
    )
    key += 1
    cursor = index + needle.length
  }
  if (nodes.length === 0) return text
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

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
      <div className="flex shrink-0 items-center gap-1 px-2 pt-3 pb-1">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border-(length:--hairline-width) border-transparent bg-secondary px-2 text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover focus-within:border-hairline focus-within:bg-hover">
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            data-testid="knowledge-search"
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="搜索标题和正文"
            aria-label="搜索知识库"
            className="min-w-0 flex-1 bg-transparent text-b2 text-ink outline-none placeholder:text-ink-tertiary [&::-webkit-search-cancel-button]:appearance-none"
          />
          {draft === '' ? null : (
            <button
              type="button"
              data-testid="knowledge-search-clear"
              aria-label="清除搜索"
              onClick={() => setDraft('')}
              className="flex size-5 shrink-0 items-center justify-center rounded-badge text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded || loading ? (
          <div data-testid="knowledge-list-loading" className="flex flex-col gap-2 px-2 py-1">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : searchingNow ? (
          <HitList />
        ) : documents.length === 0 ? (
          <div data-testid="knowledge-list-empty" className="flex flex-col gap-1 px-2 py-3">
            <p className="text-b2 text-ink-secondary">还没有资料</p>
            <p className="text-c1 text-ink-tertiary">点右上角「导入资料」把本机文本收进库。</p>
          </div>
        ) : (
          <ul data-testid="knowledge-list" className="flex flex-col">
            {documents.map((doc) => {
              const selected = doc.id === selectedId
              return (
                <li key={doc.id} className="knowledge-index-item">
                  <button
                    type="button"
                    data-testid="knowledge-item"
                    data-doc-id={doc.id}
                    data-selected={selected ? 'true' : 'false'}
                    onClick={() => select(doc.id)}
                    className={cn(
                      'ui-list-row flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-control px-2 py-2 pl-2.5 text-left transition-colors duration-(--motion-feedback) ease-main hover:bg-hover motion-reduce:transition-none'
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'knowledge-index-title truncate text-b2 font-medium',
                          selected ? 'text-ink' : 'text-ink-secondary'
                        )}
                      >
                        {doc.title}
                      </span>
                      <span
                        data-testid="knowledge-kind"
                        className="ml-auto shrink-0 rounded-[4px] border-(length:--hairline-width) border-hairline px-1 font-mono text-c2 text-ink-tertiary"
                      >
                        {kindOf(doc.ext)}
                      </span>
                    </span>
                    {/* meta = 读数声部：时间/大小 mono + tabular（与主 chat 数字口径一致） */}
                    <span className="truncate font-mono text-c1 text-ink-tertiary tabular-nums">
                      {formatDateTime(doc.addedAt)} · {formatBytes(doc.size)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline p-2">
        <button
          type="button"
          data-testid="knowledge-open-folder"
          onClick={() => void openFolder()}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-c1 text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
        >
          <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
          打开数据文件夹
        </button>
      </div>
    </div>
  )
}

/** 搜索命中列表（命中计数行 + 标题/摘要高亮；没有命中给一句空话） */
function HitList(): React.JSX.Element {
  const hits = useKnowledgeStore((state) => state.hits)
  const selectedId = useKnowledgeStore((state) => state.selectedId)
  const query = useKnowledgeStore((state) => state.query)
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
      <div data-testid="knowledge-search-empty" className="flex flex-col gap-1 px-2 py-3">
        <p className="text-b2 text-ink-secondary">没有匹配的资料</p>
        <p className="text-c1 text-ink-tertiary">试试更短的词，或只搜标题里的名字。</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      <p
        data-testid="knowledge-search-count"
        className="px-2 pb-1 pt-0.5 font-mono text-c1 text-ink-tertiary tabular-nums"
      >
        共 {hits.length} 条命中
      </p>
      <ul data-testid="knowledge-hit-list" className="flex flex-col">
        {hits.map((hit) => {
          const selected = hit.id === selectedId
          return (
            <li key={hit.id} className="knowledge-index-item">
              <button
                type="button"
                data-testid="knowledge-hit"
                data-doc-id={hit.id}
                onClick={() => select(hit.id)}
                className={cn(
                  'flex w-full min-w-0 flex-col justify-center gap-0.5 rounded-control px-2 py-2 text-left transition-colors duration-(--motion-feedback) ease-main motion-reduce:transition-none',
                  selected ? 'bg-selected' : 'hover:bg-hover'
                )}
              >
                <span
                  className={cn(
                    'knowledge-index-title truncate text-b2 font-medium',
                    selected ? 'text-ink' : 'text-ink-secondary'
                  )}
                >
                  {highlightHits(hit.title, query)}
                </span>
                <span className="line-clamp-2 text-c1 text-ink-tertiary">
                  {highlightHits(hit.snippet, query)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
