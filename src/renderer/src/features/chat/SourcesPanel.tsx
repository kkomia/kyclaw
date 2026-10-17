/**
 * 助手消息的网页来源（0.1.3；返工后入口与动作行同一排）。
 *
 * 数据由 `Message` 从**本轮正文**提取（首次顺序、按规范化 URL 去重，且只收命中工具结果
 * allowlist 的 URL）；这里只负责入口按钮与展开列表。流式期间 `Message` 不传来源，
 * 因此入口整个不出现。
 *
 * 布局（用户口径）：
 *   - 入口是一枚**图标按钮**（与「复制 / 重新生成」同一个 `MessageAction`），放在动作行里，
 *     **绝不出现「引用」字样**；`aria-label` 带条数（「来源（N）」），视觉上只有一枚 Globe；
 *   - 展开后的列表仍留在消息末尾（动作行上方），入口点击只 toggle，不抢复制 / 重新生成的动作；
 *   - 每项仍是真实外链（`target="_blank"` → 主进程 `shell.openExternal`）。
 *
 * 列表语义：用 `<ul>` 而不是 `<ol>` —— 可见编号是**模型给的来源编号**（可能 2、1），
 * 浏览器/读屏自动生成的序号会再数一遍。编号 badge 对读屏隐藏，完整语义放进链接的
 * `aria-label`（「来源 2：标题（host）」）。站点视觉用本地 `SiteMark`，不加载远程 favicon。
 */
import { useId, useState } from 'react'
import { Globe } from 'lucide-react'
import type { Citation } from './citations'
import { MessageAction } from './MessageActions'
import { SiteMark } from './parts/SiteMark'

export interface SourcesActionProps {
  sources: readonly Citation[]
  /** 列表是否展开（由 Message 持有，入口与列表共用这一份状态） */
  open: boolean
  onToggle: () => void
  /** 展开列表的 id（`aria-controls` 用；由 Message 生成） */
  listId: string
}

/**
 * 动作行里的来源入口（icon-only）。
 * 用固定标签「来源（N）」+ `aria-expanded` 表达开合；视觉上只有 Globe 图标与图标钮的热区。
 */
export function SourcesAction({
  sources,
  open,
  onToggle,
  listId
}: SourcesActionProps): React.JSX.Element | null {
  if (sources.length === 0) return null
  const label = `来源（${sources.length}）`
  return (
    <MessageAction
      testId="sources-toggle"
      label={label}
      onClick={onToggle}
      ariaExpanded={open}
      ariaControls={open ? listId : undefined}
    >
      <Globe aria-hidden="true" className="size-4" />
    </MessageAction>
  )
}

export interface SourcesPanelProps {
  sources: readonly Citation[]
  /**
   * 受控展开态（与动作行里的 `SourcesAction` 共用；由 Message 持有）。
   * **省略 = 兼容旧的独立用法**：面板自己渲染一枚 icon-only 入口并自管开合
   * （0.1.3 返工中 Message.tsx 正被图片改动占用，入口搬进动作行的接线待协调后再切）。
   */
  open?: boolean
  /** 展开列表的 id（省略时自己生成） */
  listId?: string
}

/**
 * 来源列表。受控时只画列表（入口在动作行）；省略 `open` 的旧用法在面板内自带入口，
 * 保证未接线的宿主仍能开合，且入口同样是 icon-only、不出现「引用」字样。
 */
export function SourcesPanel({
  sources,
  open: openProp,
  listId
}: SourcesPanelProps): React.JSX.Element | null {
  const fallbackId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [internalOpen, setInternalOpen] = useState(false)
  if (sources.length === 0) return null
  const controlled = openProp !== undefined
  const open = controlled ? openProp : internalOpen
  // 受控且关着：入口在动作行，列表整段不渲染（不留空壳节点）
  if (controlled && !open) return null
  const listIdResolved = listId ?? `sources-list-${fallbackId}`

  return (
    <section data-testid="sources-panel" aria-label="来源" className="flex flex-col gap-1.5">
      {controlled ? null : (
        <SourcesAction
          sources={sources}
          open={open}
          onToggle={() => setInternalOpen((value) => !value)}
          listId={listIdResolved}
        />
      )}
      {open ? (
        <ul
          id={listIdResolved}
          data-testid="sources-list"
          className="m-0 flex list-none flex-col gap-1.5 p-0"
        >
          {sources.map((source, index) => {
            const title = source.title ?? source.host
            const showHost = source.title !== undefined && source.title !== source.host
            const ariaLabel =
              source.title === undefined || source.title === source.host
                ? `来源 ${source.label}：${source.host}`
                : `来源 ${source.label}：${source.title}（${source.host}）`
            return (
              <li
                key={`${source.url}-${index}`}
                data-testid="source-item"
                className="flex items-start gap-1.5"
              >
                <SiteMark host={source.host} className="mt-0.5" />
                <span
                  data-testid="source-label"
                  aria-hidden="true"
                  className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-pill bg-selected text-c2 font-medium text-ink-secondary"
                >
                  {source.label}
                </span>
                <a
                  data-testid="source-link"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  title={source.title ?? source.url}
                  aria-label={ariaLabel}
                  className="min-w-0 flex-1 rounded-button-sm text-ink hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text"
                >
                  <span className="block truncate text-b2">{title}</span>
                  {showHost ? (
                    <span className="block truncate text-c1 text-ink-tertiary">{source.host}</span>
                  ) : null}
                </a>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
