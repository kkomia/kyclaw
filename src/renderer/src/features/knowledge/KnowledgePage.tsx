/**
 * 知识库模块（M5-B）v1：导入本机文本资料 → 列表/搜索 → 详情预览（只读）。
 *
 * 美术方向（task-95 · 资料馆/索引卡，与笔记同族但可区分）：
 *   - 顶栏 48 高、hairline 收口：衬线「知识库」+ mono 计数/体积（读数声部）+ 克制的导入主按钮；
 *   - 列表 = 索引抽屉：搜索框是抽屉头，行是索引卡（标题 + 扩展名标签 + mono 时间/大小，hairline 分隔）；
 *   - 详情 = 资料夹页：眉题「资料 · MD」+ 衬线标题 + mono meta + 来源路径槽（mono）+ 正文；
 *   - 空态 = 一句衬线邀请 + 支持格式的索引标签 + 实物动作（不放插画，章程 §9.6）；
 *   - 错误条按章程 9.6：danger 只用于图标/左边 2px 线，不整块红底。
 *
 * 布局（plan §4.1；几何不重排）：内容卡内全宽 —— 顶部 band + 主体两栏（左列 240
 * `--bg-sidebar` + 1px hairline；右区详情按统一 800 内容列规则居中）。
 * 窄窗 <900：左列与右区**互斥**（列表 ⇄ 详情），详情里给「返回列表」；不引入路由变化。
 * 数据全部经 `window.kyclaw.knowledge`（主进程闸门/磁盘动作），本页不碰 fs。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { EmptyState, PageMeta, PageTitle } from '@renderer/components/ui/page-chrome'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { formatBytes } from '@renderer/features/workbench/format'
import { KnowledgeDetail } from './KnowledgeDetail'
import { KnowledgeList } from './KnowledgeList'
import { useKnowledgeStore } from './knowledge-store'
import './knowledge.css'

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
  const totalBytes = documents.reduce((sum, doc) => sum + doc.size, 0)
  // 窄窗互斥：选中了就看详情，否则看列表；宽窗两栏都在
  const showList = !narrow || selectedId === null
  const showDetail = !narrow || selectedId !== null

  return (
    <section data-testid="knowledge-page" className="flex min-h-0 flex-1 flex-col">
      {/* 顶栏：与笔记页同一族（48 高 + hairline），但右侧只给计数/体积与导入 —— 不重复说明按钮 */}
      <header
        data-testid="knowledge-page-band"
        className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-hairline px-(--page-gutter)"
      >
        <div className="flex min-w-0 items-baseline gap-2.5">
          <PageTitle data-testid="knowledge-page-title">知识库</PageTitle>
          <PageMeta data-testid="knowledge-page-meta" className="truncate">
            共 {documents.length} 份{totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
          </PageMeta>
        </div>
        <Button
          data-testid="knowledge-import"
          size="sm"
          icon={<Upload aria-hidden="true" />}
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
          className="mx-(--page-gutter) mt-3 flex shrink-0 items-center justify-between gap-3 rounded-control border-l-2 border-warning bg-secondary px-3 py-2 text-b2 text-ink-secondary"
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
          className="mx-(--page-gutter) mt-3 flex shrink-0 items-start justify-between gap-3 rounded-control border-l-2 border-hairline bg-secondary px-3 py-2 text-c1 text-ink-secondary"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span>有 {skipped.length} 个文件没有收进知识库：</span>
            <ul className="flex flex-col gap-0.5">
              {skipped.slice(0, 4).map((item, index) => (
                <li key={`${item.name}-${String(index)}`} className="truncate">
                  <span className="font-mono">{item.name}</span>：{item.reason}
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
            <div
              data-testid="knowledge-loading"
              className="content-column flex flex-1 flex-col gap-3 px-(--page-gutter) py-10"
            >
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

/**
 * 空态（统一模板 task-100）：mono 眉题 + 衬线 22/30 邀请 + 一句说明 + 真实格式标签（≤3）+ 实物动作。
 * 不放插画/吉祥物；眉题不是第二个页名，只提示「这里是资料索引」。
 */
function EmptyKnowledge({
  onImport,
  importing
}: {
  onImport: () => void
  importing: boolean
}): React.JSX.Element {
  return (
    <EmptyState
      data-testid="knowledge-empty"
      eyebrow="资料索引"
      title="把读过的资料收进一个地方"
      description="支持 Markdown、纯文本等文本文件；导入后可按标题和正文搜索，原文件不会被改动。"
      tags={['Markdown', 'TXT', 'JSON']}
      tagsTestId="knowledge-empty-kinds"
      action={
        <Button
          size="sm"
          data-testid="knowledge-empty-import"
          icon={<Upload aria-hidden="true" />}
          loading={importing}
          disabled={importing}
          onClick={onImport}
        >
          导入资料
        </Button>
      }
    />
  )
}
