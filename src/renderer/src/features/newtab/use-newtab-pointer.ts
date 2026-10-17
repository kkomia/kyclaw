import { useEffect } from 'react'
import { useEffectiveMotion } from '@renderer/lib/motion'

/**
 * 新标签页背景 · 指针跟随（task-89 追加要求：「背景做成动态的，根据鼠标位置有对应动效变化」）。
 *
 * 只做三件事（性能安全、克制、纯背景层）：
 *   1. `pointermove`（页面元素上、**passive**）→ rAF 合并后把指针位置写进页面根的 CSS 变量：
 *      `--npw-mx/--npw-my`（px，供暖光 radial-gradient 定位）、`--npw-dx/--npw-dy`（-1..1 归一化，
 *      供水印视差与网格微移）、`--npw-active`（0/1，供暖光淡入淡出）；
 *   2. `pointerleave` / 窗口 `blur` → 回静止态（active=0、dx/dy=0，CSS 过渡自然淡出/归位）；
 *   3. **不降级不监听**：reduced（用户「减弱」/系统 reduced，走 `useEffectiveMotion`）或触摸设备
 *      （`pointer: coarse`）下直接 return，不挂任何监听；CSS 侧也有 `prefers-reduced-motion` 与
 *      `[data-motion='reduced']` 的静态兜底。
 *
 * 只改 CSS 变量（合成层属性），不 setState、不触发 React 重渲染、不读写会引发 layout 的样式；
 * `getBoundingClientRect` 只在 rAF 回调里取一次（每帧最多一次）。
 */
export const POINTER_VAR_NAMES = [
  '--npw-mx',
  '--npw-my',
  '--npw-dx',
  '--npw-dy',
  '--npw-active'
] as const

/** 指针是否应在该环境启用（reduced / 触摸设备 → 不启用；纯函数便于静态断言/测试） */
export function shouldTrackPointer(reduced: boolean, coarsePointer: boolean): boolean {
  return !reduced && !coarsePointer
}

export function useNewTabPointer(ref: React.RefObject<HTMLElement | null>): void {
  const reduced = useEffectiveMotion().reduced

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    if (!shouldTrackPointer(reduced, coarse)) return

    let frame = 0
    let lastClientX = 0
    let lastClientY = 0
    let hasPosition = false

    const apply = (): void => {
      frame = 0
      if (!hasPosition) return
      const rect = element.getBoundingClientRect()
      // jsdom 没有布局：宽高 0 时按 1 处理（测试仍能读到变量变化；真机是真实尺寸）
      const width = rect.width || 1
      const height = rect.height || 1
      const localX = Math.min(Math.max(lastClientX - rect.left, 0), width)
      const localY = Math.min(Math.max(lastClientY - rect.top, 0), height)
      const dx = (localX / width - 0.5) * 2
      const dy = (localY / height - 0.5) * 2
      element.style.setProperty('--npw-mx', `${Math.round(localX)}px`)
      element.style.setProperty('--npw-my', `${Math.round(localY)}px`)
      element.style.setProperty('--npw-dx', dx.toFixed(3))
      element.style.setProperty('--npw-dy', dy.toFixed(3))
      element.style.setProperty('--npw-active', '1')
    }

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(apply)
    }

    const onPointerMove = (event: PointerEvent): void => {
      lastClientX = event.clientX
      lastClientY = event.clientY
      hasPosition = true
      schedule()
    }

    const reset = (): void => {
      hasPosition = false
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      element.style.setProperty('--npw-dx', '0')
      element.style.setProperty('--npw-dy', '0')
      element.style.setProperty('--npw-active', '0')
    }

    element.addEventListener('pointermove', onPointerMove, { passive: true })
    element.addEventListener('pointerleave', reset)
    window.addEventListener('blur', reset)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerleave', reset)
      window.removeEventListener('blur', reset)
      reset()
    }
  }, [ref, reduced])
}
