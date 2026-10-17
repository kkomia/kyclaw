import { useState } from 'react'
import { Archive, FolderInput, FolderMinus, FolderOpen, Pencil, Pin, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  Menu,
  type MenuActionItem,
  type MenuEntry,
  type MenuProps,
  type MenuSeparatorItem
} from '@renderer/components/ui/menu'
import { useSessionActions } from './useSessionActions'
import type { ReactElement } from 'react'

/**
 * 会话动作菜单（round 24 抽取）：侧栏行 ⋯ 与对话页顶部栏的名称菜单**同一个组件**——
 * 条目顺序照图3：置顶（toggle）/ 移至项目 ▸ / 从「<项目>」中移除（归属项目时才出）/
 * 在文件资源管理器中打开 / 重命名 / 归档 / 删除（danger 最后）。
 * 「反馈」没有渠道，如实不做（round 24 报告注明）。
 *
 * 重命名与删除是组件内的受控 Dialog（R12：删除二次确认、重命名输入框）——testid 沿用侧栏
 * （`session-rename-*` / `session-delete-*`），两处（侧栏、顶栏）共用同一套流程；
 * 动作接线在 useSessionActions（同一份），动作后的状态同步走 store（侧栏与顶栏即时一致）。
 */
export interface SessionActionsMenuProps {
  threadId: string
  /** 会话标题（dialog 文案与归档快照用；null = 还没生成） */
  title: string | null
  /** 触发元素（侧栏 = ⋯ 图标钮；顶栏 = 名称 + chevron） */
  trigger: ReactElement
  align?: MenuProps['align']
  side?: MenuProps['side']
  tooltip?: string
  /** 失败露哪（选项：侧栏的就地错误行 / 顶栏下方一行）；缺省只记日志 */
  onError?: (message: string) => void
}

/** 未命名会话的占位标题（与侧栏列表同口径） */
const UNTITLED = '新会话'

export function SessionActionsMenu({
  threadId,
  title,
  trigger,
  align = 'end',
  side = 'bottom',
  tooltip,
  onError
}: SessionActionsMenuProps): React.JSX.Element {
  const { context, togglePin, moveToProject, openInExplorer, archive, rename, remove } =
    useSessionActions({ threadId, title, onError })

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const openRename = (): void => {
    setRenameDraft(title ?? '')
    setRenameOpen(true)
  }

  const submitRename = (): void => {
    const next = renameDraft.trim()
    if (next === '') return
    rename(next)
    setRenameOpen(false)
  }

  const currentProject =
    context.projectId === null
      ? null
      : (context.projects.find((project) => project.id === context.projectId) ?? null)

  const moveItems: Array<MenuActionItem | MenuSeparatorItem> = [
    ...context.projects.map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      testId: `session-move-${threadId}-${project.id}`,
      selected: context.projectId === project.id,
      onSelect: () => moveToProject(project.id)
    })),
    ...(context.projects.length > 0 ? [{ id: 'sep', type: 'separator' as const }] : []),
    {
      id: 'none',
      label: '无项目',
      testId: `session-move-none-${threadId}`,
      selected: context.projectId === null,
      onSelect: () => moveToProject(null)
    }
  ]

  const items: MenuEntry[] = [
    {
      id: 'pin',
      label: context.pinned ? '取消置顶' : '置顶',
      icon: <Pin />,
      testId: `session-pin-${threadId}`,
      onSelect: () => togglePin(!context.pinned)
    },
    {
      id: 'move',
      type: 'submenu',
      label: '移至项目',
      icon: <FolderInput />,
      testId: `session-move-${threadId}`,
      items: moveItems
    },
    // 图3 的「从 <项目> 中移除」：归属项目时才出现（= 归属置空，T18 映射通道）
    ...(currentProject === null
      ? []
      : [
          {
            id: 'leave-project',
            label: `从「${currentProject.name}」中移除`,
            icon: <FolderMinus />,
            testId: `session-leave-project-${threadId}`,
            onSelect: () => moveToProject(null)
          } satisfies MenuEntry
        ]),
    {
      id: 'open-explorer',
      label: '在文件资源管理器中打开',
      icon: <FolderOpen />,
      testId: `session-open-${threadId}`,
      disabled: !context.canOpenExplorer,
      onSelect: openInExplorer
    },
    { id: 'sep-actions', type: 'separator' },
    {
      id: 'rename',
      label: '重命名',
      icon: <Pencil />,
      testId: `session-rename-${threadId}`,
      onSelect: openRename
    },
    {
      id: 'archive',
      label: '归档',
      icon: <Archive />,
      testId: `session-archive-${threadId}`,
      onSelect: archive
    },
    { id: 'sep-danger', type: 'separator' },
    {
      id: 'delete',
      label: '删除',
      icon: <Trash2 />,
      danger: true,
      testId: `session-delete-${threadId}`,
      onSelect: () => setDeleteOpen(true)
    }
  ]

  return (
    <>
      <Menu trigger={trigger} items={items} align={align} side={side} tooltip={tooltip} />

      {/* 重命名：受控 Dialog（R12），输入框初始值为当前标题 */}
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!open) setRenameOpen(false)
        }}
        title="重命名会话"
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="session-rename-cancel"
              onClick={() => setRenameOpen(false)}
            >
              取消
            </Button>
            <Button
              data-testid="session-rename-save"
              disabled={renameDraft.trim() === ''}
              onClick={submitRename}
            >
              保存
            </Button>
          </>
        }
      >
        <Input
          data-testid="session-rename-input"
          aria-label="会话标题"
          value={renameDraft}
          autoFocus
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submitRename()
          }}
        />
      </Dialog>

      {/* 删除：受控 Dialog，二次确认（R12） */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false)
        }}
        title="删除会话？"
        description={`「${title ?? UNTITLED}」及其全部消息会被删除，无法撤销。`}
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="session-delete-cancel"
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="session-delete-confirm"
              onClick={() => {
                setDeleteOpen(false)
                remove()
              }}
            >
              删除
            </Button>
          </>
        }
      />
    </>
  )
}
