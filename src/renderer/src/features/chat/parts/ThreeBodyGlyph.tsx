/**
 * task-83 · 三体主题动态 SVG（主选意象：「三体轨道」——三颗几何星体在一条极细轨道上
 * 非同步呼吸，不复制任何第三方三体插画/剧照，纯几何自绘）。
 *
 * 动效 spec：16×16px viewBox，线色 accent（星体）/ border-hairline（轨道），周期 4s + 每颗
 * 星体 2.8s/3.4s/4s 错相呼吸；`prefers-reduced-motion` / `[data-motion='reduced']` 全部定格
 * （动画 none，星体静态三颗）。自包含 inline SVG，无外链、无外部字体。
 */
export function ThreeBodyGlyph(): React.JSX.Element {
  return (
    <svg
      data-testid="three-body-glyph"
      className="three-body-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="three-body-ring" cx="8" cy="8" r="6.2" />
      <g className="three-body-orbit">
        <circle className="three-body-dot three-body-dot--a" cx="8" cy="1.8" r="1.5" />
        <circle className="three-body-dot three-body-dot--b" cx="13.3" cy="11.1" r="1.5" />
        <circle className="three-body-dot three-body-dot--c" cx="2.7" cy="11.1" r="1.5" />
      </g>
      <circle className="three-body-core" cx="8" cy="8" r="1" />
    </svg>
  )
}
