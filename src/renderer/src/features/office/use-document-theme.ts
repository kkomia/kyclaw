/**
 * 渲染端当前**解析后**的明暗（M3-S2 · P2 修复：深色主题下 Office 隔离面仍是白底）。
 *
 * 主题的真相是 `lib/theme.ts` 写到 `<html data-theme="light|dark">`（启动、设置页切换、
 * 系统主题变化都只改这一个属性）。这里不复制主题决策，只**观察**它：
 *   - 首帧读当前属性；
 *   - `MutationObserver` 盯 `data-theme`，运行中切换也会更新（OfficeSurface 据此重发 init）。
 *
 * 不放进 office store：这是"从 DOM 读出来的显示事实"，没有跨组件需要写的状态。
 */
import { useEffect, useState } from 'react'
import type { SurfaceTheme } from '@renderer/office/bridge-protocol'

/** 纯读取：data-theme 只有 'light' | 'dark'（缺省/未知一律按 light） */
export function readDocumentTheme(): SurfaceTheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/** 订阅 `<html data-theme>` 的变化，返回当前解析明暗（React hook） */
export function useDocumentTheme(): SurfaceTheme {
  // 首帧就按当前属性取值（render 期读 DOM 属性是"读取显示事实"，不写状态）
  const [theme, setTheme] = useState<SurfaceTheme>(readDocumentTheme)

  useEffect(() => {
    // 只订阅后续变化：首帧值已由 useState 的初始化器读过，effect 体内不再同步 setState
    const observer = new MutationObserver(() => setTheme(readDocumentTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])

  return theme
}
