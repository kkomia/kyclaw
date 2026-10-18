import { useMemo, useRef, useState } from 'react'
import { SectionTitle } from '@renderer/components/ui/page-chrome'
import { useNewTabPointer } from './use-newtab-pointer'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import type { NewTabController } from './use-newtab-controller'
import './newtab.css'

/**
 * 新标签页 · 方向 C「格物表 / Lattice」视觉层（task-89 落地；DESIGN §5 + mock lattice）。
 *
 * 六个元素格：三个亮格（W/N/O = 新建 Word / 写笔记 / 打开 Word，真动作）+ 三个灰格
 * （S/P/B = v2 未来位：虚线 + 斜线 + v2 徽标，`div`/`aria-disabled`/不进 Tab/无假动作）。
 * 右栏「继续」= 真实打开的文档读数（≤5）；容量 5 个标签槽；顶部 96×2 量尺、每格 24×2 元素条。
 * 灰格可一键收起（宽窗按钮；≤900 CSS 自动收起并显示一行 v2 说明）。
 *
 * **所有行为/数据来自 `useNewtabController`**（键盘 1/2/3、Esc、焦点、容量、错误、pending），
 * 本文件只画。视觉层可整体替换（A/B 方向）而不动 controller / AppTabBar / OfficePage。
 */
const BAND_COLS = 96
const CELL_BAND_COLS = 24

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 顶部 96×2 量尺：中心亮两端收；hot 列用 accent */
function TopBand(): React.JSX.Element {
  const spans = useMemo(() => {
    const out: Array<{ opacity: number; delay: string; hot: boolean }> = []
    for (let i = 0; i < BAND_COLS * 2; i += 1) {
      const col = Math.floor(i / 2)
      const t = col / (BAND_COLS - 1)
      out.push({
        opacity: Number((0.08 + 0.46 * Math.pow(Math.sin(Math.PI * t), 1.5)).toFixed(3)),
        delay: `${-(i * 43) % 3800}ms`,
        hot: Math.abs(t - 0.5) < 0.035
      })
    }
    return out
  }, [])

  return (
    <div className="lt-band" aria-hidden="true">
      {spans.map((span, index) => (
        <span
          key={index}
          style={{ opacity: span.opacity, animationDelay: span.delay }}
          data-hot={span.hot ? '1' : undefined}
        />
      ))}
    </div>
  )
}

/** 每格底部 24×2 元素条：左暗右亮；hover 时按列错相扫过 */
function CellBand({ primary }: { primary: boolean }): React.JSX.Element {
  const spans = useMemo(() => {
    const out: Array<{ opacity: number; delay: string; waveDelay: string }> = []
    for (let i = 0; i < CELL_BAND_COLS * 2; i += 1) {
      const col = Math.floor(i / 2)
      const t = col / (CELL_BAND_COLS - 1)
      out.push({
        opacity: Number((0.14 + 0.46 * Math.pow(t, 1.5)).toFixed(3)),
        delay: `${-(i * 51) % 3400}ms`,
        waveDelay: `${col * 14}ms`
      })
    }
    return out
  }, [])

  return (
    <span className={`lt-bandcell${primary ? ' lt-bandcell--primary' : ''}`} aria-hidden="true">
      {spans.map((span, index) => (
        <span
          key={index}
          style={
            {
              opacity: span.opacity,
              animationDelay: span.delay,
              '--d': span.waveDelay
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  )
}

interface RealCell {
  id: 'create' | 'note' | 'open'
  keycap: '1' | '2' | '3'
  symbol: string
  index: string
  name: string
  meta: string
  testId: string
  primary: boolean
  pendingKey: 'blank' | 'note' | 'open'
  onRun: () => void
  disabled: boolean
  describedBy?: string
}

const FUTURE_CELLS = [
  { id: 'xlsx', symbol: 'S', index: '04', name: '新建表格' },
  { id: 'pptx', symbol: 'P', index: '05', name: '新建演示文稿' },
  { id: 'web', symbol: 'B', index: '06', name: '打开网页' }
] as const

const PENDING_TEXT: Record<'blank' | 'note' | 'open', string> = {
  blank: '正在新建空白文档…',
  note: '正在新建笔记…',
  open: '正在选择 Word 文档…'
}

export function NewTabView(controller: NewTabController): React.JSX.Element {
  const {
    pageRef,
    today,
    todayLabel,
    todayIso,
    pending,
    busy,
    pageError,
    block,
    recent,
    relativeTimeOf,
    onKeyDown,
    createDocument,
    writeNote,
    openDocument,
    openRecent
  } = controller
  // 背景格子点阵 + 点击涟漪（视觉层）：reduced/触摸设备不挂监听（见 use-newtab-pointer.ts）
  const latticeCanvasRef = useRef<HTMLCanvasElement>(null)
  useNewTabPointer(pageRef, latticeCanvasRef)
  const [showFuture, setShowFuture] = useState(true)

  const weekday = WEEKDAYS[today.getDay()] ?? ''
  const state =
    pending !== null ? 'busy' : pageError?.where === 'start' ? 'error' : block ? 'capacity' : 'idle'

  const realCells: RealCell[] = [
    {
      id: 'create',
      keycap: '1',
      symbol: 'W',
      index: '01',
      name: '新建 Word 文档',
      meta: '空白 .docx',
      testId: 'npw-create-docx',
      primary: true,
      pendingKey: 'blank',
      onRun: createDocument,
      disabled: busy || block !== null,
      describedBy: 'npw-create-desc'
    },
    {
      id: 'note',
      keycap: '2',
      symbol: 'N',
      index: '02',
      name: '写笔记',
      meta: 'Markdown · 本地',
      testId: 'npw-note',
      primary: false,
      pendingKey: 'note',
      onRun: writeNote,
      disabled: busy
    },
    {
      id: 'open',
      keycap: '3',
      symbol: 'O',
      index: '03',
      name: '打开 Word 文档…',
      meta: '本地选择器 · .docx',
      testId: 'npw-open-docx',
      primary: false,
      pendingKey: 'open',
      onRun: openDocument,
      disabled: busy || block !== null
    }
  ]

  return (
    <section
      ref={pageRef}
      data-testid="newtab-page"
      className="lt"
      data-state={state}
      data-future={showFuture ? 'on' : 'off'}
      tabIndex={-1}
      aria-label="新标签页"
      onKeyDown={onKeyDown}
    >
      <div className="lt-bg" aria-hidden="true">
        <div className="lt-field" />
        <canvas ref={latticeCanvasRef} data-testid="npw-lattice" className="lt-lattice" />
      </div>

      {/* 页眉：字标 + 新标签页 + 真实日期 + Esc */}
      <header className="lt-top">
        <div className="lt-crumb">
          <span className="lt-wordmark">
            <b>&lt;</b>kyclaw<b>&gt;</b>
          </span>
          <span className="lt-top-rule" aria-hidden="true" />
          <span className="lt-top-label">新标签页</span>
        </div>
        <div className="lt-right">
          <time className="lt-date" data-testid="npw-date" dateTime={todayIso}>
            {todayLabel} · {weekday}
          </time>
        </div>
      </header>

      <TopBand />

      <div className="lt-main">
        <section
          className="lt-left"
          data-testid="npw-start"
          data-npw-group="start"
          aria-labelledby="npw-start-title"
        >
          <div className="lt-sec-head-wrap">
            <div className="lt-sec-head">
              <SectionTitle className="lt-sec-title" id="npw-start-title">
                开始
              </SectionTitle>
              <button
                type="button"
                className="lt-future-toggle"
                data-testid="npw-future-toggle"
                aria-expanded={showFuture}
                onClick={() => setShowFuture((value) => !value)}
              >
                {showFuture ? '收起未来位' : '显示未来位'}
              </button>
            </div>
          </div>

          <div className="lt-grid" role="group" aria-label="开始动作">
            {realCells.map((cell) => {
              const isPending = pending === cell.pendingKey
              return (
                <button
                  key={cell.id}
                  type="button"
                  data-testid={cell.testId}
                  data-npw-item
                  aria-keyshortcuts={cell.keycap}
                  aria-describedby={cell.describedBy}
                  disabled={cell.disabled}
                  onClick={cell.onRun}
                  className={[
                    'lt-cell',
                    cell.primary ? 'lt-cell--primary' : '',
                    isPending ? 'is-busy' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="lt-watermark" aria-hidden="true">
                    {cell.symbol}
                  </span>
                  <span className="lt-cell-top">
                    <span className="lt-symbol" aria-hidden="true">
                      {isPending ? <span className="lt-spinner" /> : cell.symbol}
                    </span>
                    <span className="lt-idx" aria-hidden="true">
                      {cell.index}
                    </span>
                  </span>
                  <span className="lt-name">{cell.name}</span>
                  <span className="lt-meta" id={cell.describedBy}>
                    <span>{isPending ? PENDING_TEXT[cell.pendingKey] : cell.meta}</span>
                    <kbd className="lt-kbd">{cell.keycap}</kbd>
                  </span>
                  <CellBand primary={cell.primary} />
                </button>
              )
            })}

            {FUTURE_CELLS.map((cell) => (
              <div
                key={cell.id}
                className="lt-cell lt-cell--future"
                data-testid={`npw-future-${cell.id}`}
                aria-disabled="true"
                title="v2 未接入"
              >
                <span className="lt-watermark" aria-hidden="true">
                  {cell.symbol}
                </span>
                <span className="lt-cell-top">
                  <span className="lt-symbol" aria-hidden="true">
                    {cell.symbol}
                  </span>
                  <span className="lt-idx" aria-hidden="true">
                    {cell.index}
                  </span>
                </span>
                <span className="lt-name">{cell.name}</span>
                <span className="lt-meta">
                  <span className="lt-v2">v2</span>
                </span>
              </div>
            ))}
          </div>

          {/* 灰格收起（宽窗开关）/ 窄窗一行说明（CSS ≤900 自动显示） */}
          <div className="lt-future-note" data-testid="npw-future-note">
            <span className="lt-v2">v2</span>
            <span>表格 / 演示文稿 / 网页</span>
          </div>

          {pending === null ? null : (
            <div
              className="lt-status lt-status--busy"
              data-testid="npw-busy"
              role="status"
              aria-live="polite"
            >
              <span className="lt-pulse" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>{PENDING_TEXT[pending]}</span>
            </div>
          )}
          {pageError?.where === 'start' ? (
            <div className="lt-status lt-status--error" data-testid="npw-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{pageError.message}</span>
            </div>
          ) : null}
          {block === null ? null : (
            <div className="lt-status lt-status--capacity" data-testid="npw-capacity" role="status">
              <TriangleAlert aria-hidden="true" />
              <span>{block.message}</span>
            </div>
          )}
        </section>

        <aside className="lt-rail" data-testid="npw-recent" aria-labelledby="npw-recent-title">
          <div className="lt-rail-head">
            <SectionTitle className="lt-rail-title" id="npw-recent-title">
              继续
            </SectionTitle>
          </div>
          <p className="lt-rail-sub">开着的文档 · 按上次打开排序</p>

          {recent.length === 0 ? (
            <div className="lt-empty" data-testid="npw-recent-empty">
              <span className="lt-empty-title">还没有打开的文档</span>
              <span className="lt-empty-sub">新建或打开一份，它会占一格。</span>
            </div>
          ) : (
            <div
              className="lt-list"
              role="group"
              aria-label="继续打开的文档"
              data-npw-group="recent"
            >
              {recent.map((tab, index) => {
                const time = relativeTimeOf(tab)
                const label = `${tab.title}，${tab.kind}，${time}${tab.dirty ? '，未保存' : ''}`
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className="lt-doc"
                    data-testid={`npw-recent-${tab.id}`}
                    data-npw-item
                    title={tab.title}
                    aria-label={label}
                    onClick={() => openRecent(tab.id)}
                  >
                    <span className="lt-idx2" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="lt-doc-title">
                      <span className="nm">{tab.title}</span>
                      {tab.dirty ? (
                        <span className="lt-doc-dot" aria-hidden="true" title="未保存修改" />
                      ) : null}
                    </span>
                    <span className="lt-doc-meta">
                      {time}
                      {tab.dirty ? ' · 未保存' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {pageError?.where === 'recent' ? (
            <div
              className="lt-status lt-status--error lt-status--recent"
              data-testid="npw-recent-error"
              role="alert"
            >
              <CircleAlert aria-hidden="true" />
              <span>{pageError.message}</span>
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="lt-foot">
        <span className="lt-foot-hint" aria-label="关闭新标签页">
          <kbd className="lt-kbd">Esc</kbd>
          <span className="sr-only">关闭新标签页</span>
        </span>
      </footer>
    </section>
  )
}

/* 行为/数据契约由 controller 定义；本文件只负责画（A/B 方向可整体替换本文件） */
