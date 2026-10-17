import { useCallback, useEffect, useRef, useState } from 'react'
import { Briefcase, Plus, Sparkles } from 'lucide-react'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { OFFICE_KIND_ICON, OFFICE_KIND_LABEL, officePanelIdOf } from './office-kinds'
import {
  handleOfficeShortcut,
  registerOfficeRuntime,
  saveOfficeTab,
  type OfficeShortcutAction
} from './office-actions'
import { OfficeAiPanel } from './OfficeAiPanel'
import { OfficeStatusBar } from './OfficeStatusBar'
import { OfficeSurface, type OfficeSurfaceHandle, type OfficeSurfaceStatus } from './OfficeSurface'
import { createOfficeSaveMachine, type OfficeSaveMachine } from './office-save-machine'
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'
import {
  isAiPanelAutoCollapsed,
  officeDebugEnabled,
  resolveAiPanelOpen,
  useOfficeUiStore
} from './office-ui-store'
import { useDocumentTheme } from './use-document-theme'

/**
 * Office 模块：独立于会话的多标签工作区。
 *
 * 2026-10-17（M3-S2）：mock「打开文件（示例）」列表已删；入口换成主进程的真实选择器
 * （`window.kyclaw.office.openDialog()`，取消是一等结果）。成功打开后由注册表回
 * `OfficeDocumentInfo`，`openDocument` 按 **documentId** 去重/激活标签。
 *
 * 2026-10-17（M3-S3）：DOCX 标签挂**真编辑器**（隔离面内的 `DocxEditor`，字体本地注册）：
 *   - 保存链路：壳 `office-save-machine`（generate→write→commit）+ 面 `doc:save`/`doc:save-bytes`；
 *   - 运行时注册表 `office-actions`：保存按钮/壳侧 Ctrl+S 都经它找 `documentId` 的运行时
 *     （常驻 `AppTabBar` 与 OfficePage 是兄弟子树，S4 再扩到标签条）；
 *   - 脏徽标接真实状态：`data-dirty` 语义不变，文案升级为「已保存 / 未保存修改 / 保存中」。
 *
 * 顶栏「＋」仍走 office-ui-store 的 `pickerOpen` 标志（AppTabBar 与空态按钮共用一个动作）：
 * 页面看到标志置位就发起一次真实选择器请求，然后立刻把标志清掉。用 ref 去重是为了
 * React StrictMode 的 effect 双跑不会弹两次原生对话框。
 */
export interface OfficePageProps {
  /**
   * 是否是当前可见模块（M3-S4：ModuleHost 常驻 Office，切走时只 hidden+inert）。
   * 页内键盘/快捷键/自动弹窗一律按它门控；默认 true（单测/独立渲染时仍是"当前页"）。
   */
  active?: boolean
}

export function OfficePage({ active = true }: OfficePageProps = {}): React.JSX.Element {
  const tabs = useOfficeTabsStore((state) => state.tabs)
  const activeTabId = useOfficeTabsStore((state) => state.activeTabId)
  const openDocument = useOfficeTabsStore((state) => state.openDocument)
  const pickerOpen = useOfficeUiStore((state) => state.pickerOpen)
  const setPickerOpen = useOfficeUiStore((state) => state.setPickerOpen)
  // A3：AI 面板 = 用户手动偏好 && 未被自动收起（纯函数派生；自动收起由 ResizeObserver 写）
  const aiPanelManualOpen = useOfficeUiStore((state) => state.aiPanelOpen)
  const aiPanelAutoCollapsed = useOfficeUiStore((state) => state.aiPanelAutoCollapsed)
  const toggleAiPanel = useOfficeUiStore((state) => state.toggleAiPanel)
  const setAiPanelAutoCollapsed = useOfficeUiStore((state) => state.setAiPanelAutoCollapsed)
  const aiPanelOpen = resolveAiPanelOpen(aiPanelManualOpen, aiPanelAutoCollapsed)

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

  /**
   * A3：量 Office 页可用宽，低于 1100 自动收起 AI 面板（写环境态，不碰用户手动偏好）。
   * - 宽 0（隐藏/首帧/jsdom）不算窄：避免测试环境与切模块时误收；
   * - 有 ResizeObserver 就用它（内容卡随窗口/侧栏开合变化都会触发）；没有则退 window resize；
   * - 变宽后 autoCollapsed 置回 false，effective 自动回到用户偏好（手动关优先于自动）。
   */
  const pageRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const element = pageRef.current
    if (element === null) return
    const apply = (width: number): void => {
      setAiPanelAutoCollapsed(isAiPanelAutoCollapsed(width))
    }
    apply(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry !== undefined) apply(entry.contentRect.width)
      })
      observer.observe(element)
      return () => observer.disconnect()
    }
    const onWindowResize = (): void => apply(element.getBoundingClientRect().width)
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [setAiPanelAutoCollapsed])

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
    if (!active || !pickerOpen || openingFromFlagRef.current) return
    openingFromFlagRef.current = true
    setPickerOpen(false)
    void openViaDialog().finally(() => {
      openingFromFlagRef.current = false
    })
  }, [active, pickerOpen, setPickerOpen, openViaDialog])

  return (
    <section
      ref={pageRef}
      data-testid="office-page"
      data-active={active ? 'true' : 'false'}
      className="animate-page-in flex min-h-0 flex-1 flex-col bg-(--doc-canvas-bg)"
    >
      {/*
        A1（Office UI 改版）：去掉 40px「Office」页头与内层卡片，Office 区**全出血**直接铺满
        内容卡（外壳四角圆角由 AppShell 的 content-region 裁）；文件身份/保存态/调试信息
        收进下面每个 workspace 的隐藏 strip（A2 ribbon / A4 状态栏接管）。标题仍以 sr-only h1
        保留语义（既有 testid 契约：module-host / routes 单测与 e2e 都在用）。
      */}
      <h1 data-testid="office-page-title" className="sr-only">
        Office
      </h1>

      {tabs.length === 0 ? (
        <div
          data-testid="office-empty"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center"
        >
          {/* 空态 = 灰画布上的一张「白纸」：--doc-page-bg / --doc-page-shadow 的可见落点 */}
          <div className="flex max-w-md flex-col items-center gap-4 rounded-overlay border-(length:--hairline-width) border-hairline bg-(--doc-page-bg) px-8 py-10 shadow-(--doc-page-shadow)">
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-panel bg-secondary text-ink-tertiary"
            >
              <Briefcase className="size-(--icon-size-lg)" />
            </span>
            <div className="flex flex-col gap-1">
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
          </div>
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
      ) : (
        // M3-S4：**所有已打开标签都挂载**，非激活 `hidden + inert`——切标签只换可见性，
        // iframe / 面内编辑器 / 未保存修改 / 滚动位置全部保活（不再 key=activeTab.id 重建）。
        // A1：全出血画布（灰底），每个 workspace 自己铺满。
        <div data-testid="office-workspaces" className="relative flex min-h-0 flex-1 flex-col">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id
            return (
              <div
                key={tab.id}
                id={officePanelIdOf(tab.id)}
                role="tabpanel"
                aria-labelledby={`office-tab-${tab.id}`}
                data-office-panel={tab.id}
                data-active={isActive ? 'true' : 'false'}
                hidden={!isActive}
                inert={!isActive}
                className={isActive ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
              >
                <OfficeWorkspace
                  tab={tab}
                  active={isActive}
                  surfaceUrl={surfaceUrl}
                  aiPanelOpen={aiPanelOpen}
                  aiPanelAutoCollapsed={aiPanelAutoCollapsed}
                  onToggleAiPanel={toggleAiPanel}
                />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/**
 * 一个标签的内容区：标题/来源 + 真实保存状态 + 隔离面（内含编辑器）。
 *
 * M3-S4：每个标签一份实例并**常驻**（由父级 OfficePage 全量挂载、非激活 hidden+inert），
 * 所以这里不再需要用 `tab.id` 判"是否换标签"——切标签不会重建，状态自然跟着标签留着。
 */
function OfficeWorkspace({
  tab,
  active,
  surfaceUrl,
  aiPanelOpen,
  aiPanelAutoCollapsed,
  onToggleAiPanel
}: {
  tab: OfficeTab
  /** 是否当前可见标签（面内快捷键只在该 workspace 上转发，双保险） */
  active: boolean
  surfaceUrl?: string
  /** A3：右侧 AI 面板生效展开（docx 才有面板；非 docx 不渲染） */
  aiPanelOpen: boolean
  /** A3：是否因内容区过窄被自动收起（只影响把手 tooltip/可用性） */
  aiPanelAutoCollapsed: boolean
  /** A3：用户点收起/展开（翻 store 的手动偏好） */
  onToggleAiPanel: () => void
}): React.JSX.Element {
  const Icon = OFFICE_KIND_ICON[tab.kind]
  const source = tab.path ?? tab.url ?? ''
  // M3-S3：DOCX 标签挂真编辑器（面内 DocxEditor）；其它格式仍占位（后续步骤再接）
  const isDocx = tab.kind === 'docx'
  const theme = useDocumentTheme()
  const surfaceRef = useRef<OfficeSurfaceHandle | null>(null)
  const machineRef = useRef<OfficeSaveMachine | null>(null)

  const [surfaceStatus, setSurfaceStatus] = useState<OfficeSurfaceStatus>('loading')
  const handleSurfaceStatus = setSurfaceStatus

  /** 主进程回包里的文档信息 + 字节（壳只在内存里中转给面，不持久化内容） */
  const [loaded, setLoaded] = useState<{
    info: OfficeDocumentInfo
    bytes: Uint8Array
  } | null>(null)
  const [docError, setDocError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [editorReady, setEditorReady] = useState(false)
  const [pageCount, setPageCount] = useState(0)

  useEffect(() => {
    // 每个标签一份 OfficeWorkspace 且常驻：本 effect 只在首次挂载/documentId 变化时读一次，
    // 切标签不重读（S3 遗留的"保存后壳内 loaded 快照不更新"不在 S4 做静默重读）
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

  // 保存状态机：文档字节到手后创建，并把运行时注册进模块级 registry（S4 的标签条也走它）
  const loadedDocumentId = loaded?.info.documentId
  const loadedSha256 = loaded?.info.sha256

  /**
   * A4.5：待回执的**面发起**保存请求（QAT / 面内 Ctrl+S 的 requestId）。
   * 壳侧主动保存时它是 null → 回执用一个新 id（面"没有在途请求就直接采信"）。
   */
  const pendingSurfaceSaveRequestRef = useRef<string | null>(null)

  /** A4.5：把保存结果回执给**本标签的** iframe（多 workspace 各自一份 surface，天然隔离） */
  const notifySurfaceSaveResult = useCallback(
    (result: { ok: boolean; code?: string; message?: string }): void => {
      const pendingRequestId = pendingSurfaceSaveRequestRef.current
      pendingSurfaceSaveRequestRef.current = null
      surfaceRef.current?.resolveSaveResult({
        requestId: pendingRequestId ?? crypto.randomUUID(),
        ok: result.ok,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.message === undefined ? {} : { message: result.message })
      })
    },
    []
  )

  useEffect(() => {
    if (loadedDocumentId === undefined) return
    const markDirty = (dirty: boolean): void => {
      useOfficeTabsStore.getState().markDirty(tab.id, dirty)
    }
    const machine = createOfficeSaveMachine({
      documentId: loadedDocumentId,
      ...(loadedSha256 === undefined ? {} : { initialSha256: loadedSha256 }),
      suggestedName: loaded?.info.displayName,
      requestSaveBytes: async () => {
        const surface = surfaceRef.current
        if (surface === null) return null
        return surface.requestSaveBytes()
      },
      saveIpc: (input) => window.kyclaw.office.save(input),
      saveAsIpc: (input) => window.kyclaw.office.saveAs(input),
      onDirtyChange: markDirty,
      onSavingChange: setSaving,
      onError: setSaveError,
      // A4.5：写盘结果回执给面内 QAT（面发起的请求用它的 requestId，壳发起的用一个新 id）
      onSaveResult: notifySurfaceSaveResult,
      onSavedAs: (document) => {
        // 另存为成功：标签标题/路径跟新文件（documentId 不变），错误条清掉
        useOfficeTabsStore.getState().replaceDocument(document)
        setDocError('')
      }
    })
    machineRef.current = machine
    const unregister = registerOfficeRuntime(loadedDocumentId, {
      save: () => machine.save(),
      saveAs: () => machine.saveAs(),
      close: async () => {
        surfaceRef.current?.closeDocument()
      }
    })
    return () => {
      unregister()
      if (machineRef.current === machine) machineRef.current = null
    }
    // loadedSha256 只作为初始基线：之后由 machine 自己维护，不随 loaded 更新而重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDocumentId, tab.id, notifySurfaceSaveResult])

  // 注意：render 期不读 ref（react-hooks/refs）。editorReady 只会在保存状态机建好之后变真，
  // 因此这个门足够；运行时缺失时 saveOfficeTab 自己会返回 false（不伪造成功）。
  const canSave = isDocx && editorReady && tab.dirty && !saving

  const requestSave = (): void => {
    // 新一次尝试开始前清掉上一次的错误条（失败会由状态机再写回）
    setSaveError('')
    void saveOfficeTab(tab)
  }
  const requestSaveAs = (): void => {
    setSaveError('')
    void machineRef.current?.saveAs()
  }

  /** 面报告用户编辑：推进壳的 editSeq（dirty 真相在 machine，store 只是投影） */
  const handleDocChanged = (): void => {
    const machine = machineRef.current
    if (machine !== null) {
      machine.onChanged()
      return
    }
    // 极端时序（编辑器先报变、状态机还没建）：至少让 UI 立刻变脏
    useOfficeTabsStore.getState().markDirty(tab.id, true)
  }

  /**
   * 面内保存请求（A4.5：QAT 按钮 / 面内 Ctrl+S，带 requestId）→ 走既有保存入口；
   * 写盘结果由 save-machine 的 `onSaveResult` 回执给面（见 notifySurfaceSaveResult）。
   * 只处理**本标签 documentId** 的请求（多 workspace 隔离的双保险）。
   */
  const handleDocSaveRequest = (request: { requestId: string; documentId: string }): void => {
    if (loaded?.info.documentId !== request.documentId) return
    pendingSurfaceSaveRequestRef.current = request.requestId
    setSaveError('')
    void saveOfficeTab(tab).then((saved) => {
      // 兜底：状态机没走到（没有运行时 / 编辑器没就绪）时也回一个结果，别让面内 QAT 悬空
      if (pendingSurfaceSaveRequestRef.current !== request.requestId) return
      notifySurfaceSaveResult({
        ok: saved,
        ...(saved
          ? {}
          : { code: 'cancelled', message: '保存未能执行：编辑器还没准备好或当前不可保存' })
      })
    })
  }

  /** 面内错误：保存阶段进保存错误条，其余进文档错误条 */
  const handleDocError = (phase: 'open' | 'layout' | 'save' | 'runtime', message: string): void => {
    if (phase === 'save') setSaveError(message)
    else setDocError(message)
  }

  /**
   * 面内快捷键（焦点在 iframe 编辑器里）→ 壳的统一分发。
   * 只有**可见** workspace 才转发（隐藏的 iframe 拿不到键盘事件，这里是双保险），
   * 动作最终由常驻 AppTabBar 注册的 `office-actions` handler 处理（保存/关闭三态/切标签）。
   */
  const handleSurfaceShortcut = (action: OfficeShortcutAction): void => {
    if (!active) return
    handleOfficeShortcut(action)
  }

  /** A1 调试信息开关：默认关（正式视图不露出），DOM/属性仍供单测与探针查 */
  const debugVisible = officeDebugEnabled()

  return (
    <div
      data-testid="office-workspace"
      data-kind={tab.kind}
      data-document-id={tab.documentId ?? ''}
      data-active={active ? 'true' : 'false'}
      data-document-state={loaded === null ? (docError === '' ? 'loading' : 'error') : 'loaded'}
      data-editor-state={isDocx ? (editorReady ? 'ready' : 'loading') : 'n/a'}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {/*
        A1 全出血：原来的「文档头」（标题/路径/保存按钮/隔离面/脏徽标）不再占一行 ——
        文件身份与保存态在 A2 的 ribbon QAT / A4 的状态栏接管。这里保留 DOM 契约：
        默认 `hidden`（正式视图不露出），DOM 里可查 testid / data-*（单测与探针依赖）；
        DEV + localStorage `kyclaw:office-debug=1` 时才展开供开发核对。
      */}
      <div
        data-testid="office-workspace-debug"
        data-debug={debugVisible ? 'true' : 'false'}
        hidden={!debugVisible}
        className={cn(
          'shrink-0 items-center gap-2 border-b border-hairline bg-(--doc-page-bg) px-3 py-1 text-c1 text-ink-tertiary',
          debugVisible ? 'flex' : 'hidden'
        )}
      >
        <Icon aria-hidden="true" className="size-(--icon-size-sm) shrink-0" />
        <p
          data-testid="office-doc-title"
          className="min-w-0 truncate font-medium text-ink"
          title={tab.title}
        >
          {tab.title}
        </p>
        <p className="min-w-0 truncate" title={source}>
          {source}
          {pageCount > 0 ? ` · ${pageCount} 页` : ''}
        </p>
        {isDocx ? (
          // 保存按钮（A1 起视觉上收进调试 strip；A2 会搬进 ribbon QAT）
          <Button
            data-testid="office-save"
            variant="ghost"
            size="sm"
            loading={saving}
            disabled={!canSave}
            title="保存（Ctrl+S）"
            onClick={requestSave}
          >
            保存
          </Button>
        ) : null}
        {isDocx ? (
          <span
            data-testid="office-surface-status"
            data-state={surfaceStatus}
            title="Office 隔离面握手状态"
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
          data-saving={saving ? 'true' : 'false'}
          title={
            saving
              ? '正在写盘…'
              : tab.dirty
                ? '有未保存的修改（Ctrl+S 保存）'
                : '磁盘上的内容与编辑器里的一致'
          }
          className={cn(
            'inline-flex items-center rounded-badge px-1.5 py-0.5 text-c2',
            tab.dirty ? 'bg-(--fill-selected) text-warning' : 'bg-selected text-ink-tertiary'
          )}
        >
          {saving ? '保存中…' : tab.dirty ? '未保存修改' : '已保存'}
        </span>
      </div>

      {isDocx ? (
        // A3：画布（iframe，flex-1）+ 右侧 AI 面板（shell 侧，320 可折叠）同排。
        // A1 的全出血不变：左侧画布区自己铺满，圆角仍由 content-region 裁。
        <div className="relative flex min-h-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <OfficeSurface
              ref={surfaceRef}
              onStatusChange={handleSurfaceStatus}
              theme={theme}
              documentInfo={loaded?.info}
              documentBytes={loaded?.bytes}
              surfaceUrl={surfaceUrl}
              onDocLoaded={(pages) => {
                setEditorReady(true)
                setPageCount(pages)
                setDocError('')
              }}
              onDocChanged={handleDocChanged}
              onDocSaveRequest={handleDocSaveRequest}
              onDocError={handleDocError}
              onShortcut={handleSurfaceShortcut}
            />
            {/*
              A3：面板收起时，画布右缘给一个窄「AI」把手（aria-expanded=false + tooltip）。
              自动收起（窗口过窄）时禁用并说明原因——不挤压画布，也不假装能开。
            */}
            {aiPanelOpen ? null : (
              <button
                type="button"
                data-testid="office-ai-handle"
                aria-label={aiPanelAutoCollapsed ? 'AI 助手（窗口过窄已自动收起）' : '展开 AI 助手'}
                aria-expanded={false}
                aria-controls="office-ai-panel"
                title={aiPanelAutoCollapsed ? '窗口变宽后可展开 AI 助手（占位）' : '展开 AI 助手'}
                disabled={aiPanelAutoCollapsed}
                onClick={onToggleAiPanel}
                className="absolute top-[124px] right-4 z-10 flex items-center gap-1 rounded-badge border-(length:--hairline-width) border-hairline bg-(--doc-page-bg) px-2 py-1 text-c1 text-ink-secondary shadow-(--doc-page-shadow) transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                AI
              </button>
            )}
            {docError === '' ? null : (
              <p
                data-testid="office-doc-error"
                role="alert"
                className="absolute inset-x-0 bottom-0 border-t border-hairline bg-(--doc-page-bg) px-4 py-2 text-c1 text-warning"
              >
                {docError}
              </p>
            )}
            {saveError === '' ? null : (
              <div
                data-testid="office-save-error"
                role="alert"
                className="absolute inset-x-0 bottom-0 flex shrink-0 items-center gap-3 border-t border-hairline bg-(--doc-page-bg) px-3 py-2 text-c1 text-warning"
              >
                <span className="min-w-0 flex-1 truncate" title={saveError}>
                  {saveError}
                </span>
                <Button
                  data-testid="office-save-retry"
                  variant="ghost"
                  size="sm"
                  onClick={requestSave}
                >
                  重试
                </Button>
                <Button
                  data-testid="office-save-as"
                  variant="ghost"
                  size="sm"
                  onClick={requestSaveAs}
                >
                  另存为
                </Button>
              </div>
            )}
          </div>
          <OfficeAiPanel
            open={aiPanelOpen}
            autoCollapsed={aiPanelAutoCollapsed}
            onCollapse={onToggleAiPanel}
          />
        </div>
      ) : (
        <div
          data-testid="office-editor-placeholder"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-(--doc-canvas-bg) p-6 text-center"
        >
          <Icon aria-hidden="true" className="size-(--icon-size-lg) text-ink-tertiary" />
          <p className="text-b2 text-ink-secondary">编辑器接入中</p>
          <p className="max-w-md text-c1 text-ink-tertiary">
            {OFFICE_KIND_LABEL[tab.kind]}编辑器会在这里打开；切换标签不会关闭或重置其他文档。
          </p>
        </div>
      )}

      {/*
        A4：底部状态栏（workspace 最后一个 flex 子项）→ 横跨「画布 + AI 面板」整行下方；
        数据全是壳真值（tab.dirty / saving / readOnly + doc:loaded 页数），不新增协议。
      */}
      <OfficeStatusBar
        documentName={loaded?.info.displayName ?? tab.title}
        kind={tab.kind}
        pageCount={pageCount}
        dirty={tab.dirty}
        saving={saving}
        readOnly={tab.readOnly}
      />
    </div>
  )
}
