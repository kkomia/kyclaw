/**
 * 上下文指示器（task-107）：16px **饼图**（实心扇区）；超阈值转 warning。
 *
 * 替代原先的 16px 细环（strokeDasharray 圆环）——用户口径：「修改上下文进度的团的样式，改为饼图」。
 * 只负责画饼（纯几何），百分比文本在触发按钮里由 `ContextChip` 用同一份 stats 渲染。
 */
const RADIUS = 6.5
const CENTER = 8

/** 扇区 path：从 12 点方向顺时针扫 percent%（占满一整圆时由调用方直接画 circle） */
function wedgePath(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const angle = (clamped / 100) * Math.PI * 2
  const x = CENTER + RADIUS * Math.sin(angle)
  const y = CENTER - RADIUS * Math.cos(angle)
  const largeArc = angle > Math.PI ? 1 : 0
  return `M ${CENTER} ${CENTER} L ${CENTER} ${CENTER - RADIUS} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x} ${y} Z`
}

export function ContextMeterGlyph({
  percent,
  warning
}: {
  percent: number
  warning: boolean
}): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent))
  const fillClass = warning ? 'fill-warning' : 'fill-(--accent-text)'
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      data-testid="context-pie"
      data-warning={warning ? 'true' : undefined}
      data-percent={clamped}
      className="size-4 shrink-0"
    >
      {/* 底：整圆的浅色盘（未用部分） */}
      <circle cx={CENTER} cy={CENTER} r={RADIUS} className="fill-(--fill-active)" />
      {clamped >= 99.9 ? (
        <circle cx={CENTER} cy={CENTER} r={RADIUS} className={fillClass} />
      ) : clamped > 0 ? (
        <path d={wedgePath(clamped)} className={fillClass} />
      ) : null}
    </svg>
  )
}
