import { useEffect } from 'react'
import { useEffectiveMotion } from '@renderer/lib/motion'

/**
 * 新标签页背景 · 格子点阵（task-109）。
 * 指针邻近的 32px 网格格子被逐格点亮（smooth falloff），点击生成水波涟漪（多圈、叠加、自衰减）。
 * 不再有跟随鼠标的大块 radial 光晕。
 *
 * 约束：reduced / `data-motion=reduced` / `pointer: coarse` 下完全不挂监听、不跑绘制循环（静态网格线兜底）；
 * rAF 只在「指针在页面内」或「有存活涟漪」时运行，静止后停；canvas DPR 适配、resize 跟随。
 * 颜色从主题 token（--accent / --ink）读取，不硬编码色值；指针坐标仍写 --npw-dx/dy 供水印视差。
 */
export const POINTER_VAR_NAMES = [
  '--npw-mx',
  '--npw-my',
  '--npw-dx',
  '--npw-dy',
  '--npw-active'
] as const

/** 格子/涟漪参数（纯函数与绘制共用；测试直接断言这些数）。 */
export const LATTICE = {
  cell: 32,
  radius: 180,
  rippleSpeed: 440,
  rippleLifeMs: 1050,
  maxRipples: 6,
  glowAlpha: 0.2,
  ringWidth: 1.1
} as const

/** 距离场 falloff：(1−d/R)²，半径外为 0、边缘自然衰减。 */
export function latticeFalloff(distance: number, radius: number = LATTICE.radius): number {
  if (!Number.isFinite(distance) || radius <= 0 || distance >= radius) return 0
  const t = 1 - Math.max(0, distance) / radius
  return t * t
}

/** 涟漪时间包络：(1−t)²，t=age/life；超时归零。 */
export function rippleEnvelope(ageMs: number, lifeMs: number = LATTICE.rippleLifeMs): number {
  if (!Number.isFinite(ageMs) || ageMs < 0 || lifeMs <= 0 || ageMs >= lifeMs) return 0
  const t = 1 - ageMs / lifeMs
  return t * t
}

/** 涟漪波峰半径：速度 × 时间（px）。 */
export function rippleRadius(ageMs: number, speed: number = LATTICE.rippleSpeed): number {
  return Math.max(0, ageMs / 1000) * speed
}

/** 指针是否应启用背景动效（reduced / 触摸设备 → 否）。 */
export function shouldTrackPointer(reduced: boolean, coarsePointer: boolean): boolean {
  return !reduced && !coarsePointer
}

interface Ripple {
  x: number
  y: number
  bornAt: number
}

interface EngineColors {
  glow: string
  line: string
}

function readColors(element: HTMLElement): EngineColors {
  const styles = getComputedStyle(element)
  const accent = styles.getPropertyValue('--accent').trim()
  const ink = styles.getPropertyValue('--ink').trim() || styles.color
  // --accent 可能是 color-mix()，canvas 不认；退回已计算文字色（深浅主题都来自 token）
  const glow = accent !== '' && !accent.includes('color-mix') ? accent : ink
  return { glow, line: ink }
}

export function useNewTabPointer(
  ref: React.RefObject<HTMLElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>
): void {
  const reduced = useEffectiveMotion().reduced

  useEffect(() => {
    const element = ref.current
    const canvas = canvasRef.current
    if (element === null || canvas === null) return
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    if (!shouldTrackPointer(reduced, coarse)) return
    const bg = element.querySelector<HTMLElement>('.lt-bg')
    if (bg === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    const colors = readColors(element)
    let frame = 0
    let width = 0
    let height = 0
    let hoverX = 0
    let hoverY = 0
    let hovering = false
    let lastClientX = 0
    let lastClientY = 0
    let hasPosition = false
    const ripples: Ripple[] = []

    const resize = (): void => {
      const rect = bg.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const paintCell = (cx: number, cy: number, intensity: number, ripple: boolean): void => {
      if (intensity <= 0.005) return
      const x = Math.floor(cx / LATTICE.cell) * LATTICE.cell
      const y = Math.floor(cy / LATTICE.cell) * LATTICE.cell
      const alpha = Math.min(0.42, intensity * (ripple ? 0.26 : LATTICE.glowAlpha))
      ctx.globalAlpha = alpha
      ctx.fillStyle = colors.glow
      ctx.fillRect(x + 1, y + 1, LATTICE.cell - 2, LATTICE.cell - 2)
      ctx.globalAlpha = Math.min(0.5, alpha * 1.35)
      ctx.fillStyle = colors.line
      ctx.fillRect(x, y, LATTICE.cell, 1)
      ctx.fillRect(x, y, 1, LATTICE.cell)
    }

    const draw = (now: number): void => {
      ctx.clearRect(0, 0, width, height)
      const alive = ripples.filter((ripple) => now - ripple.bornAt < LATTICE.rippleLifeMs)
      ripples.length = 0
      ripples.push(...alive)

      // 1) hover 点亮：只画半径内格子，格子自身薄填充/格线提亮，非整块光斑
      if (hovering) {
        const minX = Math.max(0, Math.floor((hoverX - LATTICE.radius) / LATTICE.cell))
        const maxX = Math.ceil((hoverX + LATTICE.radius) / LATTICE.cell)
        const minY = Math.max(0, Math.floor((hoverY - LATTICE.radius) / LATTICE.cell))
        const maxY = Math.ceil((hoverY + LATTICE.radius) / LATTICE.cell)
        for (let gy = minY; gy <= maxY; gy += 1) {
          for (let gx = minX; gx <= maxX; gx += 1) {
            const cx = gx * LATTICE.cell + LATTICE.cell / 2
            const cy = gy * LATTICE.cell + LATTICE.cell / 2
            paintCell(cx, cy, latticeFalloff(Math.hypot(cx - hoverX, cy - hoverY)), false)
          }
        }
      }

      // 2) 涟漪：波峰扫过的格子被抬亮，随时间衰减；多个涟漪可叠加
      for (const ripple of alive) {
        const age = now - ripple.bornAt
        const envelope = rippleEnvelope(age)
        if (envelope <= 0) continue
        const radius = rippleRadius(age)
        const reach = radius + LATTICE.cell * 3
        const minX = Math.max(0, Math.floor((ripple.x - reach) / LATTICE.cell))
        const maxX = Math.ceil((ripple.x + reach) / LATTICE.cell)
        const minY = Math.max(0, Math.floor((ripple.y - reach) / LATTICE.cell))
        const maxY = Math.ceil((ripple.y + reach) / LATTICE.cell)
        for (let gy = minY; gy <= maxY; gy += 1) {
          for (let gx = minX; gx <= maxX; gx += 1) {
            const cx = gx * LATTICE.cell + LATTICE.cell / 2
            const cy = gy * LATTICE.cell + LATTICE.cell / 2
            const distance = Math.hypot(cx - ripple.x, cy - ripple.y)
            const offset = Math.abs(distance - radius) / (LATTICE.cell * LATTICE.ringWidth)
            paintCell(cx, cy, Math.exp(-offset * offset) * envelope, true)
          }
        }
      }
      ctx.globalAlpha = 1
    }

    const loop = (): void => {
      frame = 0
      draw(performance.now())
      const alive = ripples.some(
        (ripple) => performance.now() - ripple.bornAt < LATTICE.rippleLifeMs
      )
      if (hovering || alive) frame = window.requestAnimationFrame(loop)
      else ctx.clearRect(0, 0, width, height)
    }

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(loop)
    }

    const applyPointer = (): void => {
      frame = 0 // rAF 回调已消费：必须归零，否则 applyPointer 里的 schedule() 永远跳过
      if (!hasPosition) return
      const rect = element.getBoundingClientRect()
      const w = rect.width || 1
      const h = rect.height || 1
      const localX = Math.min(Math.max(lastClientX - rect.left, 0), w)
      const localY = Math.min(Math.max(lastClientY - rect.top, 0), h)
      element.style.setProperty('--npw-mx', `${Math.round(localX)}px`)
      element.style.setProperty('--npw-my', `${Math.round(localY)}px`)
      element.style.setProperty('--npw-dx', ((localX / w - 0.5) * 2).toFixed(3))
      element.style.setProperty('--npw-dy', ((localY / h - 0.5) * 2).toFixed(3))
      element.style.setProperty('--npw-active', '1')
      const bgRect = bg.getBoundingClientRect()
      hoverX = localX - (bgRect.left - rect.left)
      hoverY = localY - (bgRect.top - rect.top)
      hovering = true
      schedule()
    }

    const onMove = (event: PointerEvent): void => {
      lastClientX = event.clientX
      lastClientY = event.clientY
      hasPosition = true
      if (frame === 0) frame = window.requestAnimationFrame(applyPointer)
    }

    const onDown = (event: PointerEvent): void => {
      lastClientX = event.clientX
      lastClientY = event.clientY
      applyPointer()
      const bgRect = bg.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      ripples.push({
        x: lastClientX - rect.left - (bgRect.left - rect.left),
        y: lastClientY - rect.top - (bgRect.top - rect.top),
        bornAt: performance.now()
      })
      if (ripples.length > LATTICE.maxRipples)
        ripples.splice(0, ripples.length - LATTICE.maxRipples)
      schedule()
    }

    const reset = (): void => {
      hasPosition = false
      hovering = false
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      element.style.setProperty('--npw-dx', '0')
      element.style.setProperty('--npw-dy', '0')
      element.style.setProperty('--npw-active', '0')
      // 涟漪若还活着继续跑完，否则清空
      if (ripples.length === 0) ctx.clearRect(0, 0, width, height)
      else schedule()
    }

    resize()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => resize())
    observer?.observe(bg)
    element.addEventListener('pointermove', onMove, { passive: true })
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerleave', reset)
    window.addEventListener('blur', reset)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerleave', reset)
      window.removeEventListener('blur', reset)
      ctx.clearRect(0, 0, width, height)
    }
  }, [ref, canvasRef, reduced])
}
