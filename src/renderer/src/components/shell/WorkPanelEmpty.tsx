import { Wrench } from 'lucide-react'

/** 工作台空态：右栏还没接产出物/文件预览（本任务只到"能打开、有内容"）。 */
export function WorkPanelEmpty(): React.JSX.Element {
  return (
    <div
      data-testid="work-panel-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Wrench aria-hidden="true" className="size-(--icon-size-lg) text-ink-tertiary" />
      <p className="text-b2 text-ink">工作台</p>
      <p className="text-c1 text-ink-tertiary">产出物与文件预览会显示在这里</p>
    </div>
  )
}
