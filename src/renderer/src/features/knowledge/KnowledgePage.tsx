/**
 * 知识库模块（M5-B）v1：导入本机文本资料 → 列表/搜索 → 详情预览（只读）。
 *
 * 布局（plan §4.1）：内容卡内全宽 —— 顶部 band（标题 18/26 600 + 主按钮「导入资料」）+
 * 主体两栏（左列 300 `--bg-sidebar` + 1px hairline；右区详情 720 居中）。
 * 窄窗 <900：左列与右区**互斥**（列表 ⇄ 详情），详情里给「返回列表」；不引入路由变化。
 *
 * 空态（无资料）：右区衬线标题 + 一句 sans 说明 + 实物动作「导入资料」；不放插画（章程 §9.6）。
 * 数据全部经 `window.kyclaw.knowledge`（主进程闸门/磁盘动作），本页不碰 fs。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { KnowledgeDetail } from './KnowledgeDetail'
import { KnowledgeList } from './KnowledgeList'
import { useKnowledgeStore } from './knowledge-store'

/** 窄窗阈值：<900 左列收成"列表替换式"（plan §4.1） */
const NARROW_MAX_WIDTH = 900

/** 窗口宽度订阅（用 useSyncExternalStore 而不是 effect+setState：不产生级联渲染告警） */
function useNarrowLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('resize', onChange)
      return () => window.removeEventListener('resize', onChange)
    },
    () => window.innerWidth < NARROW_MAX_WIDTH,
    () => false
  )
}

export function KnowledgePage(): React.JSX.Element {
  const narrow = useNarrowLayout()
  const documents = useKnowledgeStore((state) => state.documents)
  const selectedId = useKnowledgeStore((state) => state.selectedId)
  const loaded = useKnowledgeStore((state) => state.loaded)
  const loading = useKnowledgeStore((state) => state.loading)
  const importing = useKnowledgeStore((state) => state.importing)
  const error = useKnowledgeStore((state) => state.error)
  const skipped = useKnowledgeStore((state) => state.skipped)
  const ensureLoaded = useKnowledgeStore((state) => state.ensureLoaded)
  const importDocuments = useKnowledgeStore((state) => state.importDocuments)
  const select = useKnowledgeStore((state) => state.select)
  const clearError = useKnowledgeStore((state) => state.clearError)
  const clearSkipped = useKnowledgeStore((state) => state.clearSkipped)

  useEffect(() => {
    void ensureLoaded()
  }, [ensureLoaded])

  const hasDocuments = documents.length > 0
  // 窄窗互斥：选中了就看详情，否则看列表；宽窗两栏都在
  const showList = !narrow || selectedId === null
  const showDetail = !narrow || selectedId !== null

  return (
    <section data-testid="knowledge-page" className="flex min-h-0 flex-1 flex-col">
      <header
        data-testid="knowledge-page-band"
        className="flex shrink-0 items-center justify-between gap-4 px-(--page-gutter) pt-5 pb-4"
      >
        <h1
          data-testid="knowledge-page-title"
          className="font-serif text-t1 font-semibold text-ink"
        >
          知识库
        </h1>
        <Button
          data-testid="knowledge-import"
          icon={<Upload />}
          loading={importing}
          disabled={importing}
          onClick={() => void importDocuments()}
        >
          导入资料
        </Button>
      </header>

      {error === null ? null : (
        <div
          data-testid="knowledge-error"
          role="alert"
          className="mx-(--page-gutter) mb-3 flex shrink-0 items-center justify-between gap-3 rounded-panel bg-warning-bg px-3 py-2 text-c1 text-warning"
        >
          <span>{error}</span>
          <IconButton
            data-testid="knowledge-error-dismiss"
            label="关闭错误提示"
            icon={<X />}
            onClick={clearError}
            className="size-6 border-0"
          />
        </div>
      )}

      {skipped.length === 0 ? null : (
        <div
          data-testid="knowledge-skipped"
          className="mx-(--page-gutter) mb-3 flex shrink-0 items-start justify-between gap-3 rounded-panel bg-secondary px-3 py-2 text-c1 text-ink-secondary"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span>有 {skipped.length} 个文件没有收进知识库：</span>
            <ul className="flex flex-col gap-0.5">
              {skipped.slice(0, 4).map((item, index) => (
                <li key={`${item.name}-${String(index)}`} className="truncate">
                  {item.name}：{item.reason}
                </li>
              ))}
              {skipped.length > 4 ? <li>……还有 {skipped.length - 4} 个</li> : null}
            </ul>
          </div>
          <IconButton
            data-testid="knowledge-skipped-dismiss"
            label="关闭导入结果"
            icon={<X />}
            onClick={clearSkipped}
            className="size-6 border-0"
          />
        </div>
      )}

      <div data-testid="knowledge-body" className="flex min-h-0 flex-1">
        <aside
          data-testid="knowledge-list-aside"
          hidden={!showList}
          className="flex w-(--sidebar-width) shrink-0 flex-col border-r border-(--seam-line) bg-(--bg-sidebar)"
        >
          <KnowledgeList />
        </aside>

        <div
          data-testid="knowledge-detail-area"
          hidden={!showDetail}
          className="flex min-h-0 flex-1 flex-col"
        >
          {!loaded && loading ? (
            <div data-testid="knowledge-loading" className="flex flex-1 flex-col gap-3 p-10">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : hasDocuments ? (
            <KnowledgeDetail onBack={narrow ? () => select(null) : undefined} />
          ) : (
            <EmptyKnowledge onImport={() => void importDocuments()} importing={importing} />
          )}
        </div>
      </div>
    </section>
  )
}

/** 空态：衬线一句话 + sans 说明 + 一个实物动作（导入资料）；不放插画 */
function EmptyKnowledge({
  onImport,
  importing
}: {
  onImport: () => void
  importing: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="knowledge-empty"
      className="animate-message-in flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center"
    >
      <h2 className="font-serif text-t1 text-ink">把读过的资料收进一个地方</h2>
      <p className="max-w-md text-b2 text-ink-secondary">
        支持 Markdown、纯文本、JSON、CSV
        等文本类文件；导入后可以按标题和正文搜索。原文件不会被改动。
      </p>
      <Button
        data-testid="knowledge-empty-import"
        icon={<Upload />}
        loading={importing}
        disabled={importing}
        onClick={onImport}
      >
        导入资料
      </Button>
    </div>
  )
}
