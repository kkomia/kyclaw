import { Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { EmptyState, PageMeta, PageTitle } from '@renderer/components/ui/page-chrome'
import { NoteEditor } from './NoteEditor'
import { NotesList } from './NotesList'
import { useNotesStore } from './notes-store'
import { useNarrow } from './use-narrow'
import './notes.css'

/**
 * 笔记页（task-94 美术层）：**桌面上的稿纸**。
 *
 * 页头是一行书眉（衬线「笔记」+ 篇数读数 + 新建）；左列是纸叠目录（240，细线稿纸行），
 * 右侧是一张有页眉的稿纸（标题层 → 保存态/字数 → 正文）。列表/编辑器/空态仍在同一页切换；
 * 窄窗 <900 列表与编辑器互为整屏（「返回列表」），不新增路由。
 *
 * 行为全部来自 notes-store（init/create/select/save/pin/search/delete/close），本文件只排视觉。
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
    <section data-testid="notes-page" className="np-page">
      <header className="np-band">
        <div className="np-band-left">
          <PageTitle data-testid="notes-page-title">笔记</PageTitle>
          <PageMeta data-testid="notes-count">{notes.length} 篇</PageMeta>
        </div>
        <div className="np-band-actions">
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

      <div className="np-page-body">
        {showList ? <NotesList /> : null}
        <main className="np-main">
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
 * 右区空态：一张还没写字的稿纸（三条细线 + 页边暖线 + 衬线标题），没有插画/吉祥物。
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
    <EmptyState
      data-testid={empty ? 'notes-empty' : 'notes-select-hint'}
      mark={
        <div className="np-empty-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      }
      title={empty ? '写下第一篇笔记' : '选择一篇笔记'}
      description={
        empty
          ? '笔记存在本机，随时可以打开数据文件夹拿走。'
          : '从左侧列表选一篇，或新建一篇继续写。'
      }
      action={
        empty ? (
          <Button
            icon={<Plus aria-hidden="true" />}
            data-testid="notes-empty-create"
            onClick={onCreate}
          >
            新建笔记
          </Button>
        ) : undefined
      }
    />
  )
}
