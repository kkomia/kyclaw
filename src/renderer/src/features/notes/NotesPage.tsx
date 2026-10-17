import { Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { NoteEditor } from './NoteEditor'
import { NotesList } from './NotesList'
import { useNotesStore } from './notes-store'
import { useNarrow } from './use-narrow'

/**
 * 笔记页（M5 v1）：顶部 band（标题 18/26 600 + 新建）+ 左列 300 + 右区 720。
 * 列表/编辑器/空态都在同一页内切换；窄窗 <900 列表与编辑器互为整屏（「返回列表」），不新增路由。
 */
export function NotesPage(): React.JSX.Element {
  const narrow = useNarrow()
  const initialNarrow = useRef(narrow)
  const notes = useNotesStore((state) => state.notes)
  const selectedId = useNotesStore((state) => state.selectedId)
  const listLoading = useNotesStore((state) => state.listLoading)
  const create = useNotesStore((state) => state.create)
  const closeNote = useNotesStore((state) => state.closeNote)

  useEffect(() => {
    void useNotesStore.getState().init(initialNarrow.current)
  }, [])

  const showList = !narrow || selectedId === null
  const showEditor = selectedId !== null
  const empty = notes.length === 0 && !listLoading && selectedId === null

  return (
    <section
      data-testid="notes-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-hairline px-4">
        <h1
          data-testid="notes-page-title"
          className="font-serif text-[18px] leading-[26px] font-semibold text-ink"
        >
          笔记
        </h1>
        <div className="flex items-center gap-2">
          {narrow && selectedId !== null ? (
            <Button variant="ghost" size="sm" data-testid="notes-back" onClick={() => closeNote()}>
              返回列表
            </Button>
          ) : null}
          <Button
            size="sm"
            icon={<Plus aria-hidden="true" />}
            data-testid="notes-new"
            onClick={() => void create()}
          >
            新建笔记
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {showList ? <NotesList /> : null}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {showEditor ? (
            <NoteEditor />
          ) : (
            <EmptyPanel empty={empty} onCreate={() => void create()} />
          )}
        </main>
      </div>
    </section>
  )
}

/**
 * 右区空态（章程 §9.6）：一句衬线标题 + 一行说明 + 一个实物动作，不放插画/吉祥物。
 * 有笔记但没选中（窄窗列表态不会走到这里）时给「选择一篇笔记」，不说教。
 */
function EmptyPanel({
  empty,
  onCreate
}: {
  empty: boolean
  onCreate: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid={empty ? 'notes-empty' : 'notes-select-hint'}
      className="animate-message-in mx-auto flex min-h-full w-full max-w-(--content-max-width) flex-col items-start justify-center px-(--page-gutter) py-8"
    >
      <h2 className="font-serif text-[24px] leading-[32px] font-semibold text-ink">
        {empty ? '写下第一篇笔记' : '选择一篇笔记'}
      </h2>
      <p className="mt-2 text-b2 text-ink-secondary">
        {empty
          ? '笔记是存在本机上的 Markdown 文件，可以随时打开数据文件夹拿走。'
          : '从左侧列表选一篇，或新建一篇继续写。'}
      </p>
      {empty ? (
        <Button
          className="mt-5"
          icon={<Plus aria-hidden="true" />}
          data-testid="notes-empty-create"
          onClick={onCreate}
        >
          新建笔记
        </Button>
      ) : null}
    </div>
  )
}
