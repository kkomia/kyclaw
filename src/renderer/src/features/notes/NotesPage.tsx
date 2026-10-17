import { ModulePlaceholder } from '@renderer/components/shell/ModulePlaceholder'

/** 笔记模块（0.2.0 第一阶段只占位，业务留给后续版本）。 */
export function NotesPage(): React.JSX.Element {
  return (
    <ModulePlaceholder
      title="笔记"
      pageTestId="notes-page"
      emptyTestId="notes-empty"
      emptyText="还没有笔记。"
    />
  )
}
