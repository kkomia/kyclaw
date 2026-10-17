/**
 * Office 底部状态栏（A4）。
 *
 * 数据**全部来自壳真值**（不新增协议）：
 *   - 文档名/类型：`tab.title` / `loaded.info.displayName` + `tab.kind`；
 *   - 页数：面 `doc:loaded` 回传的页数（`OfficeWorkspace.pageCount`），无则「—」；
 *   - 保存态：`tab.dirty`（store 投影）+ 保存状态机的 `onSavingChange`（saving，真实写盘信号）
 *     → 已保存 / 未保存修改 / 保存中…；`tab.readOnly` → 只读；
 *   - 「保存中」只在拿到真实信号时显示，不做乐观假态（A2 QAT 的 1.5s 乐观窗口保留，task-30 统一收口）。
 *
 * 视觉：高度 `--office-status-height`（A2 已登记，深浅同值）；数字/类型/快捷键一律 mono + tabular-nums；
 * 换词动效用共享的 `office-save-swap.css`（与面内 QAT 同一份定义）。
 *
 * 布局：由 `OfficeWorkspace` 作为 workspace 的最后一个 flex 子项渲染 → 横跨「画布 + AI 面板」整行下方。
 */
import { OFFICE_KIND_ICON, OFFICE_KIND_LABEL } from './office-kinds'
import type { OfficeTabKind } from './office-tabs-store'
import { cn } from '@renderer/components/ui/cn'
import '../../office/office-save-swap.css'

export type OfficeStatusSaveState = 'saved' | 'dirty' | 'saving' | 'readonly'

export interface OfficeStatusBarProps {
  /** 文档显示名（`loaded.info.displayName` 优先，其次 tab.title） */
  documentName: string
  kind: OfficeTabKind
  /** 面 `doc:loaded` 回传的总页数；0 = 还没拿到 */
  pageCount: number
  dirty: boolean
  /** 保存状态机的真实 writing 信号（不是乐观推断） */
  saving: boolean
  readOnly: boolean
}

const SAVE_LABEL: Record<OfficeStatusSaveState, string> = {
  saved: '已保存',
  dirty: '未保存修改',
  saving: '保存中…',
  readonly: '只读'
}

const SAVE_DOT_CLASS: Record<OfficeStatusSaveState, string> = {
  saved: 'bg-(--text-quaternary)',
  dirty: 'bg-warning',
  saving: 'bg-(--accent)',
  readonly: 'bg-(--text-quaternary)'
}

function saveStateOf(props: OfficeStatusBarProps): OfficeStatusSaveState {
  if (props.readOnly) return 'readonly'
  if (props.saving) return 'saving'
  if (props.dirty) return 'dirty'
  return 'saved'
}

export function OfficeStatusBar({
  documentName,
  kind,
  pageCount,
  dirty,
  saving,
  readOnly
}: OfficeStatusBarProps): React.JSX.Element {
  const Icon = OFFICE_KIND_ICON[kind]
  const state = saveStateOf({ documentName, kind, pageCount, dirty, saving, readOnly })
  const label = SAVE_LABEL[state]

  return (
    <footer
      data-testid="office-statusbar"
      data-kind={kind}
      data-dirty={dirty ? 'true' : 'false'}
      data-saving={saving ? 'true' : 'false'}
      data-readonly={readOnly ? 'true' : 'false'}
      data-save-state={state}
      aria-label="文档状态栏"
      className="flex h-(--office-status-height) shrink-0 items-center gap-3 border-t border-hairline bg-surface px-3 text-c1 text-ink-tertiary-readable select-none"
    >
      {/* 左：文档名 + 类型（类型是技术标签 → mono + tabular-nums） */}
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden="true" className="size-(--icon-size-sm) shrink-0" />
        {/* task-100 R1：文档名一屏最多 2 处（标签页 + ribbon）；状态栏只保留语义（sr-only） */}
        <span data-testid="office-status-doc-title" className="sr-only" title={documentName}>
          {documentName}
        </span>
        <span
          className="shrink-0 rounded-badge bg-selected px-1.5 py-0.5 font-mono text-c2 tabular-nums text-ink-tertiary"
          title={OFFICE_KIND_LABEL[kind]}
        >
          {kind}
        </span>
      </span>

      {/* 右：页数 / 只读标记 / 保存态 */}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span
          data-testid="office-status-pages"
          data-pages={pageCount > 0 ? String(pageCount) : '0'}
          className="font-mono tabular-nums"
          title="总页数（来自 doc:loaded）"
        >
          {pageCount > 0 ? `共 ${pageCount} 页` : '—'}
        </span>
        {readOnly ? (
          <span
            data-testid="office-status-readonly"
            className="rounded-badge border-(length:--hairline-width) border-hairline px-1.5 py-0.5 text-c2"
            title="文档以只读方式打开"
          >
            只读
          </span>
        ) : null}
        <span
          data-testid="office-status-save"
          data-state={state}
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5"
          title={SAVE_LABEL[state]}
        >
          <span aria-hidden="true" className={cn('size-1.5 rounded-full', SAVE_DOT_CLASS[state])} />
          {/* key = 文案：换态时重挂 → 触发 office-save-swap 的换词动画（与面内 QAT 同一套 CSS） */}
          <span key={label} className="office-save-swap">
            {label}
          </span>
        </span>
      </span>
    </footer>
  )
}
