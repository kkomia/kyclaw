/**
 * 页面骨架（主列里的内容层）：标题（+ 可选的副标题，不写就只有标题）。
 * 记忆 / 用量两页先用它占位（真实内容各自的任务接入），设置页有自己的栏目结构，不用这个。
 * 内容列限宽 + 居中走 .content-column（styles/tailwind.css）：侧栏是覆盖层（R13），
 * 这一层保证内容任何状态下都不被侧栏盖住、也不横向裁切。
 */
export interface PagePlaceholderProps {
  title: string
  testId: string
  /** 副标题：只在真有信息时给（不用小字解释后端与排期） */
  note?: string
}

export function PagePlaceholder({ title, note, testId }: PagePlaceholderProps): React.JSX.Element {
  return (
    <section
      data-testid={testId}
      className="content-column animate-page-in flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-6"
    >
      <h1 className="text-t1 font-medium text-ink">{title}</h1>
      {note === undefined ? null : <p className="text-b2 text-ink-secondary">{note}</p>}
    </section>
  )
}
