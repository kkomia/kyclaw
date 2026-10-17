import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AMBIENT_OTTER_FADE_MS, WelcomeAmbientOtter } from '../WelcomeAmbientOtter'
import { useWelcomeHeroVisible } from '../welcome-presence'

/**
 * welcome 初始页右上角氛围小海獭（rev3 第四落点 / task-49）：
 *   - hero 时在场：idle、32 档（CSS <900 降 24 / <720 隐藏）、装饰性（aria-hidden）；
 *   - hero 结束：150ms 淡出后卸载（不硬切），再切回空会话可重新挂上；
 *   - 与 ChatHeader 状态灯互斥的判据 `useWelcomeHeroVisible`（DOM 派生）在这里验行为。
 * 样式契约（位置/内缩/响应式/reduced）在 `splash-asset.spec.ts` 里对 CSS 文件断言。
 */

function welcomeHeroElement(active: boolean): HTMLDivElement {
  const node = document.createElement('div')
  node.setAttribute('data-testid', 'welcome-hero')
  node.setAttribute('data-active', active ? 'true' : 'false')
  document.body.appendChild(node)
  return node
}

afterEach(() => {
  for (const node of document.querySelectorAll('[data-testid="welcome-hero"]')) {
    node.remove()
  }
})

describe('WelcomeAmbientOtter', () => {
  it('hero 时渲染：idle 32 档、装饰性（aria-hidden）、挂在氛围位 testid 下', () => {
    render(<WelcomeAmbientOtter active />)

    const ambient = screen.getByTestId('welcome-ambient-otter')
    expect(ambient).toHaveClass('welcome-ambient-otter')
    expect(ambient).toHaveAttribute('data-active', 'true')
    expect(ambient).toHaveAttribute('aria-hidden', 'true')
    const otter = ambient.querySelector('[data-testid="pixel-otter"]')
    expect(otter).not.toBeNull()
    expect(otter).toHaveAttribute('data-state', 'idle')
    expect(otter).toHaveAttribute('data-size', '32')
    expect(otter).toHaveAttribute('aria-hidden', 'true')
  })

  it('hero 结束：先淡出（data-active=false 仍在 DOM），150ms 后卸载（不硬切）', async () => {
    const view = render(<WelcomeAmbientOtter active />)
    view.rerender(<WelcomeAmbientOtter active={false} />)

    // 离场第一拍：还在 DOM（给 CSS opacity 过渡），只是标成不活跃
    const leaving = screen.getByTestId('welcome-ambient-otter')
    expect(leaving).toHaveAttribute('data-active', 'false')
    expect(leaving).toHaveClass('opacity-0')

    await waitFor(
      () => expect(screen.queryByTestId('welcome-ambient-otter')).not.toBeInTheDocument(),
      { timeout: AMBIENT_OTTER_FADE_MS + 800 }
    )
  })

  it('淡出期间重新进入 hero：不卸载、恢复可见（切回空会话的场景）', async () => {
    const view = render(<WelcomeAmbientOtter active />)
    view.rerender(<WelcomeAmbientOtter active={false} />)
    view.rerender(<WelcomeAmbientOtter active />)

    const ambient = screen.getByTestId('welcome-ambient-otter')
    expect(ambient).toHaveAttribute('data-active', 'true')
    expect(ambient).toHaveClass('opacity-100')
    // 150ms 后仍在（定时器已被清理）
    await new Promise((resolve) => setTimeout(resolve, AMBIENT_OTTER_FADE_MS + 150))
    expect(screen.getByTestId('welcome-ambient-otter')).toBeInTheDocument()
  })
})

/** 小壳：把 hook 的返回值画出来（ChatHeader 用它决定状态灯让位） */
function PresenceProbe(): React.JSX.Element {
  const visible = useWelcomeHeroVisible()
  return <div data-testid="presence">{visible ? 'hero' : 'chat'}</div>
}

describe('useWelcomeHeroVisible · 一屏一只的判据', () => {
  it('欢迎页在场（data-active=true）→ true；离场/移除 → false', async () => {
    render(<PresenceProbe />)
    expect(screen.getByTestId('presence')).toHaveTextContent('chat')

    const hero = welcomeHeroElement(true)
    await waitFor(() => expect(screen.getByTestId('presence')).toHaveTextContent('hero'))

    // 第一句发出：欢迎页还在 DOM 但 data-active=false（离场过渡）→ 状态灯立刻接棒
    act(() => {
      hero.setAttribute('data-active', 'false')
    })
    await waitFor(() => expect(screen.getByTestId('presence')).toHaveTextContent('chat'))

    // 再切回空会话：欢迎页重新活跃 → 氛围位重新占位
    act(() => {
      hero.setAttribute('data-active', 'true')
    })
    await waitFor(() => expect(screen.getByTestId('presence')).toHaveTextContent('hero'))

    act(() => {
      hero.remove()
    })
    await waitFor(() => expect(screen.getByTestId('presence')).toHaveTextContent('chat'))
  })
})
