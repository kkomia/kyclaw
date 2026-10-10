import { PagePlaceholder } from '../../components/shell/PagePlaceholder'

/** 记忆页（骨架）：记忆的查看 / 编辑 / 清空由记忆里程碑接入。 */
export function MemoryPage(): React.JSX.Element {
  return (
    <PagePlaceholder testId="memory-page" title="记忆" note="记忆的查看与编辑将在后续里程碑接入" />
  )
}
