/**
 * 分页文本体：把文本通道的"一页"变成**能读完整份**的那个组件。
 *
 * 三件事：
 *   1. **加载更多**：按上一页回的 `{ offset, version }` 续读，把各页**直接拼接**（页边界在换行之后、
 *      UTF-8 字符边界上，所以拼接就是原文）；读完（`eof`）按钮消失；
 *   2. **受控轮询**：每 `POLL_INTERVAL_MS` 探一次版本 —— 只在**窗口可见且所在预览标签是前台**时探
 *      （预览标签全挂着，隐藏的那些不轮询；卸载即停）。版本变了**只提示、不自动拼**：
 *      旧内容和新内容混排比"看不到更新"更糟，所以给一个"重新读取并回到这里"的按钮；
 *   3. **重读回位**：重读从 0 开始读到原来的阅读位置（字节游标），把滚动位置放回去 ——
 *      既不混版本，也不把读者甩回开头。
 *
 * 渲染交给既有的三个渲染器（markdown / code / 纯文本），本组件只管"取多少、什么时候取、怎么提示"。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import type { TextPage, TextPageCursor, TextPageResult } from '@shared/workbench-text'
import { TEXT_PAGE_MAX_BYTES, TEXT_PAGE_MAX_LINE_BYTES } from '@shared/workbench-text'
import { formatBytes } from '../../format'
import { CodePreview } from '../CodePreview'
import { MarkdownPreview } from '../MarkdownPreview'
import type { PreviewMode } from '../modes'
import { DshTextBody } from './text-body'
import type { TextPager } from './text-pager'
import './dsh-media.css'

/** 轮询间隔（只 stat，一次往返；窗口不可见或标签不在前台时这一拍直接跳过）。 */
const POLL_INTERVAL_MS = 4000
/** "用户没上翻"的判据：滚动位置离顶不超过这么多像素（在顶上看的人可以被自动刷新，上翻的人不行）。 */
const AT_TOP_PX = 8
/**
 * **自动**重载最多补多少页（256KB × 8 = 2MB）。
 * 自动刷新只在"读者没上翻 + 要补的范围不大"时做：范围更大就只提示（不静默拉一份大的，也不替读者做主）。
 */
const AUTO_RELOAD_MAX_PAGES = 8
/** 手动"重新读取并回到这里"最多补多少页（256KB × 64 = 16MB）。 */
const RELOAD_PAGE_LIMIT = 64

/** 版本/内容出了什么状况（都只在界面里说清楚，不动已经显示出来的那份内容）。 */
type Notice =
  | { kind: 'changed'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'binary'; message: string }
  | { kind: 'too-large'; message: string }
  | { kind: 'truncated'; message: string }
  | { kind: 'refreshed'; message: string }

/** 一份预览"现在真在用户眼前"吗：窗口可见 + 所在预览标签是前台（隐藏的标签不轮询）。 */
function isPreviewVisible(node: HTMLElement | null): boolean {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false
  // 不在预览标签里（例如文件树的底部内联预览）：没有"前台不前台"这回事，按可见算
  const panel = node?.closest('[data-testid="workbench-panel"]')
  if (panel === null || panel === undefined) return true
  return panel.getAttribute('data-active') === 'true'
}

/** 最近的滚动容器（与 `ImagePreview` 同一口径）：自动刷新/重读的"上没上翻"与回位都靠它。 */
function nearestScrollHost(node: HTMLElement | null): HTMLElement | null {
  for (let parent = node?.parentElement ?? null; parent !== null; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return parent
  }
  return null
}

/** 现在离顶多少像素（量不到滚动容器就当 0 = 没上翻）。 */
function scrollTopNow(node: HTMLElement | null): number {
  return nearestScrollHost(node)?.scrollTop ?? 0
}

/** 非 `page` 的那几种回包 → 提示（不抛、也不动已显示的内容）。 */
function noticeOf(result: Exclude<TextPageResult, { kind: 'page' }>): Notice {
  switch (result.kind) {
    case 'changed':
      return { kind: 'changed', message: '文件已在磁盘上更新' }
    case 'missing':
      return { kind: 'missing', message: '文件不在磁盘上了（可能刚被删除或改名）' }
    case 'binary':
      return { kind: 'binary', message: '文件内容变了：现在看起来不是文本' }
    case 'too-large':
      return {
        kind: 'too-large',
        message: `文件变得太大了（超过 ${formatBytes(result.limit)}）`
      }
  }
}

/**
 * 一页开头的文本体。
 * @param props `first` 是第一页（`readPreview` 取的），`pager` 是续读/探版本的口（见 `text-pager.ts`）。
 * @returns 可"加载更多"、会提示更新、重读能回位的文本体。
 */
export function PagedTextBody({
  mode,
  language,
  first,
  pager
}: {
  /** 走哪个渲染器（text / markdown / code） */
  mode: PreviewMode
  /** 代码那支的语言 id（`codeLanguageOf` 算好的；非代码给 null） */
  language: string | null
  /** 第一页 */
  first: TextPage
  /** 续读口 */
  pager: TextPager
}): React.JSX.Element {
  const [text, setText] = useState(first.text)
  const [cursor, setCursor] = useState<TextPageCursor | null>(
    first.eof ? null : { offset: first.nextOffset, version: first.version }
  )
  const [version, setVersion] = useState(first.version)
  const [size, setSize] = useState(first.size)
  const [overlong, setOverlong] = useState(first.overlongLine)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 重读后要放回去的滚动位置（`useLayoutEffect` 在这一次提交后落下去） */
  const pendingScroll = useRef<number | null>(null)

  /** 非 page 的回包 → 提示；**不拼接**（这就是"不混版本"的落点） */
  const applyFailure = useCallback((result: Exclude<TextPageResult, { kind: 'page' }>) => {
    setNotice(noticeOf(result))
  }, [])

  /** 轮询里的自动重载走这个 ref（`refresh` 的身份随状态变，不该让 interval 每帧重挂） */
  const refreshRef = useRef<(auto: boolean) => void>(() => undefined)

  /**
   * 重读：从 0 读到"原来显示到哪儿"，然后把滚动位置放回去（不混版本、不甩回开头）。
   *
   * `auto = true`（轮询发现版本变了时自动触发）**只在两种情形下真做**：
   *   ① 读者没上翻（滚动位置在顶附近）；② 要补的范围不大（≤ `AUTO_RELOAD_MAX_PAGES` 页 = 2MB）。
   * 其它情形退成"只提示"：不抢读者的位置，也不静默拉一份大的。
   */
  const refresh = useCallback(
    async (auto: boolean): Promise<void> => {
      if (busy) return
      const scrollTop = scrollTopNow(rootRef.current)
      const covered = cursor?.offset ?? size
      const pageLimit = auto ? AUTO_RELOAD_MAX_PAGES : RELOAD_PAGE_LIMIT
      if (
        auto &&
        (scrollTop > AT_TOP_PX || covered > AUTO_RELOAD_MAX_PAGES * TEXT_PAGE_MAX_BYTES)
      ) {
        setNotice((prev) => (prev?.kind === 'changed' ? prev : noticeOf({ kind: 'changed' })))
        return
      }
      setBusy(true)
      try {
        let accumulated = ''
        let next: TextPageCursor | null = null
        let last: TextPage | null = null
        let freshVersion = version
        let pages = 0
        let sawOverlong = false
        for (;;) {
          const result = await pager.readPage(next)
          if (result.kind !== 'page') {
            applyFailure(result)
            return
          }
          accumulated += result.text
          sawOverlong = sawOverlong || result.overlongLine
          last = result
          freshVersion = result.version
          pages += 1
          if (result.eof || result.nextOffset >= covered || pages >= pageLimit) break
          next = { offset: result.nextOffset, version: result.version }
        }
        if (last === null) return
        pendingScroll.current = scrollTop
        setText(accumulated)
        setSize(last.size)
        setOverlong(sawOverlong)
        setCursor(last.eof ? null : { offset: last.nextOffset, version: last.version })
        setVersion(freshVersion)
        const incomplete = !last.eof && last.nextOffset < covered
        if (incomplete && auto) {
          // 自动这条路补不齐：原样保留提示，让读者自己决定（手动那条会把"补到上限"如实说出来）
          setNotice((prev) => (prev?.kind === 'changed' ? prev : noticeOf({ kind: 'changed' })))
        } else if (incomplete) {
          setNotice({
            kind: 'truncated',
            message: `重读到了 ${RELOAD_PAGE_LIMIT} 页的上限，还没补回刚才读到的位置`
          })
        } else if (freshVersion !== version) {
          setNotice({ kind: 'refreshed', message: '文件已更新，正文已刷新到最新' })
        } else {
          setNotice(null)
        }
        setError(null)
      } catch (cause) {
        setError(unwrapIpcError(cause))
      } finally {
        setBusy(false)
      }
    },
    [applyFailure, busy, cursor, pager, size, version]
  )

  useEffect(() => {
    refreshRef.current = (auto: boolean): void => {
      void refresh(auto)
    }
  }, [refresh])

  // 受控轮询：窗口不可见 / 标签不在前台就跳过这一拍；卸载清定时器；失败只跳过这一次。
  // 这一拍只 **stat**（`textVersion`，不读正文）：版本变了才决定"自动刷新"还是"只提示"。
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isPreviewVisible(rootRef.current)) return
      void pager
        .version()
        .then((probe) => {
          if (probe.kind === 'missing') {
            setNotice((prev) => (prev?.kind === 'missing' ? prev : noticeOf({ kind: 'missing' })))
            return
          }
          if (probe.version !== version) {
            refreshRef.current(true)
            return
          }
          // 磁盘上又变回我们手里这份了：把"已更新"的提示收掉（其它提示要用户自己处理，保持）
          setNotice((prev) => (prev?.kind === 'changed' ? null : prev))
        })
        .catch(() => undefined)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [pager, version])

  const loadMore = useCallback(async () => {
    if (cursor === null || busy) return
    setBusy(true)
    try {
      const result = await pager.readPage(cursor)
      if (result.kind !== 'page') {
        applyFailure(result)
        return
      }
      setText((prev) => prev + result.text)
      setSize(result.size)
      setOverlong((prev) => prev || result.overlongLine)
      setCursor(result.eof ? null : { offset: result.nextOffset, version: result.version })
      setVersion(result.version)
      setNotice(null)
      setError(null)
    } catch (cause) {
      setError(unwrapIpcError(cause))
    } finally {
      setBusy(false)
    }
  }, [applyFailure, busy, cursor, pager])

  /** 手动那条路：一律真重读（页数上限 64 页，补不齐会如实说） */
  const reload = useCallback(async () => {
    await refresh(false)
  }, [refresh])

  // 重读之后把阅读位置放回去（在这一帧布局完成后落，避免先闪到底部）
  useLayoutEffect(() => {
    const pending = pendingScroll.current
    pendingScroll.current = null
    if (pending === null) return
    const host = nearestScrollHost(rootRef.current)
    if (host !== null) host.scrollTop = pending
  }, [text])

  return (
    <div
      ref={rootRef}
      className="dsh-paged-text"
      data-testid="paged-text"
      data-complete={cursor === null ? 'true' : 'false'}
      data-version={version}
    >
      {mode === 'markdown' ? (
        <MarkdownPreview text={text} />
      ) : mode === 'code' && language !== null ? (
        <CodePreview text={text} language={language} />
      ) : (
        <div data-testid="file-preview-text" className="px-3">
          <DshTextBody text={text} />
        </div>
      )}

      {overlong ? (
        <p className="dsh-paged-text-note" data-testid="paged-text-overlong">
          这份文件里有超长行，已按 {formatBytes(TEXT_PAGE_MAX_LINE_BYTES)}{' '}
          一段切开显示（原文没有改动）
        </p>
      ) : null}

      {notice !== null ? (
        <div
          className="dsh-paged-text-notice"
          data-testid="paged-text-notice"
          data-kind={notice.kind}
        >
          <span className="dsh-paged-text-notice-text">{notice.message}</span>
          {notice.kind === 'changed' ? (
            <button
              type="button"
              data-testid="paged-text-reload"
              disabled={busy}
              onClick={() => void reload()}
            >
              重新读取并回到这里
            </button>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <p className="dsh-paged-text-note" data-testid="paged-text-error">
          {error}
        </p>
      ) : null}

      {cursor !== null ? (
        <div className="dsh-paged-text-more" data-testid="paged-text-more-row">
          <p className="dsh-paged-text-note">只显示前面一部分（共 {formatBytes(size)}）</p>
          <button
            type="button"
            data-testid="paged-text-more"
            disabled={busy}
            onClick={() => void loadMore()}
          >
            {busy ? '加载中…' : '加载更多'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 供测试与调用方引用的常量（轮询节拍只有这一个出处）。 */
export { POLL_INTERVAL_MS }
