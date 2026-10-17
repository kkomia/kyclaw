import { Briefcase, ChevronDown, Copy, FolderSearch, SquareArrowOutUpRight } from 'lucide-react'
import { createElement, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import {
  goToOffice,
  isOfficeEditablePath,
  openOfficeFromSession
} from '@renderer/features/workbench/office-open'
import { absoluteOf, useWorkbenchRoot } from '@renderer/features/workbench/use-workbench-root'
import { formatBytes } from '@renderer/features/workbench/format'
import { fileIconOf } from '@renderer/features/workbench/preview/file-icon'
import { useWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useShellStore } from '@renderer/lib/shell-store'
import type { Deliverable } from './deliverable'

/**
 * 交付卡（deliver_file 的工具结果；形态照 Kimi 的文件卡）：
 * 左 = 文件图标块（纸感底 + 按交付文件类型的彩色图标，见 workbench/preview/file-icon.ts），
 * 中 = 文件名 + 副行（大小 · 交付说明），
 * 右 = 「预览」主按钮 + ▾ 菜单（用本地应用打开 / 复制路径 / 在文件资源管理器中定位）。
 *
 * 为什么单开一张卡、而不是留在工具行里：交付是**给用户看东西**的动作，产出物不该埋在
 * "使用 N 个工具"的折叠块里（那一块这一轮跑完就自动收起了）。所以 Message 把交付完成的
 * deliver_file part 从过程块里**摘出来**；0.1.3 / 014 起整轮汇总到消息末尾统一渲染
 * （见 Message.tsx 的 chunkParts 与 deliverable.ts 的 deliverablesByTurnTail）。
 *
 * 五个动作的去处：
 *   - 在 Office 中编辑（M3-S4，仅 .docx 交付物）：`office:open-from-session`（只给 threadId + 相对路径）
 *     → 标签打开/激活 → 跳 /office；**只跳转不复制聊天状态**（草稿/引用/选中都不带过去），
 *     失败把主进程的人话落在卡下面那行红字里；
 *   - 预览：workbench-store 的 openPreviewTab（按路径去重；右栏由**调用方**打开，
 *     与文件区「在新标签页中查看」同一口径）；
 *   - 用本地应用打开：走既有 workbench:open（threadId + 相对路径，containment 在主进程）——
 *     用户个人 PC 上通常装了 Word / WPS / Excel 之一，交付物直接交回他熟悉的那件应用；
 *   - 复制路径：会话根判得出就给绝对路径，判不出退回相对路径（都不是安全边界，只给用户抄）；
 *   - 在文件资源管理器中定位：走既有 workbench:reveal（同一条通道口径）。
 *
 * 判不出唯一会话根时（多工作区并列、没有工作区）「定位」与「用本地应用打开」都置灰：
 * 点了也到不了任何地方，不给假入口（与侧栏会话菜单的「在文件资源管理器中打开」同一口径）。
 *
 * 打开失败**如实说**（卡下面一行红字，`role="alert"`）：不假装打开过 —— 系统没装能开这种文件的
 * 应用、文件刚被删掉、被安全软件拦下，都是真会发生的事，用户要能看到原因。
 */
export interface DeliverableCardProps {
  deliverable: Deliverable
}

export function DeliverableCard({ deliverable }: DeliverableCardProps): React.JSX.Element {
  // 会话根（渲染端的乐观镜像）与 reveal / open 通道：与文件区共用同一份取值口径
  const { threadId, rootPath, workbench } = useWorkbenchRoot()
  /** 打开/定位失败的人话（null = 没失败过）；换一份交付物时由 key 重挂自然清掉 */
  const [openError, setOpenError] = useState<string | null>(null)
  /** 正在开 Office 标签（防连点；主进程来回一次通常几十毫秒） */
  const [officeOpening, setOfficeOpening] = useState(false)

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
      console.error('[kyclaw] 在文件资源管理器中定位失败', cause)
      setOpenError(unwrapIpcError(cause))
    })
  }

  /** 用系统默认应用打开（本机装了 Word / WPS / Excel 时就是它们）；失败把原因原样露出来 */
  const openWithApp = (): void => {
    if (threadId === null || workbench === null) return
    setOpenError(null)
    void workbench.open(threadId, deliverable.path).catch((cause: unknown) => {
      console.error('[kyclaw] 用本地应用打开失败', cause)
      setOpenError(unwrapIpcError(cause))
    })
  }

  /**
   * M3-S4：在 Office 标签里编辑这份 docx（与文件树入口共用 workbench/office-open 的同一份逻辑）。
   * 只跳转 + 激活标签：**不复制聊天状态**（草稿/引用/选中都不带过去），也不顺带开右栏预览。
   * 成功才跳；失败把主进程的人话落在卡下面那行红字里（不弹窗、不假装打开）。
   */
  const openInOffice = (): void => {
    if (threadId === null || workbench === null || officeOpening) return
    setOpenError(null)
    setOfficeOpening(true)
    void (async () => {
      try {
        await openOfficeFromSession(threadId, deliverable.path)
        goToOffice()
      } catch (cause) {
        console.error('[kyclaw] 在 Office 中编辑失败', cause)
        setOpenError(unwrapIpcError(cause))
      } finally {
        setOfficeOpening(false)
      }
    })()
  }

  /** 判不出唯一会话根时，两条"交给系统"的入口都不给（点了也到不了任何地方） */
  const noRoot = threadId === null || workbench === null || rootPath === null
  /**
   * Office 入口只需要会话（主进程自己按 threadId 解析根）——rootPath 判不出也可能能打开
   * （多工作区并列时同样适用），所以不复用 `noRoot`。
   */
  const noOffice = threadId === null || workbench === null

  const items: MenuEntry[] = [
    // M3-S4：docx 交付物在菜单首项给「在 Office 中编辑」（非 docx 不给假入口）
    ...(isOfficeEditablePath(deliverable.path)
      ? [
          {
            id: 'open-in-office',
            label: '在 Office 中编辑',
            icon: <Briefcase />,
            testId: 'deliverable-open-office',
            disabled: noOffice || officeOpening,
            onSelect: openInOffice
          } satisfies MenuEntry
        ]
      : []),
    {
      id: 'open-with-app',
      label: '用本地应用打开',
      icon: <SquareArrowOutUpRight />,
      testId: 'deliverable-open',
      disabled: noRoot,
      onSelect: openWithApp
    },
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
      disabled: noRoot,
      onSelect: reveal
    }
  ]

  const meta = [formatBytes(deliverable.size), deliverable.note]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ')

  return (
    <>
      <div
        data-testid="deliverable-card"
        data-path={deliverable.path}
        className="animate-message-in flex items-center gap-3 rounded-panel border-(length:--hairline-width) border-surface-border bg-secondary px-3 py-2.5"
      >
        {/* 图标块用底色分层，不再套第二层框线（雷点 7）；图标是彩色的（自带 fill），
            不再套 `text-ink-tertiary` 那层灰 */}
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface"
        >
          {createElement(fileIconOf(deliverable.path), { className: 'size-[18px]' })}
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

      {/* 打开/定位失败：卡下面一行红字（兄弟节点，不挤坏卡里那条单行布局）。
          位置在文章级的 flex-col gap 里，与卡同属一个消息块 */}
      {openError === null ? null : (
        <p data-testid="deliverable-action-error" role="alert" className="text-c1 text-danger">
          {openError}
        </p>
      )}
    </>
  )
}
