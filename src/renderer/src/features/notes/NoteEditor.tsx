import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Segmented } from '@renderer/components/ui/segmented'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { useNotesStore } from './notes-store'
import { clockLabel } from './notes-format'

/**
 * 右区编辑器（plan §4.2）：标题 24/32 + 正文 `--font-ui` 15/27。
 * 自动保存 debounce 在 store（600ms）；这里只负责 Ctrl+S、Tab 两空格、编辑⇄预览与删除确认。
 */
export function NoteEditor(): React.JSX.Element {
  const selectedId = useNotesStore((state) => state.selectedId)
  const title = useNotesStore((state) => state.title)
  const body = useNotesStore((state) => state.body)
  const dirty = useNotesStore((state) => state.dirty)
  const mode = useNotesStore((state) => state.mode)
  const saveState = useNotesStore((state) => state.saveState)
  const savedAt = useNotesStore((state) => state.savedAt)
  const saveError = useNotesStore((state) => state.saveError)
  const noteLoading = useNotesStore((state) => state.noteLoading)
  const setTitle = useNotesStore((state) => state.setTitle)
  const setBody = useNotesStore((state) => state.setBody)
  const setMode = useNotesStore((state) => state.setMode)
  const save = useNotesStore((state) => state.save)
  const retrySave = useNotesStore((state) => state.retrySave)
  const remove = useNotesStore((state) => state.remove)

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** 当前确认框对应的笔记 id：换笔记时在渲染期收掉确认框，不用 effect（lint 的 set-state-in-effect） */
  const [deleteTarget, setDeleteTarget] = useState(selectedId)

  if (deleteTarget !== selectedId) {
    setDeleteTarget(selectedId)
    setConfirmDelete(false)
  }

  if (selectedId === null) return <></>

  const onSave = (): void => {
    void save(true)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave()
    }
  }

  const onBodyKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    onKeyDown(event)
    if (event.defaultPrevented || event.key !== 'Tab' || event.shiftKey) return
    // plan §4.2：Tab 在正文里插两个空格，不抢焦点
    event.preventDefault()
    const textarea = event.currentTarget
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const next = `${body.slice(0, start)}  ${body.slice(end)}`
    setBody(next)
    requestAnimationFrame(() => {
      const current = bodyRef.current
      if (current === null) return
      current.setSelectionRange(start + 2, start + 2)
    })
  }

  const status =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'error'
        ? saveError === null
          ? '保存失败'
          : '保存失败'
        : dirty
          ? '未保存'
          : savedAt === null
            ? '已保存'
            : `已保存 ${clockLabel(savedAt)}`

  return (
    <div
      data-testid="note-editor"
      className="animate-fade-in [animation-duration:var(--motion-reveal)] mx-auto flex w-full max-w-[720px] flex-col px-10 py-8"
      onKeyDown={onKeyDown}
    >
      {noteLoading ? (
        <div data-testid="note-editor-loading" className="flex flex-col gap-3">
          <div className="h-8 w-2/3 animate-pulse rounded-control bg-hover" />
          <div className="h-4 w-full animate-pulse rounded-control bg-hover" />
          <div className="h-4 w-5/6 animate-pulse rounded-control bg-hover" />
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <input
              data-testid="note-title"
              aria-label="笔记标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="笔记标题"
              className="min-w-0 flex-1 bg-transparent text-[24px] leading-[32px] font-semibold text-ink outline-none placeholder:text-(--text-quaternary)"
            />
            <Dialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title="删除这篇笔记？"
              description="笔记文件会从数据目录里删掉，删除后不可恢复。"
              footer={
                <>
                  <Button
                    variant="ghost"
                    data-testid="notes-delete-cancel"
                    onClick={() => setConfirmDelete(false)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    data-testid="notes-delete-confirm"
                    onClick={() => {
                      setConfirmDelete(false)
                      void remove(selectedId)
                    }}
                  >
                    删除
                  </Button>
                </>
              }
            >
              <p className="text-b2 text-ink-secondary">确定要删除「{title}」吗？</p>
            </Dialog>
            <IconButton
              label="删除笔记"
              data-testid="notes-delete"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => setConfirmDelete(true)}
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              data-testid="notes-save-status"
              aria-live="polite"
              onClick={() => {
                if (saveState === 'error') void retrySave()
              }}
              className={
                saveState === 'error'
                  ? 'rounded-control px-1 py-0.5 text-c1 text-danger hover:underline'
                  : 'rounded-control px-1 py-0.5 text-c1 text-ink-tertiary hover:text-ink'
              }
            >
              {status}
              {saveState === 'error' ? ' · 重试' : ''}
            </button>
            <Segmented
              ariaLabel="编辑或预览"
              value={mode}
              onChange={(next) => setMode(next)}
              options={[
                { value: 'edit', label: '编辑', testId: 'notes-mode-edit' },
                { value: 'preview', label: '预览', testId: 'notes-mode-preview' }
              ]}
            />
          </div>

          {saveState === 'error' && saveError !== null ? (
            <p data-testid="notes-save-error" className="mt-1 text-c1 text-danger">
              {saveError}
            </p>
          ) : null}

          <div className="mt-4 min-h-0 flex-1">
            {mode === 'edit' ? (
              <textarea
                ref={bodyRef}
                data-testid="note-body"
                aria-label="笔记正文"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={onBodyKeyDown}
                placeholder="开始写…（Markdown）"
                spellCheck={false}
                className="min-h-[45vh] w-full resize-none bg-transparent font-sans text-[15px] leading-[27px] text-ink outline-none placeholder:text-(--text-quaternary)"
                style={{ caretColor: 'var(--accent)' }}
              />
            ) : (
              <div
                data-testid="note-preview"
                className="animate-fade-in [animation-duration:var(--motion-reveal)] min-h-[45vh] text-b1 text-ink"
              >
                {body.trim() === '' ? (
                  <p className="text-ink-tertiary">还没有正文。</p>
                ) : (
                  <TextPart text={body} />
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
