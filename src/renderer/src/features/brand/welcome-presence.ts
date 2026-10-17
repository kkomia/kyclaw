/**
 * "欢迎页（初始页 hero）现在是否在场"的只读观察 hook（DOM 派生，零 store）。
 *
 * 为什么需要：task-49 要求"hero 时只有氛围位、进对话后只有 ChatHeader 状态灯"——同一个位置
 * 不能一屏两只。ChatHeader 拿不到 ActiveChat 的内部 `messages`/`hero`（写域/层级都不允许传
 * prop），而 WelcomeHero 是页面里唯一一个带 `data-active` 的稳定事实，所以在这里观察它：
 *   - 挂载时先现读一次（header 可能在 hero 之后才挂）；
 *   - MutationObserver 盯 body 子树的属性变化（data-active）与节点增删；
 *   - 只在欢迎页存在/消失时改状态，别的 DOM 变化不触发渲染（回调里先比对再 set）。
 */
import { useEffect, useState } from 'react'

const WELCOME_HERO_SELECTOR = '[data-testid="welcome-hero"]'

function welcomeVisibleNow(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(`${WELCOME_HERO_SELECTOR}[data-active="true"]`) !== null
}

export function useWelcomeHeroVisible(): boolean {
  const [visible, setVisible] = useState(welcomeVisibleNow)

  useEffect(() => {
    const sync = (): void => {
      const next = welcomeVisibleNow()
      // 先比对再 set：MutationObserver 会被页面上大量与会话无关的 DOM 变化唤醒，
      // 这里让"欢迎页在/不在"成为唯一的渲染触发条件。
      setVisible((prev) => (prev === next ? prev : next))
    }
    sync()
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-active']
    })
    return () => observer.disconnect()
  }, [])

  return visible
}
