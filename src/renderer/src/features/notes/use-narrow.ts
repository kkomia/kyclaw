import { useEffect, useState } from 'react'

/** 窄窗断点（plan §4.3：<900 左列收起，列表/编辑器分屏切换，不引入路由变化） */
const NARROW_QUERY = '(max-width: 899px)'

function initialNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(NARROW_QUERY).matches
}

/** 订阅 matchMedia：窗口跨断点时只切版面，不重载数据（同一份 store） */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(initialNarrow)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(NARROW_QUERY)
    // 初始值已在 useState 的 lazy initializer 里读过；这里只订阅跨断点变化，
    // 不在 effect 里同步 setState（否则首屏多一次级联渲染，也会触发 lint 的 set-state-in-effect）。
    const onChange = (): void => setNarrow(media.matches)
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    // 老环境兜底（jsdom 的桩通常只有 addEventListener，不走这里）
    media.addListener?.(onChange)
    return () => media.removeListener?.(onChange)
  }, [])

  return narrow
}
