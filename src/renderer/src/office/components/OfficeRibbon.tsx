/**
 * 面内 ribbon 的**接线壳**（A2）：把内核的 `DocxCommandStore` 归一成 `OfficeCommandAdapter`，
 * 再交给纯表现层 `OfficeRibbonView`。
 *
 * 只在 `DocxEditor` 的 `toolbar` slot 里渲染（此时 `DocxCommandProvider` 已在树上），
 * 所以这里可以安全调用 `useDocxCommands()`。
 *
 * A/B 档切换点就在这一层：B 档（shell 侧 ribbon + 命令桥）换一个 adapter 实现即可，
 * `OfficeRibbonView` 不用改（spec §6.3）。
 */
import { useMemo } from 'react'
import { useDocxCommands } from '@betteroffice/docx-react'
import { createDocxCommandAdapter, type OfficeCommandSource } from './office-command-adapter'
import { OfficeRibbonView, type OfficeRibbonViewProps } from './OfficeRibbonView'

export type OfficeRibbonProps = Omit<OfficeRibbonViewProps, 'adapter'>

/** `DocxCommandStore` → 适配层依赖面（args 在运行时就是可序列化的命令参数） */
function sourceOf(commands: ReturnType<typeof useDocxCommands>): OfficeCommandSource {
  return {
    getDescriptor: (id) => commands.getDescriptor(id),
    getState: (id, args) => commands.getState(id, args as never),
    execute: (id, args) => commands.execute(id, args as never),
    subscribe: (listener) => commands.subscribe(listener)
  }
}

export function OfficeRibbon(props: OfficeRibbonProps): React.JSX.Element {
  const commands = useDocxCommands()
  const adapter = useMemo(() => createDocxCommandAdapter(sourceOf(commands)), [commands])
  return <OfficeRibbonView adapter={adapter} {...props} />
}
