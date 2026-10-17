/**
 * `control: 'builtin'` 的命令项（A2）：交给内核的自带控件渲染。
 *
 * 为什么不能"盲 execute"：
 *   - `insertTable` 需要 `{ rows, columns }`（无参执行会被内核判非法）；
 *   - `tableAction` 是表格菜单（插入/删除行列、合并单元格…），需要用户选动作；
 *   - `imageTransform` 需要旋转/翻转动作。
 * 这三项用内核的 `ToolbarCommand`（默认工具条同款控件）渲染，
 * 弹窗/菜单/参数都由内核负责；样式包一层 `.ofr-builtin` 约束尺寸。
 *
 * 该组件单独成文件，是为了让 `OfficeRibbonView` 的单测可以 mock 掉
 * `@betteroffice/docx-react` 运行时（jsdom 里不加载内核）。
 */
import { ToolbarCommand } from '@betteroffice/docx-react'
import type { DocxCommandId } from '@betteroffice/docx-react'

export interface OfficeBuiltinCommandProps {
  id: DocxCommandId
  /** 无障碍/提示文案（来自 ribbon 模型的 label） */
  label: string
}

export function OfficeBuiltinCommand({ id, label }: OfficeBuiltinCommandProps): React.JSX.Element {
  return (
    <span className="ofr-builtin" data-testid={`office-ribbon-builtin-${id}`} title={label}>
      <ToolbarCommand id={id} className="ofr-builtin-control" />
    </span>
  )
}
