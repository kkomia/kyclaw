/**
 * 工作台（右栏内容）：四个工具的 tab 栏 + 面板容器。
 *
 * 挂载策略：**懒挂载 + 保活**。点过哪个 tab 才挂哪个（各工具的 IPC 订阅因此只在用时建立）；
 * 挂过的面板**不卸载**，只是隐藏 —— 终端切走必须保活（PTY 还在跑），浏览器切走也不该整页重载。
 * 隐藏走 `invisible + opacity-0`（`transition-[opacity,visibility]`）：visibility 在过渡结束时才翻，
 * 所以淡出是完整的、不硬切（雷点 5）。
 *
 * 面板底铺 `bg-surface`（与内容区同色，看不出差别）：万一 `<webview>` 这种原生客人不吃祖先的
 * visibility，后画的工具面板仍能把它盖住（浏览器是第一个 tab，DOM 顺序在最后）。
 */
import { FolderTree, GitBranch, Globe, SquareTerminal, type LucideIcon } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useWorkbenchRoot, type WorkbenchRoot } from './use-workbench-root'
import { useWorkbenchStore, WORKBENCH_TABS, type WorkbenchTab } from './workbench-store'
import { BrowserTool } from './BrowserTool'
import { FilesTool } from './FilesTool'
import { GitTool } from './GitTool'
import { TerminalTool } from './TerminalTool'

const TAB_LABEL: Record<WorkbenchTab, string> = {
  browser: '浏览器',
  files: '文件',
  git: 'Git',
  terminal: '终端'
}

const TAB_ICON: Record<WorkbenchTab, LucideIcon> = {
  browser: Globe,
  files: FolderTree,
  git: GitBranch,
  terminal: SquareTerminal
}

export function Workbench(): React.JSX.Element {
  const activeTab = useWorkbenchStore((state) => state.activeTab)
  const mounted = useWorkbenchStore((state) => state.mounted)
  const select = useWorkbenchStore((state) => state.select)
  const root = useWorkbenchRoot()

  return (
    <div data-testid="workbench" className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="工作台工具"
        className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline px-2"
      >
        {WORKBENCH_TABS.map((tab) => {
          const Icon = TAB_ICON[tab]
          const active = activeTab === tab
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`workbench-tab-${tab}`}
              onClick={() => select(tab)}
              className={cn(
                'flex h-7 cursor-default items-center gap-1.5 rounded-control px-2 text-b2 transition-colors duration-(--motion-fast) ease-main',
                active ? 'bg-selected text-ink' : 'text-ink-secondary hover:bg-hover'
              )}
            >
              <Icon aria-hidden="true" className="size-(--icon-size-sm) shrink-0" />
              <span>{TAB_LABEL[tab]}</span>
            </button>
          )
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        {mounted.map((tab) => {
          const active = activeTab === tab
          return (
            <section
              // 依赖会话根的三件（文件/Git/终端）按会话重挂：换会话时状态自然清空、
              // 终端的 cwd 也换到新根；浏览器与会话无关，切会话不重载页面。
              key={tab === 'browser' ? tab : `${tab}:${root.threadId ?? 'none'}`}
              role="tabpanel"
              aria-label={TAB_LABEL[tab]}
              data-testid={`workbench-panel-${tab}`}
              data-active={active ? 'true' : 'false'}
              inert={!active}
              className={cn(
                'absolute inset-0 flex min-h-0 flex-col bg-surface transition-[opacity,visibility] duration-(--motion-main) ease-main',
                active ? 'visible opacity-100' : 'pointer-events-none invisible opacity-0'
              )}
            >
              {renderTool(tab, root, active)}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function renderTool(tab: WorkbenchTab, root: WorkbenchRoot, active: boolean): React.JSX.Element {
  switch (tab) {
    case 'browser':
      return <BrowserTool />
    case 'files':
      return <FilesTool root={root} />
    case 'git':
      return <GitTool root={root} />
    case 'terminal':
      return <TerminalTool root={root} active={active} />
  }
}
