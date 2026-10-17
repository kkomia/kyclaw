/**
 * 「终端」工具：真交互终端（@xterm/xterm + @xterm/addon-fit + node-pty 起 Git Bash）。
 *
 * 生命周期（与主进程 workbench-terminal.ts 的约定）：
 *   - **进入 tab 才挂载**（Workbench 的懒挂载），挂载即起一个 PTY（cwd = 会话根）；
 *   - **切到别的 tab 不卸载**（面板只隐藏）—— 进程与输出都还在，切回来接着用；
 *   - **换会话（threadId 变）重建**：终端的 cwd 就是会话根，换了根还留着老 shell 会说不清；
 *   - 重启按钮 = dispose + 重新 start（旧进程一定被杀）；
 *   - 组件卸载（应用收尾）= dispose；主进程在 will-quit 还会兜底 disposeAll。
 *
 * 尺寸：FitAddon 在容器真实尺寸上算 cols/rows，变化经 `terminal:resize` 同步给 PTY
 * （容器宽高为 0 —— 面板收起时 —— 不 fit，免得算出 1 列）。
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { RefreshButton, ToolBar, ToolEmpty, ToolError } from './bits'
import { terminalTheme } from './terminal-theme'
import type { WorkbenchRoot } from './use-workbench-root'
import '@xterm/xterm/css/xterm.css'

/** 未认领的输出最多缓冲多少字符（start 的回包还没到时的早到输出；防重启时越积越多） */
const PENDING_LIMIT = 64 * 1024

/**
 * xterm 的 `fontFamily` 只能是**字符串**（画布按它做字体测量），不能直接写 CSS `var()`；
 * 所以从根元素读 `--font-code` 的计算值 —— 即章程 §2 的 mono 声部（Cascadia Mono → …
 * → DSH 中文链），保证终端里的中文路径/输出和产品其它技术位命中同一套字体。
 *
 * `--font-code` 读不到（独立渲染组件的单测 / 极端启动时序还没挂 token）时退回**章程逐字串**；
 * 两处必须同步（语义 token 本身由 `styles/__tests__/tokens.spec.ts` 钉住，这里只做兜底）。
 */
const FALLBACK_TERMINAL_FONT =
  "'Cascadia Mono', 'Cascadia Code', Consolas, 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

function terminalFontFamily(): string {
  if (typeof document === 'undefined') return FALLBACK_TERMINAL_FONT
  const token = getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()
  return token === '' ? FALLBACK_TERMINAL_FONT : token
}

export function TerminalTool({
  root,
  active
}: {
  root: WorkbenchRoot
  active: boolean
}): React.JSX.Element {
  const { threadId, ready, notice, terminal: api } = root
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const genRef = useRef(0)
  /** 还没对上会话的输出（id → 文本）；start 回包到了再一次性补写 */
  const pendingRef = useRef(new Map<string, string>())
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'exited' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  /** 起一个终端（调用前 termRef/fitRef 必须已就位） */
  const start = useCallback(async (): Promise<void> => {
    const term = termRef.current
    const fit = fitRef.current
    if (api === null || threadId === null || term === null || fit === null) return

    const gen = (genRef.current += 1)
    setStatus('starting')
    setError(null)

    // 容器可见就先量一次真实尺寸（量不准不致命：FitAddon 之后还会被 ResizeObserver 叫）
    fitSafely(containerRef.current, fit)

    try {
      const session = await api.start(threadId, term.cols, term.rows)
      if (gen !== genRef.current) {
        // 这次启动已经过时（换了会话 / 组件收尾）：别留下没人管的进程
        void api.dispose(session.id)
        return
      }
      idRef.current = session.id
      lastSizeRef.current = { cols: term.cols, rows: term.rows }
      setStatus('ready')
      const early = pendingRef.current.get(session.id)
      if (early !== undefined) {
        pendingRef.current.delete(session.id)
        term.write(early)
      }
    } catch (cause) {
      if (gen !== genRef.current) return
      setStatus('error')
      setError(unwrapIpcError(cause))
    }
  }, [api, threadId])

  // 挂载：建 xterm → 订阅 → 起 PTY；卸载：退订 + 杀进程 + 释放 xterm
  useEffect(() => {
    const container = containerRef.current
    if (container === null || api === null || threadId === null) return

    const pending = pendingRef.current
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // 字体走产品 mono 声部（--font-code 含 DSH 中文链），不再硬编码第二套字栈
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      theme: terminalTheme(),
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const input = term.onData((data) => {
      const id = idRef.current
      if (id !== null) void api.write(id, data)
    })
    const offData = api.onData(({ id, data }) => {
      if (id === idRef.current) {
        term.write(data)
        return
      }
      // id 还没认领（start 的回包在路上）：先攒着，认领时补写
      const buffered = pendingRef.current.get(id) ?? ''
      if (buffered.length < PENDING_LIMIT) {
        pendingRef.current.set(id, (buffered + data).slice(0, PENDING_LIMIT))
      }
    })
    const offExit = api.onExit(({ id, exitCode }) => {
      if (id !== idRef.current) return
      idRef.current = null
      setStatus('exited')
      term.write(exitCode === null ? '\r\n[已结束]\r\n' : `\r\n[已结束：退出码 ${exitCode}]\r\n`)
    })

    void start()

    return () => {
      genRef.current += 1
      input.dispose()
      offData()
      offExit()
      const id = idRef.current
      idRef.current = null
      pending.clear()
      if (id !== null) void api.dispose(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [api, threadId, start])

  // 尺寸：容器尺寸变化就 fit + 同步（宽高为 0 时不 fit —— 面板收起时的宽度是 0）
  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (term === null || fit === null) return
      fitSafely(container, fit)
      const id = idRef.current
      if (id === null) return
      const last = lastSizeRef.current
      if (term.cols === last.cols && term.rows === last.rows) return
      lastSizeRef.current = { cols: term.cols, rows: term.rows }
      void api?.resize(id, term.cols, term.rows)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [api])

  // 切回本 tab：补一次 fit（隐藏期间的尺寸变化可能没被量到）并聚焦键盘
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    if (term === null || fit === null) return
    fitSafely(containerRef.current, fit)
    const id = idRef.current
    if (id !== null) void api?.resize(id, term.cols, term.rows)
    term.focus()
  }, [active, api])

  if (!ready) {
    return (
      <ToolEmpty testId="terminal-notice" icon={SquareTerminal} title={notice ?? '终端不可用'} />
    )
  }

  return (
    <div data-testid="terminal-tool" className="flex min-h-0 flex-1 flex-col">
      <ToolBar className="justify-between">
        <span data-testid="terminal-status" className="px-1 text-b2 text-ink-secondary">
          {status === 'starting' ? '正在启动' : status === 'exited' ? '已结束' : 'Git Bash'}
        </span>
        <span className="flex items-center gap-1">
          <RefreshButton
            label="重启终端"
            testId="terminal-restart"
            onClick={() => {
              const id = idRef.current
              idRef.current = null
              pendingRef.current.clear()
              if (id !== null) void api?.dispose(id)
              const term = termRef.current
              term?.reset()
              void start()
            }}
          />
        </span>
      </ToolBar>

      {error === null ? null : <ToolError testId="terminal-error" message={error} />}

      <div className="min-h-0 flex-1 px-2 pb-2">
        <div ref={containerRef} data-testid="terminal-screen" className="size-full" />
      </div>
    </div>
  )
}

/** 只在容器有真实尺寸时 fit（隐藏/收起时量出来的是 0，硬 fit 会得到 1 列） */
function fitSafely(container: HTMLElement | null, fit: FitAddon): void {
  if (container === null) return
  if (container.clientWidth <= 0 || container.clientHeight <= 0) return
  try {
    fit.fit()
  } catch {
    // 容器刚变成可见 / 字体还没量好：下一次 ResizeObserver 还会叫
  }
}
