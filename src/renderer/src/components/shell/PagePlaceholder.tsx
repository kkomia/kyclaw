/**
 * 页面骨架（主列里的内容层）：标题 + 一句说明。
 * T5 的 chat / memory / usage 三页先用它占位（真实内容各自的任务接入），
 * 设置页有自己的分组结构，不用这个。
 * 内容列限宽 + 居中：侧栏是覆盖层（R13），贴左缘的内容会被它盖住（见 semantic.css 的 --content-max-width）。
 */
export interface PagePlaceholderProps {
  title: string
  note: string
  testId: string
}

export function PagePlaceholder({ title, note, testId }: PagePlaceholderProps): React.JSX.Element {
  return (
    <section
      data-testid={testId}
      className="mx-auto flex min-h-0 w-full max-w-(--content-max-width) flex-1 flex-col gap-2 overflow-y-auto p-6"
    >
      <h1 className="text-t1 font-medium text-ink">{title}</h1>
      <p className="text-b2 text-ink-tertiary">{note}</p>
    </section>
  )
}
