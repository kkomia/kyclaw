import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '@renderer/App'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { failStartupSplash } from '@renderer/lib/startup-splash'
import { defaultSettings } from '@shared/settings'
import { clearKyclawBridge, installKyclawBridge } from './kyclaw-bridge'

/**
 * 012：启动画面不是在"空壳 / Suspense / loading 占位"上退场，且首屏渲染失败时不永远转圈。
 *
 * App 的 useLayoutEffect 在 React 把 DOM 提交之后、浏览器下一次绘制之前运行；
 * 这个用例在壳的 class 变成 is-leaving 的那一刻检查 DOM，确认输入卡已经在页面上
 * —— 交接目标是真首屏，不是还没挂内容的空壳。MutationObserver 同时确认 80 在 100
 * 之前被记录，不是同一个 layout effect / task 里把中间档盖掉。
 *
 * 第二个用例走 main.tsx 的 createRoot(onUncaughtError) 同一条接线：首屏抛错时
 * 壳停在"启动失败"文案上，而不是继续假装加载。
 */
describe('012 · 启动画面交给 React', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-startup-completed-stages')
    document.body.innerHTML =
      '<div id="app-splash" data-startup-stage="shell-visible" data-startup-percent="20">' +
      '<div class="app-splash__track" role="progressbar" aria-valuenow="20"></div>' +
      '<p class="app-splash__status">正在启动…</p>' +
      '</div><div id="root"></div>'
    installKyclawBridge(defaultSettings())
    // 端点在这一次启动里一直没回来：本用例只看"React 提交时有没有真输入卡"，
    // 不需要真会话/历史请求（否则 jsdom 会去 fetch 一个 bad port，留下 unhandled rejection）。
    const api = window.kyclaw as unknown as { agent: { endpoint: () => Promise<unknown> } }
    api.agent.endpoint = () => new Promise(() => {})
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearKyclawBridge()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-startup-completed-stages')
  })

  it('退场时首屏已包含壳与输入卡，且 80 先于 100 被记录（不丢中间档）', async () => {
    const splash = document.getElementById('app-splash') as HTMLElement
    let composerAtDismissal: boolean | undefined
    let percentAtDismissal: string | null = null
    const percentSequence: string[] = []
    const observer = new MutationObserver(() => {
      const percent = splash.getAttribute('data-startup-percent')
      if (percent !== null && percentSequence[percentSequence.length - 1] !== percent) {
        percentSequence.push(percent)
      }
      if (!splash.classList.contains('is-leaving')) return
      composerAtDismissal = document.querySelector('[data-testid="composer-input"]') !== null
      percentAtDismissal = splash.getAttribute('data-startup-percent')
      observer.disconnect()
    })
    observer.observe(splash, {
      attributes: true,
      attributeFilter: ['class', 'data-startup-percent']
    })

    render(<App />)

    // 会话 id 落位会让 ChatSession 按 key 重挂一次；用 waitFor 重查，别拿旧节点做断言
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeInTheDocument())
    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(screen.getByTestId('titlebar')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-column')).toBeInTheDocument()

    await waitFor(() => expect(composerAtDismissal).toBe(true))
    expect(percentAtDismissal).toBe('100')
    expect(splash.querySelector('.app-splash__track')).toHaveAttribute('aria-valuenow', '100')
    // 同一 layout effect 里 80 → 100 会只剩 100；这里用 MutationObserver 钉住真实顺序。
    expect(percentSequence).toContain('80')
    expect(percentSequence.indexOf('80')).toBeLessThan(percentSequence.indexOf('100'))

    // 走完 opacity 过渡，别把兜底 timer 留到下一个用例。
    const fadeEnd = new Event('transitionend', { bubbles: true })
    Object.defineProperty(fadeEnd, 'propertyName', { value: 'opacity' })
    splash.dispatchEvent(fadeEnd)
    await waitFor(() => expect(document.getElementById('app-splash')).toBeNull())
  })

  it('首屏渲染抛错时停在失败文案上，不永远转圈', async () => {
    const splash = document.getElementById('app-splash') as HTMLElement
    const container = document.createElement('div')
    document.body.appendChild(container)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const root = createRoot(container, {
      onUncaughtError: () => failStartupSplash()
    })

    function Boom(): React.JSX.Element {
      throw new Error('首屏失败')
    }

    root.render(<Boom />)

    await waitFor(() => expect(splash).toHaveClass('is-failed'))
    expect(splash).toHaveAttribute('aria-label', 'kyclaw 启动失败')
    expect(splash.querySelector('.app-splash__status')).toHaveTextContent('启动失败')
    expect(splash.querySelector('.app-splash__track')).toHaveAttribute('aria-hidden', 'true')

    root.unmount()
    errorSpy.mockRestore()
  })

  it('main.tsx 真的把 onUncaughtError 接到 failStartupSplash（不是只有用例手接）', () => {
    const mainSource = readFileSync(join(process.cwd(), 'src/renderer/src/main.tsx'), 'utf8')

    expect(mainSource).toContain('onUncaughtError')
    expect(mainSource).toContain('failStartupSplash()')
  })

  it('main.tsx / App.tsx 把真实启动阶段接到进度推进（不是只有进度模块自己）', () => {
    const mainSource = readFileSync(join(process.cwd(), 'src/renderer/src/main.tsx'), 'utf8')
    const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(mainSource).toContain("advanceStartupSplash('renderer-entry')")
    expect(mainSource).toContain("advanceStartupSplash('settings-loaded')")
    expect(appSource).toContain("advanceStartupSplash('react-committed')")
    expect(appSource).toContain('dismissStartupSplash()')
  })
})
