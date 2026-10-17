import { useState } from 'react'
import { Briefcase, Plus } from 'lucide-react'
import { navItemClass } from '@renderer/components/shell/nav-item'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { OFFICE_KIND_ICON, OFFICE_KIND_LABEL, OFFICE_PANEL_ID } from './office-kinds'
import { OfficeSurface, type OfficeSurfaceStatus } from './OfficeSurface'
import { useOfficeTabsStore, type OfficeOpenInput, type OfficeTab } from './office-tabs-store'
import { useOfficeUiStore } from './office-ui-store'

/**
 * Office 模块：独立于会话的多标签工作区（0.2.0 只做标签与宿主骨架）。
 *
 * 2026-10-17（顶侧多标签页打样）：标签条搬进了 TitleBar（AppTabBar，跨路由常驻），这里只留
 * **当前激活标签的 workspace 占位**与空态；「打开文件」入口也从页面内那一行去掉了（顶栏「＋」
 * 与空态按钮都能打开同一个示例弹窗，弹窗开关走 office-ui-store）。
 *
 * 这里没有聊天、会话列表或第二个 ChatPage —— 主对话只属于 ModuleHost 里那个常驻实例。
 * 文件选择、编辑器接入与持久化都还没做，「打开文件」先弹一份示例列表，用来验证
 * 空态 → 标签 → 内容占位的切换。
 */
const MOCK_ENTRIES: readonly OfficeOpenInput[] = [
  { kind: 'docx', path: '示例文档/项目计划.docx', title: '项目计划' },
  { kind: 'pptx', path: '示例文档/季度汇报.pptx', title: '季度汇报' },
  { kind: 'xlsx', path: '示例文档/预算表.xlsx', title: '预算表' },
  { kind: 'pdf', path: '示例文档/产品说明.pdf', title: '产品说明' },
  { kind: 'image', path: '示例文档/界面截图.png', title: '界面截图' },
  { kind: 'text', path: '示例文档/会议记录.txt', title: '会议记录' },
  { kind: 'web', url: 'https://example.com/handbook', title: '示例网页' }
]

export function OfficePage(): React.JSX.Element {
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const activeTabId = useOfficeTabsStore((state) => state.activeTabId)
  const open = useOfficeTabsStore((state) => state.open)
  const pickerOpen = useOfficeUiStore((state) => state.pickerOpen)
  const setPickerOpen = useOfficeUiStore((state) => state.setPickerOpen)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  const openMock = (entry: OfficeOpenInput): void => {
    open(entry)
    setPickerOpen(false)
  }

  return (
    <section data-testid="office-page" className="animate-page-in flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <Briefcase aria-hidden="true" className="size-(--icon-size-sm) text-ink-tertiary" />
        <h1 data-testid="office-page-title" className="text-t2 font-medium text-ink">
          Office
        </h1>
      </header>

      {tabs.length === 0 ? (
        <div
          data-testid="office-empty"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
        >
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-panel bg-secondary text-ink-tertiary"
          >
            <Briefcase className="size-(--icon-size-lg)" />
          </span>
          <div className="flex max-w-md flex-col gap-1">
            <h2 className="text-t2 font-medium text-ink">还没有打开的文档</h2>
            <p className="text-b2 text-ink-secondary">
              打开 Word、PPT、Excel、PDF、图片或文本文件，也可以加一个网页。标签不绑定会话，
              切换会话不会关掉这里。
            </p>
          </div>
          <Button data-testid="office-open" icon={<Plus />} onClick={() => setPickerOpen(true)}>
            打开文件
          </Button>
        </div>
      ) : activeTab === undefined ? null : (
        <OfficeWorkspace tab={activeTab} />
      )}

      <Dialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="打开文件（示例）"
        description="真实文件选择还没接入；先打开一份示例，验证标签骨架。"
        footer={
          <Button variant="ghost" onClick={() => setPickerOpen(false)}>
            取消
          </Button>
        }
      >
        <ul data-testid="office-mock-files" className="flex flex-col gap-0.5">
          {MOCK_ENTRIES.map((entry) => {
            const Icon = OFFICE_KIND_ICON[entry.kind]
            const detail = entry.kind === 'web' ? entry.url : entry.path
            return (
              <li key={`${entry.kind}:${detail}`}>
                <button
                  type="button"
                  data-testid={`office-mock-open-${entry.kind}`}
                  className={cn(navItemClass(), 'text-left')}
                  onClick={() => openMock(entry)}
                >
                  <Icon
                    aria-hidden="true"
                    className="size-(--icon-size-md) shrink-0 text-ink-tertiary"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  <span className="max-w-40 truncate text-c1 text-ink-tertiary">{detail}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </Dialog>
    </section>
  )
}

/** 有标签时的内容区：当前标签的标题/来源 + dirty 状态 + 编辑器占位 */
function OfficeWorkspace({ tab }: { tab: OfficeTab }): React.JSX.Element {
  const Icon = OFFICE_KIND_ICON[tab.kind]
  const source = tab.path ?? tab.url ?? ''
  // M3-S1（临时调试）：DOCX 标签挂隔离面，状态条把 loading/ready/fatal 露出来；
  // 不接编辑器，其它格式仍是占位。S2 起由文档注册表/编辑器取代这块。
  const isDocx = tab.kind === 'docx'
  // 状态带 tabId：同一个 OfficeWorkspace 实例跨标签复用，切走再切回来时旧状态自动失效
  // （不用 effect 复位——render 期按 tab.id 过滤，天然回到 loading）
  const [surfaceState, setSurfaceState] = useState<{ tabId: string; status: OfficeSurfaceStatus }>({
    tabId: tab.id,
    status: 'loading'
  })
  const surfaceStatus = surfaceState.tabId === tab.id ? surfaceState.status : 'loading'
  const handleSurfaceStatus = (status: OfficeSurfaceStatus): void => {
    setSurfaceState({ tabId: tab.id, status })
  }

  return (
    <div
      id={OFFICE_PANEL_ID}
      role="tabpanel"
      aria-labelledby={`office-tab-${tab.id}`}
      data-testid="office-workspace"
      className="flex min-h-0 flex-1 flex-col p-4"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border-(length:--hairline-width) border-hairline bg-secondary">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden="true" className="size-(--icon-size-md) shrink-0 text-ink-tertiary" />
            <div className="min-w-0">
              <p className="truncate text-b2 font-medium text-ink" title={tab.title}>
                {tab.title}
              </p>
              <p className="truncate text-c1 text-ink-tertiary" title={source}>
                {source}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isDocx ? (
              // M3-S1 临时调试展示：隔离面握手状态（S2 接编辑器后由真实文档状态取代）
              <span
                data-testid="office-surface-status"
                data-state={surfaceStatus}
                title="Office 隔离面握手状态（S1 调试展示）"
                className="inline-flex items-center rounded-badge bg-selected px-1.5 py-0.5 text-c2 text-ink-tertiary"
              >
                隔离面 {surfaceStatus}
              </span>
            ) : null}
            {tab.readOnly ? (
              <span className="rounded-badge border-(length:--hairline-width) border-hairline px-1.5 py-0.5 text-c2 text-ink-tertiary">
                只读
              </span>
            ) : null}
            <span
              data-testid="office-dirty-status"
              data-dirty={tab.dirty ? 'true' : 'false'}
              title={tab.dirty ? '有未保存的修改' : '编辑器还没接上，这里不是"已保存"'}
              className={cn(
                'inline-flex items-center rounded-badge px-1.5 py-0.5 text-c2',
                tab.dirty ? 'bg-(--fill-selected) text-warning' : 'bg-selected text-ink-tertiary'
              )}
            >
              {/* 用户 2026-10-17：编辑器没接之前「● 已保存」是在撒谎 —— 改成中性占位，
                  去掉绿点/「已保存」字样；data-dirty 语义留着，接上编辑器后按真实保存态切换。 */}
              {tab.dirty ? '未保存修改' : '未接编辑器'}
            </span>
          </div>
        </div>
        {isDocx ? (
          <OfficeSurface onStatusChange={handleSurfaceStatus} />
        ) : (
          <div
            data-testid="office-editor-placeholder"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          >
            <Icon aria-hidden="true" className="size-(--icon-size-lg) text-ink-tertiary" />
            <p className="text-b2 text-ink-secondary">编辑器接入中</p>
            <p className="max-w-md text-c1 text-ink-tertiary">
              {OFFICE_KIND_LABEL[tab.kind]}编辑器会在这里打开；切换标签不会关闭或重置其他文档。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
