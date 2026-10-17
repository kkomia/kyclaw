import { ModulePlaceholder } from '@renderer/components/shell/ModulePlaceholder'

/** 知识库模块（0.2.0 第一阶段只占位，业务留给后续版本）。 */
export function KnowledgePage(): React.JSX.Element {
  return (
    <ModulePlaceholder
      title="知识库"
      pageTestId="knowledge-page"
      emptyTestId="knowledge-empty"
      emptyText="还没有知识库内容。"
    />
  )
}
