import {
  Briefcase,
  Library,
  MessageSquare,
  NotebookPen,
  Settings,
  type LucideIcon
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { primaryModuleOf, type PrimaryModuleId } from '@renderer/lib/primary-modules'
import { cn } from '../ui/cn'
import { navItemClass } from './nav-item'

interface ModuleEntry {
  id: PrimaryModuleId
  to: string
  label: string
  testId: string
  icon: LucideIcon
}

const MODULE_ENTRIES: ModuleEntry[] = [
  { id: 'chat', to: '/chat', label: '主对话', testId: 'primary-nav-chat', icon: MessageSquare },
  { id: 'notes', to: '/notes', label: '笔记', testId: 'primary-nav-notes', icon: NotebookPen },
  {
    id: 'knowledge',
    to: '/knowledge',
    label: '知识库',
    testId: 'primary-nav-knowledge',
    icon: Library
  },
  { id: 'office', to: '/office', label: 'Office', testId: 'primary-nav-office', icon: Briefcase }
]

/**
 * 一级导航（0.2.0 应用壳；2026-10-17 用户拍板参考 Codex 布局）：**只有图标栏一种形态**。
 *
 * 它是**流式布局**的一根竖栏（不是覆盖层，也不再有展开/收起两档）：固定 --primary-nav-rail-width
 * （56），内容区真的从它右缘开始，几何不随任何开关变。会话列表与项目/任务组不在这里 ——
 * 那是主对话模块的二级栏（在内容卡内部，见 AppShell 的 Sidebar 分支）。
 *
 * 只有图标，但没有失去可访问名：标签文字不渲染，按钮带 aria-label / title，读屏与 hover 提示都不缺。
 * 2026-10-17 之前那套「200 展开态 + 顶部 ChevronsLeft/Right 开关」按用户口径整档退休
 * （store 字段与 --primary-nav-width 一并删掉），所以这里不订阅任何 store、没有展开相关状态。
 */
export function PrimaryNav(): React.JSX.Element {
  const navigate = useNavigate()
  const pathname = useLocation().pathname
  const activeModule = primaryModuleOf(pathname)

  return (
    <nav
      data-testid="primary-nav"
      aria-label="主导航"
      className="flex w-(--primary-nav-rail-width) shrink-0 flex-col justify-between bg-canvas p-2"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5">
        {MODULE_ENTRIES.map((entry) => {
          const selected = activeModule === entry.id
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              data-testid={entry.testId}
              aria-label={entry.label}
              aria-current={selected ? 'page' : undefined}
              title={entry.label}
              className={cn(navItemClass({ selected }), 'justify-center px-0')}
              onClick={() => navigate(entry.to)}
            >
              <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
                <Icon />
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          data-testid="primary-nav-settings"
          aria-label="设置"
          aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          title="设置"
          className={cn(
            navItemClass({ selected: pathname.startsWith('/settings') }),
            'justify-center px-0'
          )}
          onClick={() => navigate('/settings')}
        >
          <span aria-hidden="true" className="size-(--icon-size-md) shrink-0 [&>svg]:size-full">
            <Settings />
          </span>
        </button>
      </div>
    </nav>
  )
}
