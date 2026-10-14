/**
 * 幻灯片预览（pptx）：逐页一张**文字卡** —— 页码 + 标题（认得出才给）+ 正文行。
 *
 * 为什么是文字卡而不是"还原版式"：浏览器侧没有可信的 PPT 高保真渲染（调研结论：libreoffice
 * 那类要么带原生依赖、要么是服务端方案）。所以这里只把主进程抽出来的文字如实摆出来，
 * 并在顶上**一句话**说清"仅文字提要，版式不还原" —— 不假装画出了幻灯片。
 */
import type { PreviewSlide } from '@shared/workbench'

export function PptxPreview({
  slides,
  truncated
}: {
  slides: readonly PreviewSlide[]
  truncated: boolean
}): React.JSX.Element {
  return (
    <div data-testid="file-preview-pptx" className="flex min-w-0 flex-col gap-2 px-3 py-2">
      <p data-testid="file-preview-pptx-notice" className="text-c1 text-ink-tertiary">
        仅文字提要，版式不还原
      </p>

      {slides.length === 0 ? (
        <p data-testid="file-preview-pptx-empty" className="text-b2 text-ink-tertiary">
          这些页面里没有文字
        </p>
      ) : (
        slides.map((slide) => (
          <article
            key={slide.index}
            data-testid="pptx-slide"
            data-index={slide.index}
            className="flex flex-col gap-1 rounded-panel border border-surface-border bg-secondary px-3 py-2"
          >
            <p className="text-c1 text-ink-tertiary">第 {slide.index} 页</p>
            {slide.title === undefined ? null : (
              <p data-testid="pptx-slide-title" className="text-b2 font-medium text-ink">
                {slide.title}
              </p>
            )}
            {slide.lines.map((line, index) => (
              <p key={index} className="text-b2 whitespace-pre-wrap text-ink-secondary">
                {line}
              </p>
            ))}
            {slide.title === undefined && slide.lines.length === 0 ? (
              <p className="text-b2 text-ink-tertiary">这一页没有文字</p>
            ) : null}
          </article>
        ))
      )}

      {truncated ? (
        <p data-testid="file-preview-pptx-truncated" className="text-b2 text-ink-tertiary">
          页数太多，只显示了前面一部分
        </p>
      ) : null}
    </div>
  )
}
