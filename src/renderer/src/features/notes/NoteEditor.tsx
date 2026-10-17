import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Segmented } from '@renderer/components/ui/segmented'
import { TextPart } from '@renderer/features/chat/parts/TextPart'
import { useNotesStore } from './notes-store'
import { clockLabel } from './notes-format'

/**
 * 右区编辑器（task-94 美术层）：**一张有页眉的稿纸**。
 *
 * 标题层（衬线 27）→ 信头细线（保存态 · 字数 · 编辑⇄预览）→ 正文（prose 声部，44em 阅读宽）。
 * 预览沿用 chat 的 Markdown 管线（TextPart），只换页面框。自动保存 debounce 在 store（600ms）；
 * 这里只负责 Ctrl+S、Tab 两空格、编辑⇄预览、删除确认与「新建后标题聚焦」。
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
  /** task-89：新建笔记后把焦点放进标题（store 里的一次性请求序号） */
  const titleFocusSeq = useNotesStore((state) => state.titleFocusSeq)
  const clearTitleFocus = useNotesStore((state) => state.clearTitleFocus)

  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (titleFocusSeq === 0) return
    // 新笔记已由 create() 选中并渲染出标题；聚焦后立刻消费序号，正常切换笔记不再抢焦点
    titleRef.current?.focus()
    clearTitleFocus()
  }, [titleFocusSeq, clearTitleFocus])

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

  const statusState =
    saveState === 'saving' ? 'saving' : saveState === 'error' ? 'error' : dirty ? 'dirty' : 'saved'

  // 稿纸读数：正文非空白字符数（真实值，不是占位）
  const wordCount = body.replace(/\s+/g, '').length

  return (
    <div data-testid="note-editor" className="np-sheet" onKeyDown={onKeyDown}>
      {noteLoading ? (
        <div data-testid="note-editor-loading" className="np-editor-loading">
          <div className="np-loading-title" />
          <div className="np-loading-meta" />
          <div className="np-loading-line" />
          <div className="np-loading-line" />
          <div className="np-loading-line" />
        </div>
      ) : (
        <>
          <div className="np-sheet-head">
            <input
              ref={titleRef}
              data-testid="note-title"
              aria-label="笔记标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="笔记标题"
              className="np-title font-serif"
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
              className="np-delete"
              icon={<Trash2 aria-hidden="true" />}
              onClick={() => setConfirmDelete(true)}
            />
          </div>

          <div className="np-toolbar">
            <div className="np-toolbar-left">
              <button
                type="button"
                data-testid="notes-save-status"
                data-state={statusState}
                aria-live="polite"
                onClick={() => {
                  if (saveState === 'error') void retrySave()
                }}
                className="np-status-button"
              >
                <span className="np-status-dot" aria-hidden="true" />
                <span>
                  {status}
                  {saveState === 'error' ? ' · 重试' : ''}
                </span>
              </button>
              <span className="np-words tabular-nums" data-testid="note-word-count">
                {wordCount} 字
              </span>
            </div>
            <div className="np-toolbar-right">
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
          </div>

          {saveState === 'error' && saveError !== null ? (
            <p data-testid="notes-save-error" className="np-save-error">
              {saveError}
            </p>
          ) : null}

          <div className="np-body-wrap">
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
                className="np-body font-prose"
                style={{ caretColor: 'var(--accent)' }}
              />
            ) : (
              <div
                data-testid="note-preview"
                className="np-preview animate-fade-in [animation-duration:var(--motion-reveal)]"
              >
                {body.trim() === '' ? (
                  <p className="np-preview-empty">还没有正文。</p>
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
