import { useCallback, useEffect, useRef, useState } from 'react'
import { Briefcase, Plus } from 'lucide-react'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { OFFICE_KIND_ICON, OFFICE_KIND_LABEL, OFFICE_PANEL_ID } from './office-kinds'
import { OfficeSurface, type OfficeSurfaceStatus } from './OfficeSurface'
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'
import { useOfficeUiStore } from './office-ui-store'
import { useDocumentTheme } from './use-document-theme'

/**
 * Office 模块：独立于会话的多标签工作区。
 *
 * 2026-10-17（M3-S2）：mook「打开文件（示例）」列表已删；入口换成主进程的真实选择器
 * （`window.kyclaw.office.openDialog()`，取消是一等结果）。成功打开后由注册表回
 * `OfficeDocumentInfo`，`openDocument` 按 **documentId** 去重/激活标签。
 *
 * 顶栏「＋」仍走 office-ui-store 的 `pickerOpen` 标志（AppTabBar 与空态按钮共用一个动作）：
 * 页面看到标志置位就发起一次真实选择器请求，然后立刻把标志清掉。用 ref 去重是为了
 * React StrictMode 的 effect 双跑不会弹两次原生对话框。
 */
export function OfficePage(): React.JSX.Element {
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const activeTabId = useOfficeTabsStore((state) => state.activeTabId)
  const openDocument = useOfficeTabsStore((state) => state.openDocument)
  const pickerOpen = useOfficeUiStore((state) => state.pickerOpen)
  const setPickerOpen = useOfficeUiStore((state) => state.setPickerOpen)

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState('')
  /** 面 URL 由主进程下发（dev 端口随 Vite 走；preview/打包是 kyclaw-office://surface/） */
  const [surfaceUrl, setSurfaceUrl] = useState<string | undefined>(undefined)
  /** 标志消费去重（StrictMode 双跑 / 连点「＋」时只发一次） */
  const openingFromFlagRef = useRef(false)

  useEffect(() => {
    let alive = true
    void window.kyclaw?.office
      .config()
      .then((config) => {
        if (alive) setSurfaceUrl(config.surfaceUrl)
      })
      .catch(() => {
        // 读不到配置就退回渲染端自算（surface-url.ts），不拦打开文档
      })
    return () => {
      alive = false
    }
  }, [])

  const openViaDialog = useCallback(async (): Promise<void> => {
    setOpening(true)
    setOpenError('')
    try {
      const result = await window.kyclaw.office.openDialog()
      if (result.ok) {
        openDocument(result.document)
        return
      }
      // 取消是用户自己的动作，不报错；其余分类原样显示主进程给的人话
      if (result.code !== 'cancelled') setOpenError(result.message)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(false)
    }
  }, [openDocument])

  // 顶栏「＋」→ 标志置位 → 这里发起一次真实选择器（并立刻消费掉标志）
  useEffect(() => {
    if (!pickerOpen || openingFromFlagRef.current) return
    openingFromFlagRef.current = true
    setPickerOpen(false)
    void openViaDialog().finally(() => {
      openingFromFlagRef.current = false
    })
  }, [pickerOpen, setPickerOpen, openViaDialog])

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
              打开一份 .docx 文档开始；标签不绑定会话，切换会话不会关掉这里。
            </p>
          </div>
          <Button
            data-testid="office-open"
            icon={<Plus />}
            loading={opening}
            disabled={opening}
            onClick={() => void openViaDialog()}
          >
            打开文件
          </Button>
          {openError === '' ? null : (
            <p
              data-testid="office-open-error"
              role="alert"
              className="max-w-md text-c1 text-warning"
            >
              {openError}
            </p>
          )}
        </div>
      ) : activeTab === undefined ? null : (
        // key 把每一份文档的隔离面隔开：切标签时重建 iframe（S4 的保活/多实例策略再改）
        <OfficeWorkspace key={activeTab.id} tab={activeTab} surfaceUrl={surfaceUrl} />
      )}
    </section>
  )
}

/** 有标签时的内容区：当前标签的标题/来源 + dirty 状态 + 编辑器占位 */
function OfficeWorkspace({
  tab,
  surfaceUrl
}: {
  tab: OfficeTab
  surfaceUrl?: string
}): React.JSX.Element {
  const Icon = OFFICE_KIND_ICON[tab.kind]
  const source = tab.path ?? tab.url ?? ''
  // M3-S2（临时）：DOCX 标签挂隔离面；字节由 office:read 取回，ready 后经 postMessage 投递。
  // 编辑器内核在 S3；其它格式仍是占位。
  const isDocx = tab.kind === 'docx'
  const theme = useDocumentTheme()
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

  /** 主进程回包里的文档信息 + 字节（S2 只在内存里中转给面，壳不持久化） */
  const [loaded, setLoaded] = useState<{
    info: OfficeDocumentInfo
    bytes: Uint8Array
  } | null>(null)
  const [docError, setDocError] = useState('')

  useEffect(() => {
    // 每个标签一份 OfficeWorkspace（父组件用 key=tab.id），切标签会重建 → 这里不需要复位状态
    if (!isDocx || tab.documentId === undefined) return
    let alive = true
    const read = window.kyclaw?.office?.read
    if (typeof read !== 'function') {
      // 桥缺失：异步回调置错（effect 体内不直接 setState，避免级联渲染告警）
      void Promise.resolve().then(() => {
        if (alive) setDocError('Office 通道不可用')
      })
      return () => {
        alive = false
      }
    }
    void read(tab.documentId)
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setLoaded({ info: result.document, bytes: result.bytes })
        } else {
          setDocError(result.message)
        }
      })
      .catch((error: unknown) => {
        if (alive) setDocError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      alive = false
    }
  }, [isDocx, tab.documentId])

  return (
    <div
      id={OFFICE_PANEL_ID}
      role="tabpanel"
      aria-labelledby={`office-tab-${tab.id}`}
      data-testid="office-workspace"
      data-kind={tab.kind}
      data-document-id={tab.documentId ?? ''}
      data-document-state={loaded === null ? (docError === '' ? 'loading' : 'error') : 'loaded'}
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
          <div className="relative flex min-h-0 flex-1 flex-col">
            <OfficeSurface
              onStatusChange={handleSurfaceStatus}
              theme={theme}
              documentInfo={loaded?.info}
              documentBytes={loaded?.bytes}
              surfaceUrl={surfaceUrl}
            />
            {docError === '' ? null : (
              <p
                data-testid="office-doc-error"
                role="alert"
                className="absolute inset-x-0 bottom-0 border-t border-hairline bg-secondary px-4 py-2 text-c1 text-warning"
              >
                {docError}
              </p>
            )}
          </div>
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
