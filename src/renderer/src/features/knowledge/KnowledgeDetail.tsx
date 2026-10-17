/**
 * 知识库右区详情（task-95 美术层 · 资料夹页）：
 *   - 眉题「资料 · MD」+ 衬线标题（可重命名）+ mono meta（大小/字数/加入时间）；
 *   - 来源路径 = 索引卡的「来源槽」（mono、凹槽底、单行省略），不解释按钮；
 *   - 正文：`.md` 复用现有 markdown 渲染管线；其它文本按段落的 prose 声部；
 *   - 几何：统一 800 内容列（`content-column` + `px-page-gutter`，与设置/笔记同一条规则）——
 *     修复 1100 窗口下右缘比其它页多 16px 的问题（旧结构是 px 在 max-width 外层）。
 *   - 错误按章程 §9.6：danger 只用于文字/左边 2px 线，不整块红底。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ChevronLeft, FolderSearch, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { IconButton } from '@renderer/components/ui/icon-button'
import { DetailTitle } from '@renderer/components/ui/page-chrome'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { formatBytes, formatDateTime } from '@renderer/features/workbench/format'
import { useKnowledgeStore } from './knowledge-store'

/** markdown 正文按需加载（知识库页首次打开不背 KaTeX/Shiki 的分块成本） */
const MarkdownBody = lazy(async () => ({
  default: (await import('@renderer/features/workbench/preview/dsh-media/markdown-body'))
    .DshMarkdownBody
}))

/** 扩展名标签：md → MD（索引卡右上角的格式签） */
function kindOf(ext: string): string {
  return ext.trim().toUpperCase()
}

/** 纯文本：按空行分段，段内保留换行（不解析 markdown/html）；声部与 .md/主 chat 一致 = prose */
function PlainTextBody({ text }: { text: string }): React.JSX.Element {
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim() !== '')
  return (
    <div data-testid="knowledge-plain-text" className="flex flex-col gap-3">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-wrap font-prose text-b1 text-ink">
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
      <div
        data-testid="knowledge-select-hint"
        className="content-column flex min-h-full flex-col items-start justify-center gap-2 px-(--page-gutter) py-10"
      >
        <p className="font-serif text-t2 text-ink">选择一份资料</p>
        <p className="text-b2 text-ink-secondary">从左侧索引里点一份查看正文。</p>
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
        <div className="content-column shrink-0 px-(--page-gutter) pt-3">
          <button
            type="button"
            data-testid="knowledge-back"
            onClick={onBack}
            className="flex items-center gap-1 rounded-control px-1.5 py-1 text-b2 text-ink-secondary transition-colors duration-(--motion-feedback) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            返回列表
          </button>
        </div>
      )}

      {/* 资料夹页头：眉题 + 衬线标题 + mono meta + 来源槽（统一 800 内容列） */}
      <div className="shrink-0 pt-5">
        <div
          data-testid="knowledge-detail-header"
          className="content-column flex flex-col gap-3 px-(--page-gutter) pb-4"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <p
                data-testid="knowledge-detail-eyebrow"
                className="flex items-center gap-2 font-mono text-c1 text-ink-tertiary"
              >
                <span>资料</span>
                <span aria-hidden="true">·</span>
                <span data-testid="knowledge-detail-kind">{kindOf(doc.ext)}</span>
              </p>
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
                  className="ui-detail-title w-full min-w-0 border-0 border-b border-hairline bg-transparent p-0 pb-0.5 text-ink outline-none"
                />
              ) : (
                <DetailTitle
                  data-testid="knowledge-detail-title"
                  className="font-serif truncate"
                  title={doc.title}
                  onDoubleClick={beginRename}
                >
                  {doc.title}
                </DetailTitle>
              )}
              {/* meta：标签 sans、数字/大小/时间走 code 声部 + tabular（读数不跳宽） */}
              <p data-testid="knowledge-meta" className="text-c1 text-ink-tertiary tabular-nums">
                <span className="font-mono">{formatBytes(doc.size)}</span> ·{' '}
                <span className="font-mono">{doc.charCount.toLocaleString('zh-CN')}</span> 字 ·
                加入于 <span className="font-mono">{formatDateTime(doc.addedAt)}</span>
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
              <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-hairline" />
              <IconButton
                data-testid="knowledge-delete"
                label="删除"
                icon={<Trash2 />}
                onClick={() => setConfirmingDelete(true)}
                className="text-danger"
              />
            </div>
          </div>

          <div
            data-testid="knowledge-source-path"
            title={doc.originalPath}
            className="flex min-w-0 items-center gap-2 rounded-control bg-secondary px-2.5 py-1.5"
          >
            <span className="shrink-0 font-mono text-[10px] leading-[14px] text-ink-tertiary">
              来源
            </span>
            <span className="truncate font-mono text-c1 text-ink-tertiary">{doc.originalPath}</span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="content-column border-t border-hairline px-(--page-gutter) pt-5 pb-10">
          {textLoading ? (
            <div data-testid="knowledge-text-loading" className="flex flex-col gap-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : textError !== null ? (
            <div
              data-testid="knowledge-text-error"
              role="alert"
              className="flex flex-col items-start gap-2 rounded-control border-l-2 border-warning bg-secondary px-3 py-2"
            >
              <p className="text-b2 text-ink-secondary">{textError}</p>
              <Button size="sm" variant="ghost" onClick={() => select(doc.id)}>
                重试
              </Button>
            </div>
          ) : text.trim() === '' ? (
            <p
              data-testid="knowledge-text-empty"
              className="rounded-control border-l-2 border-hairline bg-secondary px-3 py-2 text-b2 text-ink-secondary"
            >
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
