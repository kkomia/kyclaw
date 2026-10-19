/**
 * Excel（xlsx）查找条：`@betteroffice/xlsx-react` 的 `searchMenus` 命令**只回调宿主**
 * （`onSearchMenus`），查找 UI 得我们自己出；真正的搜索能力在上游 `XlsxEditorApi.findText`
 * （`@betteroffice/xlsx/**`：`XlsxFindRequest{text,limit}` → `{ok,matches:[{cell:{sheetId,row,col,a1},text}],truncated}`）。
 *
 * 这个组件只做「输入 → 结果 → 上/下一个 → 定位」的交互，不直接碰内核：
 * 搜索与定位都由 pane 注入（便于单测，也把 wasm 依赖留在 pane 一层）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface XlsxFindMatch {
  a1: string
  text: string
  sheetId: string
  row: number
  col: number
}

export type XlsxFindOutcome =
  { ok: true; matches: XlsxFindMatch[]; truncated: boolean } | { ok: false; message: string }

export interface XlsxFindBarProps {
  open: boolean
  onClose: () => void
  /** 由 pane 实现：调 `api.findText`（空串由本组件拦截，不会传进来） */
  search: (text: string) => Promise<XlsxFindOutcome>
  /** 由 pane 实现：选中并滚动到该匹配（`api.selectCells`） */
  onNavigate: (match: XlsxFindMatch, index: number) => void
}

/** 输入停止后多久开始查（ms）：既不打字每个字符都查，也不至于明显卡顿 */
export const XLSX_FIND_DEBOUNCE_MS = 150

export function XlsxFindBar({
  open,
  onClose,
  search,
  onNavigate
}: XlsxFindBarProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<XlsxFindOutcome | null>(null)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  /** 只认最后一次查询的结果（防抖 + 异步乱序） */
  const queryToken = useRef(0)

  useEffect(() => {
    if (!open) return
    const element = inputRef.current
    element?.focus()
    element?.select()
  }, [open])

  useEffect(() => {
    if (!open) return
    const query = text
    if (query === '') {
      // 空输入不查、也不在 effect 里同步 setState（避免级联渲染）；显示由 text 派生
      queryToken.current += 1
      return
    }
    const token = (queryToken.current += 1)
    const timer = setTimeout(() => {
      setBusy(true)
      void search(query)
        .then((result) => {
          if (queryToken.current !== token) return
          setOutcome(result)
          setActive(0)
          if (result.ok && result.matches.length > 0) onNavigate(result.matches[0], 0)
        })
        .finally(() => {
          if (queryToken.current === token) setBusy(false)
        })
    }, XLSX_FIND_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, open, search, onNavigate])

  /** 空输入时一律当作"没有结果"（不在 effect 里清 state，派生即可） */
  const current = text === '' ? null : outcome

  const step = useCallback(
    (delta: number) => {
      if (current === null || !current.ok || current.matches.length === 0) return
      const count = current.matches.length
      const next = (((active + delta) % count) + count) % count
      setActive(next)
      onNavigate(current.matches[next], next)
    },
    [active, current, onNavigate]
  )

  if (!open) return null

  const total = current !== null && current.ok ? current.matches.length : null
  const countText =
    current === null
      ? ''
      : current.ok
        ? total === 0
          ? '无结果'
          : `${String(active + 1)}/${String(total)}${current.truncated ? '（仅前 1000 条）' : ''}`
        : current.message

  return (
    <div
      data-testid="xlsx-find-bar"
      role="search"
      style={{
        position: 'absolute',
        top: 8,
        right: 12,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--border-hairline, rgba(0,0,0,.12))',
        background: 'var(--bg-menu, #fff)',
        boxShadow: 'var(--shadow-overlay, 0 6px 18px rgba(0,0,0,.12))',
        color: 'var(--text-primary, #1f2329)',
        fontSize: 12,
        lineHeight: '20px'
      }}
    >
      <input
        ref={inputRef}
        data-testid="xlsx-find-input"
        aria-label="查找内容"
        placeholder="查找（区分大小写）"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }
        }}
        style={{
          width: 170,
          height: 24,
          padding: '0 6px',
          borderRadius: 6,
          border: '1px solid var(--border-hairline, rgba(0,0,0,.12))',
          background: 'var(--bg-primary, #fff)',
          color: 'inherit',
          font: 'inherit'
        }}
      />
      <span
        data-testid="xlsx-find-count"
        aria-live="polite"
        style={{
          minWidth: 44,
          color:
            current !== null && !current.ok
              ? 'var(--danger, #d33)'
              : 'var(--text-tertiary, #6b7075)',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {busy && text !== '' ? '查找中…' : countText}
      </span>
      <button
        type="button"
        data-testid="xlsx-find-prev"
        aria-label="上一个匹配"
        title="上一个（Shift+Enter）"
        disabled={total === 0}
        onClick={() => step(-1)}
        style={buttonStyle}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid="xlsx-find-next"
        aria-label="下一个匹配"
        title="下一个（Enter）"
        disabled={total === 0}
        onClick={() => step(1)}
        style={buttonStyle}
      >
        ↓
      </button>
      <button
        type="button"
        data-testid="xlsx-find-close"
        aria-label="关闭查找"
        title="关闭（Esc）"
        onClick={onClose}
        style={buttonStyle}
      >
        ×
      </button>
    </div>
  )
}

const buttonStyle = {
  width: 24,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border-hairline, rgba(0,0,0,.12))',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer'
} as const
