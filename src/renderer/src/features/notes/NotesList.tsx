import { FolderOpen, Pin, PinOff, Search, X } from 'lucide-react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { cn } from '@renderer/components/ui/cn'
import { useNotesStore } from './notes-store'
import { rowMetaText } from './notes-format'

/**
 * 左列（300）：搜索 → 列表 → 打开数据文件夹。
 * 列表行 48 高（plan §4.1 的 44–52 档），选中吃 `--fill-selected` 实底；
 * 置顶是行右侧的小图标动作（真落 index.json，见 notes:pin）。
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

  return (
    <aside
      data-testid="notes-list-column"
      className="flex w-[300px] shrink-0 flex-col border-r border-hairline bg-(--bg-sidebar)"
    >
      <div className="shrink-0 px-2 pt-2 pb-1">
        <div className="group flex h-9 items-center gap-1.5 rounded-control px-2 transition-colors duration-(--motion-feedback) ease-main hover:bg-hover focus-within:bg-hover">
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
          <input
            data-testid="notes-search"
            type="search"
            value={query}
            onChange={(event) => search(event.target.value)}
            placeholder="搜索笔记"
            aria-label="搜索笔记"
            className="min-w-0 flex-1 bg-transparent text-b2 text-ink outline-none placeholder:text-(--text-tertiary-readable) [&::-webkit-search-cancel-button]:hidden"
          />
          {query === '' ? null : (
            <button
              type="button"
              aria-label="清空搜索"
              data-testid="notes-search-clear"
              onClick={clearSearch}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-ink-tertiary hover:bg-active hover:text-ink"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div data-testid="notes-list" className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {listLoading && notes.length === 0 ? (
          <div data-testid="notes-list-loading" className="flex flex-col gap-1 pt-1">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-12 animate-pulse rounded-control bg-hover" />
            ))}
          </div>
        ) : listError !== null ? (
          <p data-testid="notes-list-error" className="px-2 py-3 text-c1 text-danger">
            {listError}
          </p>
        ) : searchingNow && searchHits.length === 0 ? (
          <p className="px-2 py-3 text-c1 text-ink-tertiary">
            {searching ? '搜索中…' : '没有匹配的笔记'}
          </p>
        ) : (searchingNow ? searchHits : notes).length === 0 ? (
          <p data-testid="notes-list-empty" className="px-2 py-3 text-c1 text-ink-tertiary">
            {searchingNow ? '没有匹配的笔记' : '还没有笔记。点右上角「新建笔记」开始。'}
          </p>
        ) : searchingNow ? (
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
        ) : (
          notes.map((note) => {
            const selected = selectedId === note.id
            return (
              <div key={note.id} className="group relative">
                <button
                  type="button"
                  data-testid={`note-row-${note.id}`}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => void select(note.id)}
                  className={cn(
                    'flex h-12 w-full flex-col items-start justify-center gap-0.5 rounded-control px-2 pr-8 text-left transition-colors duration-(--motion-feedback) ease-main motion-reduce:transition-none',
                    selected ? 'bg-selected' : 'hover:bg-hover'
                  )}
                >
                  <span className="w-full truncate text-b2 font-medium text-ink">{note.title}</span>
                  <span className="w-full truncate text-c1 text-ink-tertiary">
                    {rowMetaText(note.excerpt, note.updatedAt)}
                  </span>
                </button>
                <IconButton
                  label={note.pinned ? `取消置顶「${note.title}」` : `置顶「${note.title}」`}
                  data-testid={`note-pin-${note.id}`}
                  aria-pressed={note.pinned}
                  onClick={() => void togglePin(note.id)}
                  className={cn(
                    'absolute top-1/2 right-1 size-6 -translate-y-1/2 border-0',
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
          })
        )}
      </div>

      <div className="shrink-0 border-t border-hairline px-2 py-1.5">
        <button
          type="button"
          data-testid="notes-open-folder"
          onClick={() => void openFolder()}
          className="inline-flex h-8 w-full items-center gap-1.5 rounded-control px-2 text-c1 text-ink-tertiary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover hover:text-ink hover:underline"
        >
          <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
          打开数据文件夹
        </button>
        {notice === null ? null : (
          <button
            type="button"
            data-testid="notes-notice"
            onClick={clearNotice}
            className="mt-1 w-full truncate rounded-control px-2 py-1 text-left text-c1 text-ink-tertiary"
            title={notice}
          >
            {notice}
          </button>
        )}
      </div>
    </aside>
  )
}

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
      onClick={onSelect}
      className={cn(
        'flex h-12 w-full flex-col items-start justify-center gap-0.5 rounded-control px-2 text-left transition-colors duration-(--motion-feedback) ease-main motion-reduce:transition-none',
        selected ? 'bg-selected' : 'hover:bg-hover'
      )}
    >
      <span className="w-full truncate text-b2 font-medium text-ink">{title}</span>
      <span className="w-full truncate text-c1 text-ink-tertiary">{snippet}</span>
    </button>
  )
}
