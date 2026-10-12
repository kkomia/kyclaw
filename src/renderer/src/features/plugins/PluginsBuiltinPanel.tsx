import { ChevronRight, Globe } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@renderer/components/ui/cn'
import { TraceFold } from '@renderer/features/chat/parts/TraceFold'
import { BUILTIN_PLUGINS, type BuiltinPlugin } from './builtin-plugins'
import { PluginAvatar } from './PluginAvatar'
import { WebSearchSettings } from './WebSearchSettings'

/**
 * 插件页「插件」栏的**内置插件**一组（round 48）：随应用常驻、不依赖任何市场、没有卸载。
 * 行的外观与市场来的插件行同一套（头像位 + 名称 + 一句能做什么），只是没有安装 / 卸载按钮：
 * **整行可点 = 展开它的设置面**（与项目行、过程块同一套交互惯例），展开走全局折叠配方
 * `.trace-fold`（grid-template-rows 双向过渡 + 内容 blur/位移，不硬切）。
 *
 * 内置插件的明细只在这里出现：设置页不再有「联网搜索」组（用户口径：配置别摆在最外层）。
 * 新增内置插件时在 builtin-plugins.ts 加一条，这里的 ROW_ICONS / DETAIL_PANELS 按同一个 id 挂。
 */
const ROW_ICONS: Record<string, React.JSX.Element> = {
  'web-search': <Globe className="size-(--icon-size-md)" />
}

const DETAIL_PANELS: Record<string, () => React.JSX.Element> = {
  'web-search': WebSearchSettings
}

/** 行的头像位（与 PluginAvatar 同为 size-8 / rounded-control）：登记过图标用图标，否则回字母头像 */
function BuiltinPluginAvatar({ plugin }: { plugin: BuiltinPlugin }): React.JSX.Element {
  const icon = ROW_ICONS[plugin.id]
  if (icon === undefined) return <PluginAvatar name={plugin.name} />
  return (
    <span
      data-testid="plugin-avatar"
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-control bg-selected text-ink-secondary"
    >
      {icon}
    </span>
  )
}

function BuiltinPluginRow({ plugin }: { plugin: BuiltinPlugin }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Detail = DETAIL_PANELS[plugin.id]

  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid={`builtin-plugin-${plugin.id}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
      >
        <BuiltinPluginAvatar plugin={plugin} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-b1 font-medium text-ink">{plugin.name}</span>
          <span className="min-w-0 truncate text-c1 text-ink-secondary">{plugin.description}</span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>

      {Detail === undefined ? null : (
        <TraceFold open={open}>
          <div data-testid={`builtin-plugin-${plugin.id}-settings`} className="px-3 pt-1 pb-2">
            <Detail />
          </div>
        </TraceFold>
      )}
    </div>
  )
}

export function PluginsBuiltinPanel(): React.JSX.Element {
  return (
    <section data-testid="builtin-plugins" className="flex flex-col gap-1">
      <h2 className="px-3 text-b2 font-medium text-ink">内置插件</h2>
      {BUILTIN_PLUGINS.map((plugin) => (
        <BuiltinPluginRow key={plugin.id} plugin={plugin} />
      ))}
    </section>
  )
}
