import { ChevronDown, Copy, FileText, FolderSearch } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { absoluteOf, useWorkbenchRoot } from '@renderer/features/workbench/use-workbench-root'
import { formatBytes } from '@renderer/features/workbench/format'
import { useWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useShellStore } from '@renderer/lib/shell-store'
import type { Deliverable } from './deliverable'

/**
 * 交付卡（deliver_file 的工具结果；形态照 Kimi 的文件卡）：
 * 左 = 文件图标块（纸感底 + FileText），中 = 文件名 + 副行（大小 · 交付说明），
 * 右 = 「预览」主按钮 + ▾ 菜单（复制路径 / 在文件资源管理器中定位）。
 *
 * 为什么单开一张卡、而不是留在工具行里：交付是**给用户看东西**的动作，产出物不该埋在
 * "使用 N 个工具"的折叠块里（那一块这一轮跑完就自动收起了）。所以 Message 把交付完成的
 * deliver_file part 从过程块里**摘出来**单独渲染（见 Message.tsx 的 chunkParts）。
 *
 * 三个动作的去处：
 *   - 预览：workbench-store 的 openPreviewTab（按路径去重；右栏由**调用方**打开，
 *     与文件区「在新标签页中查看」同一口径）；
 *   - 复制路径：会话根判得出就给绝对路径，判不出退回相对路径（都不是安全边界，只给用户抄）；
 *   - 在文件资源管理器中定位：走既有 workbench:reveal（threadId + 相对路径，containment 在主进程，
 *     与文件区、会话菜单同一条通道 —— 没有新开 IPC）。
 *
 * 判不出唯一会话根时（多工作区并列、没有工作区）「定位」置灰：点了也到不了任何地方，
 * 不给假入口（与侧栏会话菜单的「在文件资源管理器中打开」同一口径）。
 */
export interface DeliverableCardProps {
  deliverable: Deliverable
}

export function DeliverableCard({ deliverable }: DeliverableCardProps): React.JSX.Element {
  // 会话根（渲染端的乐观镜像）与 reveal 通道：与文件区共用同一份取值口径
  const { threadId, rootPath, workbench } = useWorkbenchRoot()

  const openPreview = (): void => {
    useWorkbenchStore.getState().openPreviewTab(deliverable.path)
    useShellStore.getState().setWorkPanelOpen(true)
  }

  const copyPath = (): void => {
    const text = rootPath === null ? deliverable.path : absoluteOf(rootPath, deliverable.path)
    void navigator.clipboard?.writeText(text)
  }

  const reveal = (): void => {
    if (threadId === null || workbench === null) return
    void workbench.reveal(threadId, deliverable.path).catch((cause: unknown) => {
      console.error('[kyclaw] 在文件资源管理器中定位失败', unwrapIpcError(cause))
    })
  }

  const items: MenuEntry[] = [
    {
      id: 'copy-path',
      label: '复制路径',
      icon: <Copy />,
      testId: 'deliverable-copy-path',
      onSelect: copyPath
    },
    {
      id: 'reveal',
      label: '在文件资源管理器中定位',
      icon: <FolderSearch />,
      testId: 'deliverable-reveal',
      disabled: threadId === null || workbench === null || rootPath === null,
      onSelect: reveal
    }
  ]

  const meta = [formatBytes(deliverable.size), deliverable.note]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ')

  return (
    <div
      data-testid="deliverable-card"
      data-path={deliverable.path}
      className="animate-message-in flex items-center gap-3 rounded-panel border-(length:--hairline-width) border-hairline bg-secondary px-3 py-2.5"
    >
      {/* 图标块用底色分层，不再套第二层框线（雷点 7） */}
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface"
      >
        <FileText className="size-[18px] text-ink-tertiary" />
      </span>

      <span className="min-w-0 flex-1">
        <span data-testid="deliverable-name" className="block truncate text-b2 text-ink">
          {deliverable.name}
        </span>
        <span data-testid="deliverable-meta" className="block truncate text-c1 text-ink-tertiary">
          {meta}
        </span>
      </span>

      {/* 拆按钮：两段各自完整圆角（圆角里不套直角方框，雷点 6） */}
      <span className="flex shrink-0 items-center gap-0.5">
        <Button size="sm" data-testid="deliverable-preview" onClick={openPreview}>
          预览
        </Button>
        <Menu
          align="end"
          items={items}
          trigger={
            <button
              type="button"
              data-testid="deliverable-more"
              aria-label="更多操作"
              className="inline-flex h-(--control-height-sm) w-7 shrink-0 cursor-pointer items-center justify-center rounded-button-sm text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover data-[state=open]:bg-hover motion-reduce:transition-none"
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          }
        />
      </span>
    </div>
  )
}
