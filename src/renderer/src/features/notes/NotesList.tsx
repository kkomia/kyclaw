import { FolderOpen, Pin, PinOff, Search, X } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { cn } from '@renderer/components/ui/cn'
import type { NoteMeta } from '@shared/notes'
import { useNotesStore } from './notes-store'
import { listTimeLabel } from './notes-format'

/**
 * 左列（task-94 美术层）：**一叠稿纸目录**。
 *
 * 搜索（凹槽行）→ 列表（置顶/全部两组小节；行 54：标题 + 时间 · 摘要；选中吃实底 + 2px 暖线；
 * 置顶别针常驻）→ 打开数据文件夹。宽度/井线/行为不变（240 = --sidebar-width，右缘接缝）。
 */
export function NotesList(): React.JSX.Element {
  const notes = useNotesStore((state) => state.notes)
  const selectedId = useNotesStore((state) => state.selectedId)
  const query = useNotesStore((state) => state.query)
  const searchHits = useNotesStore((state) => state.searchHits)
  const searching = useNotesStore((state) => state.searching)
  const listLoading = useNotesStore((state) => state.listLoading)
  const listError = useNotesStore((state) => state.listError)
  const notice = useNotesStore((state) => state.notice)
  const select = useNotesStore((state) => state.select)
  const togglePin = useNotesStore((state) => state.togglePin)
  const search = useNotesStore((state) => state.search)
  const clearSearch = useNotesStore((state) => state.clearSearch)
  const openFolder = useNotesStore((state) => state.openFolder)
  const clearNotice = useNotesStore((state) => state.clearNotice)

  const searchingNow = searchHits !== null
  const pinned = notes.filter((note) => note.pinned)
  const showSections = pinned.length > 0 && !searchingNow
  const rest = notes.filter((note) => !note.pinned)

  return (
    <aside
      data-testid="notes-list-column"
      className="np-list-column w-(--sidebar-width) shrink-0 border-r border-(--seam-line) bg-(--bg-sidebar)"
    >
      <div className="np-search-wrap">
        <div className="np-search">
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <input
            data-testid="notes-search"
            type="search"
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="搜索笔记"
            aria-label="搜索笔记"
            className="np-search-input"
          />
          {query === '' ? null : (
            <button
              type="button"
              aria-label="清空搜索"
              data-testid="notes-search-clear"
              onClick={clearSearch}
              className="np-search-clear"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div data-testid="notes-list" className="np-list-scroll">
        {listLoading && notes.length === 0 ? (
          <div data-testid="notes-list-loading" className="np-list-loading">
            {[0, 1, 2].map((index) => (
              <div key={index} className="np-skeleton-row" />
            ))}
          </div>
        ) : listError !== null ? (
          <p data-testid="notes-list-error" className="np-list-error">
            {listError}
          </p>
        ) : searchingNow ? (
          searchHits!.length === 0 ? (
            <p className="np-list-hint">{searching ? '搜索中…' : '没有匹配的笔记'}</p>
          ) : (
            searchHits!.map((hit) => (
              <SearchRow
                key={hit.id}
                id={hit.id}
                title={hit.title}
                snippet={hit.snippet}
                selected={selectedId === hit.id}
                onSelect={() => void select(hit.id)}
              />
            ))
          )
        ) : notes.length === 0 ? (
          <div data-testid="notes-list-empty" className="np-list-empty">
            <span className="np-list-empty-title">还没有笔记</span>
            <span className="np-list-empty-sub">点右上角「新建笔记」，开始写第一张稿纸。</span>
          </div>
        ) : showSections ? (
          <>
            <SectionLabel>置顶</SectionLabel>
            {pinned.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                selected={selectedId === note.id}
                onSelect={() => void select(note.id)}
                onTogglePin={() => void togglePin(note.id)}
              />
            ))}
            {rest.length > 0 ? <SectionLabel>全部笔记</SectionLabel> : null}
            {rest.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                selected={selectedId === note.id}
                onSelect={() => void select(note.id)}
                onTogglePin={() => void togglePin(note.id)}
              />
            ))}
          </>
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              selected={selectedId === note.id}
              onSelect={() => void select(note.id)}
              onTogglePin={() => void togglePin(note.id)}
            />
          ))
        )}
      </div>

      <div className="np-list-foot">
        <button
          type="button"
          data-testid="notes-open-folder"
          onClick={() => void openFolder()}
          className="np-open-folder"
        >
          <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
          打开数据文件夹
        </button>
        {notice === null ? null : (
          <button
            type="button"
            data-testid="notes-notice"
            onClick={clearNotice}
            className="np-notice"
            title={notice}
          >
            {notice}
          </button>
        )}
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="np-section-label" data-testid="notes-section-label">
      {children}
    </div>
  )
}

/** 稿纸目录行：标题 +（置顶别针）+ 时间 · 摘要；选中吃实底并亮出 2px 暖线 */
function NoteRow({
  note,
  selected,
  onSelect,
  onTogglePin
}: {
  note: NoteMeta
  selected: boolean
  onSelect: () => void
  onTogglePin: () => void
}): React.JSX.Element {
  const excerpt = note.excerpt.trim()
  return (
    <div className="np-row-wrap group relative">
      <button
        type="button"
        data-testid={`note-row-${note.id}`}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : 'false'}
        onClick={onSelect}
        className="np-row ui-list-row"
      >
        <span className="np-row-top">
          <span className="np-row-title">{note.title}</span>
          {note.pinned ? <Pin className="np-row-pin" aria-hidden="true" /> : null}
        </span>
        <span className="np-row-meta">
          <span className="np-row-time tabular-nums">{listTimeLabel(note.updatedAt)}</span>
          {excerpt === '' ? null : (
            <>
              <span className="np-row-meta-dot" aria-hidden="true">
                ·
              </span>
              <span className="np-row-excerpt">{excerpt}</span>
            </>
          )}
        </span>
      </button>
      <IconButton
        label={note.pinned ? `取消置顶「${note.title}」` : `置顶「${note.title}」`}
        data-testid={`note-pin-${note.id}`}
        aria-pressed={note.pinned}
        data-pinned={note.pinned ? 'true' : 'false'}
        onClick={onTogglePin}
        className={cn(
          'np-pin size-6 border-0',
          note.pinned
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        )}
        icon={
          note.pinned ? (
            <Pin className="size-3.5" aria-hidden="true" />
          ) : (
            <PinOff className="size-3.5" aria-hidden="true" />
          )
        }
      />
    </div>
  )
}

/** 搜索结果行：标题 + 主进程压过的命中片段（不带时间，片段才是信息） */
function SearchRow({
  id,
  title,
  snippet,
  selected,
  onSelect
}: {
  id: string
  title: string
  snippet: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`note-row-${id}`}
      aria-current={selected ? 'true' : undefined}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      className="np-row ui-list-row"
    >
      <span className="np-row-top">
        <span className="np-row-title">{title}</span>
      </span>
      <span className="np-row-meta">
        <span className="np-row-excerpt">{snippet}</span>
      </span>
    </button>
  )
}
