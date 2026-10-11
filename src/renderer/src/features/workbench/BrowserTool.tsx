/**
 * 「浏览器」工具：内嵌 `<webview>` + 自绘工具条（后退 / 前进 / 刷新·停止 / 网址 / 外部打开）。
 *
 * 安全与分区都由主进程钉死（`main/webview.ts`：`will-attach-webview` 强制 `persist:kyclaw-browser`
 * 分区、去掉 preload、关 node；`window.open` 一律走系统浏览器）。渲染端这里只做三件事：
 *   1. 地址栏（自绘，非原生样式）→ `normalizeUrl` → `loadURL`；
 *   2. 把 webview 的导航/标题/加载事件画成工具条状态；
 *   3. 页面加载失败的常见错误码翻成人话。
 *
 * `src` 只在挂载时给一次 `about:blank`（让客人先挂上，后续导航全走 `loadURL`）—— 之后不让 React
 * 再碰 `src` 属性，免得每次重渲染都触发一次导航。
 */
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { ToolEmpty, ToolError, ToolBar } from './bits'
import {
  describeLoadError,
  ERR_ABORTED,
  normalizeUrl,
  type WebviewElement,
  type WebviewFailLoadEvent,
  type WebviewNavigateEvent,
  type WebviewTitleEvent
} from './webview-element'

/** 起始页：空白页（客人先挂上，其它导航全走 loadURL） */
const BLANK = 'about:blank'

export function BrowserTool(): React.JSX.Element {
  const ref = useRef<WebviewElement | null>(null)
  const [draft, setDraft] = useState('')
  /** 当前页面的网址（about:blank = 还没有真实页面） */
  const [currentUrl, setCurrentUrl] = useState(BLANK)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 历史可走性只有 webview 自己知道：每次导航结束同步一份到状态里 */
  const syncNav = useCallback((): void => {
    const node = ref.current
    if (node === null) return
    try {
      setCanBack(node.canGoBack() === true)
      setCanForward(node.canGoForward() === true)
    } catch {
      // 客人还没挂上（或环境里根本没有 webview 实现）：保持不可走
    }
  }, [])

  /** 调 webview 的方法：环境里没有这个方法（非 Electron / 未挂上）就当没点 */
  const invoke = useCallback((name: 'goBack' | 'goForward' | 'reload' | 'stop'): void => {
    const node = ref.current
    const method = node?.[name]
    if (typeof method === 'function') method.call(node)
  }, [])

  useEffect(() => {
    const node = ref.current
    if (node === null) return

    const onNavigate = (event: Event): void => {
      const { url } = event as WebviewNavigateEvent
      setCurrentUrl(url)
      setDraft(url === BLANK ? '' : url)
      setError(null)
      syncNav()
    }
    const onTitle = (event: Event): void => {
      setTitle((event as WebviewTitleEvent).title)
    }
    const onStart = (): void => {
      setLoading(true)
      syncNav()
    }
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const onFail = (event: Event): void => {
      const detail = event as WebviewFailLoadEvent
      setLoading(false)
      // -3 = ERR_ABORTED（用户自己按了停止 / 点了新链接）——不是错误
      if (!detail.isMainFrame || detail.errorCode === ERR_ABORTED) return
      setError(describeLoadError(detail))
    }

    node.addEventListener('did-navigate', onNavigate)
    node.addEventListener('did-navigate-in-page', onNavigate)
    node.addEventListener('page-title-updated', onTitle)
    node.addEventListener('did-start-loading', onStart)
    node.addEventListener('did-stop-loading', onStop)
    node.addEventListener('did-fail-load', onFail)
    return () => {
      node.removeEventListener('did-navigate', onNavigate)
      node.removeEventListener('did-navigate-in-page', onNavigate)
      node.removeEventListener('page-title-updated', onTitle)
      node.removeEventListener('did-start-loading', onStart)
      node.removeEventListener('did-stop-loading', onStop)
      node.removeEventListener('did-fail-load', onFail)
    }
  }, [syncNav])

  const go = useCallback((raw: string): void => {
    const node = ref.current
    const url = normalizeUrl(raw)
    if (node === null || url === null) return
    if (typeof node.loadURL !== 'function') return
    setLoading(true)
    setError(null)
    void node.loadURL(url).catch((cause: unknown) => {
      setLoading(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  const hasPage = currentUrl !== BLANK

  return (
    <div data-testid="browser-tool" className="flex min-h-0 flex-1 flex-col">
      <ToolBar className="gap-0.5">
        <IconButton
          label="后退"
          icon={<ArrowLeft />}
          disabled={!canBack}
          onClick={() => invoke('goBack')}
          className="border-transparent hover:bg-hover"
        />
        <IconButton
          label="前进"
          icon={<ArrowRight />}
          disabled={!canForward}
          onClick={() => invoke('goForward')}
          className="border-transparent hover:bg-hover"
        />
        {loading ? (
          <IconButton
            label="停止加载"
            icon={<X />}
            onClick={() => invoke('stop')}
            className="border-transparent hover:bg-hover"
          />
        ) : (
          <IconButton
            label="重新加载"
            icon={<RotateCw />}
            onClick={() => invoke('reload')}
            className="border-transparent hover:bg-hover"
          />
        )}
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(draft)
          }}
        >
          <Input
            data-testid="browser-url"
            aria-label="网址"
            value={draft}
            placeholder="输入网址"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="h-(--control-height-md) min-w-0 flex-1 px-2"
          />
        </form>
        {loading ? (
          <Spinner decorative size="sm" className="mx-1 text-ink-tertiary" />
        ) : (
          <IconButton
            label="在系统浏览器中打开"
            icon={<ExternalLink />}
            disabled={!hasPage}
            onClick={() => {
              if (hasPage) void window.open(currentUrl, '_blank')
            }}
            className="border-transparent hover:bg-hover"
          />
        )}
      </ToolBar>

      {error === null ? null : <ToolError testId="browser-error" message={error} />}
      {title === '' ? null : (
        <p
          data-testid="browser-title"
          className="h-7 shrink-0 truncate px-3 text-b2 text-ink-secondary"
        >
          {title}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <webview
          ref={ref}
          data-testid="browser-webview"
          aria-label="内嵌浏览器"
          src={BLANK}
          // Electron 的 webview 属性不在 React 的已知属性表里（真正的隔离分区由主进程
          // will-attach-webview 钉死，这里写的只是声明意图）
          // eslint-disable-next-line react/no-unknown-property
          partition="persist:kyclaw-browser"
          className="absolute inset-0 bg-surface"
        />
        {hasPage || loading ? null : (
          <div className="absolute inset-0 flex bg-surface">
            <ToolEmpty testId="browser-empty" icon={Globe} title="输入网址开始浏览" />
          </div>
        )}
      </div>
    </div>
  )
}
