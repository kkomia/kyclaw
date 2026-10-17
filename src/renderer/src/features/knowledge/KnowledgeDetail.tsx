/**
 * 知识库右区详情：标题（可重命名）/ 元信息 / 正文预览 / 工具行（显示、删除）。
 *
 * 只读为主（v1 不编辑原件）；正文口径：
 *   - `.md` / `.markdown` → 复用现有 markdown 渲染（`DshMarkdownBody`，懒加载，含 KaTeX/CodeBlock），
 *     不新造第二套管线；
 *   - 其它文本（txt/json/csv/yaml/xml/html…）→ 纯文本按段落渲染（html 不执行、不解析）。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronLeft, FolderSearch, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { formatBytes, formatDateTime } from '@renderer/features/workbench/format'
import { useKnowledgeStore } from './knowledge-store'

/** markdown 正文按需加载（知识库页首次打开不背 KaTeX/Shiki 的分块成本） */
const MarkdownBody = lazy(async () => ({
  default: (await import('@renderer/features/workbench/preview/dsh-media/markdown-body'))
    .DshMarkdownBody
}))

/** 纯文本：按空行分段，段内保留换行（不解析 markdown/html） */
function PlainTextBody({ text }: { text: string }): React.JSX.Element {
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim() !== '')
  return (
    <div data-testid="knowledge-plain-text" className="flex flex-col gap-3">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-wrap text-b1 text-ink">
          {paragraph}
        </p>
      ))}
    </div>
  )
}

function isMarkdownExt(ext: string): boolean {
  return ext === 'md' || ext === 'markdown'
}

export function KnowledgeDetail({ onBack }: { onBack?: () => void }): React.JSX.Element | null {
  const documents = useKnowledgeStore((state) => state.documents)
  const selectedId = useKnowledgeStore((state) => state.selectedId)
  const text = useKnowledgeStore((state) => state.text)
  const textLoading = useKnowledgeStore((state) => state.textLoading)
  const textError = useKnowledgeStore((state) => state.textError)
  const textTruncated = useKnowledgeStore((state) => state.textTruncated)
  const rename = useKnowledgeStore((state) => state.rename)
  const remove = useKnowledgeStore((state) => state.remove)
  const reveal = useKnowledgeStore((state) => state.reveal)
  const select = useKnowledgeStore((state) => state.select)

  const doc = documents.find((item) => item.id === selectedId)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (renaming) titleInputRef.current?.select()
  }, [renaming])

  if (doc === undefined) {
    if (onBack === undefined) return null
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-b2 text-ink-secondary">
        选一篇资料查看正文。
      </div>
    )
  }

  const beginRename = (): void => {
    setTitleDraft(doc.title)
    setRenaming(true)
  }

  /** 提交重命名：空/没改 = 取消；改了才发 IPC */
  const commitRename = (): void => {
    if (!renaming) return
    setRenaming(false)
    const next = titleDraft.trim()
    if (next === '' || next === doc.title) return
    void rename(doc.id, next)
  }

  return (
    <div
      data-testid="knowledge-detail"
      data-document-id={doc.id}
      className="flex min-h-0 flex-1 flex-col"
    >
      {onBack === undefined ? null : (
        <button
          type="button"
          data-testid="knowledge-back"
          onClick={onBack}
          className="mx-6 mt-4 flex shrink-0 items-center gap-1 self-start rounded-control px-1.5 py-1 text-b2 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          返回列表
        </button>
      )}

      <div className="shrink-0 px-10 pt-6">
        <div className="mx-auto flex w-full max-w-[720px] items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            {renaming ? (
              <input
                ref={titleInputRef}
                data-testid="knowledge-rename-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitRename()
                  if (event.key === 'Escape') {
                    setRenaming(false)
                    setTitleDraft('')
                  }
                }}
                aria-label="资料标题"
                className="w-full min-w-0 border-0 bg-transparent p-0 text-t1 font-medium text-ink outline-none"
              />
            ) : (
              <h2
                data-testid="knowledge-detail-title"
                className="truncate text-t1 font-medium text-ink"
                title={doc.title}
                onDoubleClick={beginRename}
              >
                {doc.title}
              </h2>
            )}
            <p className="text-c1 text-ink-tertiary">
              {formatBytes(doc.size)} · {doc.charCount.toLocaleString('zh-CN')} 字 · 加入于{' '}
              {formatDateTime(doc.addedAt)}
            </p>
            <p
              data-testid="knowledge-source-path"
              title={doc.originalPath}
              className="max-w-full truncate font-mono text-c1 text-ink-tertiary"
            >
              来源：{doc.originalPath}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              data-testid="knowledge-rename-button"
              label="重命名"
              icon={<Pencil />}
              onClick={beginRename}
            />
            <IconButton
              data-testid="knowledge-reveal"
              label="在资源管理器中显示"
              icon={<FolderSearch />}
              onClick={() => void reveal(doc.id)}
            />
            <IconButton
              data-testid="knowledge-delete"
              label="删除"
              icon={<Trash2 />}
              onClick={() => setConfirmingDelete(true)}
              className="text-danger"
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-6">
        <div className="mx-auto w-full max-w-[720px]">
          {textLoading ? (
            <div data-testid="knowledge-text-loading" className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : textError !== null ? (
            <div data-testid="knowledge-text-error" role="alert" className="flex flex-col gap-3">
              <p className="text-b2 text-warning">{textError}</p>
              <Button size="sm" variant="ghost" onClick={() => select(doc.id)}>
                重试
              </Button>
            </div>
          ) : text.trim() === '' ? (
            <p data-testid="knowledge-text-empty" className="text-b2 text-ink-secondary">
              这篇资料没有可预览的文本。
            </p>
          ) : isMarkdownExt(doc.ext) ? (
            <div data-testid="knowledge-markdown-text">
              <Suspense
                fallback={
                  <div className="flex flex-col gap-3">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                  </div>
                }
              >
                <MarkdownBody text={text} />
              </Suspense>
            </div>
          ) : (
            <div data-testid="knowledge-text">
              <PlainTextBody text={text} />
            </div>
          )}
          {textTruncated ? (
            <p data-testid="knowledge-truncated" className="mt-4 text-c1 text-ink-tertiary">
              正文超过 2 MB，这里只显示前 2 MB；原文件在库里保持完整。
            </p>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="删除这份资料？"
        description="会从知识库里移除索引、副本与抽取文本，不可撤销；你电脑上的原文件不受影响。"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              取消
            </Button>
            <Button
              data-testid="knowledge-delete-confirm"
              size="sm"
              variant="danger"
              onClick={() => {
                setConfirmingDelete(false)
                void remove(doc.id)
              }}
            >
              删除
            </Button>
          </div>
        }
      >
        <p className="truncate text-b2 text-ink-secondary" title={doc.title}>
          {doc.title}
        </p>
      </Dialog>
    </div>
  )
}
