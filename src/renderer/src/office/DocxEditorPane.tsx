/**
 * 面内的 DOCX 编辑器（M3-S3）：`@betteroffice/docx-react` 的 `DocxEditor` 薄包装。
 *
 * 只在面收到 `doc:open` 且字体就绪后挂载（由 `SurfaceBoot` 控制）；这里只做五件事：
 *   - `documentBuffer`：壳经 postMessage 投递的字节（S3 一次性，S4/S5 再谈复用）；
 *   - `onChange`：用户编辑 → 面内 revision 单调 +1（由 `SurfaceBoot` 转 `doc:changed`）；
 *   - `onSaveRequest`：编辑器自己的 Ctrl+S / 我们的 QAT 保存 → 交给壳的保存状态机
 *     （**不让编辑器内置保存生效**：返回 false，且 `downloadOnSave=false`）；
 *   - 命令式方法（`ref`）：`save()` = `flushPendingInput()` + `ref.save()`（保存三阶段的 generate），
 *     `reload(bytes)` = `loadDocumentBuffer`（冲突后重新载入）；
 *   - **A2 自绘 chrome**：给 `DocxEditor` 传 `toolbar={<OfficeRibbon/>}`（替换默认 File/Format/
 *     Insert/Help 菜单条 + 默认工具条），`showZoomControl=false`（缩放进了视图 tab），
 *     i18n 用 zh-CN，默认缩放按 860px 纸面宽算（`officeDefaultZoom`）。
 *   - **A4.5**：QAT 保存态是**壳真值的事件驱动**（`saveState` 由 SurfaceBoot 按壳的
 *     `doc:save-result` 回执给下来），面里没有任何乐观计时器。
 *
 * 不 import 任何网络/CDN 字体；主题走 `colorMode`（壳的解析明暗）。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject
} from 'react'
import { DocxEditor, type DocxEditorRef } from '@betteroffice/docx-react'
import zhCN from '@betteroffice/docx-i18n/zh-CN'
import type { SurfaceTheme } from './bridge-protocol'
import { OfficeRibbon } from './components/OfficeRibbon'
import type { OfficeSaveState } from './components/OfficeRibbonView'
import { officeDefaultZoom, OFFICE_ZOOM_RESIZE_DEBOUNCE_MS } from './components/office-zoom'

export interface DocxEditorPaneHandle {
  /** 保存三阶段的 generate：flush 未提交输入 → `save()` 拿字节；失败回 null（错误已回调） */
  save(): Promise<Uint8Array | null>
  /** 冲突后重新载入磁盘字节（调用方负责确认"丢内存修改"） */
  reload(bytes: Uint8Array): Promise<void>
}

export type DocxErrorPhase = 'open' | 'layout' | 'save' | 'runtime'

export interface DocxEditorPaneProps {
  documentId: string
  name: string
  bytes: Uint8Array
  readOnly: boolean
  theme: SurfaceTheme
  /**
   * A4.5：QAT 保存态**由壳的事件驱动**（`doc:save-result` → SurfaceBoot 的状态机 → 这里）。
   * 面自己不再猜：没有 1.5s 乐观窗口，`saving` 只在"已发保存请求、还没收到回执"时为真。
   */
  saveState: OfficeSaveState
  /** 用户编辑（壳据此推进 editSeq / dirty） */
  onChanged(): void
  /** 编辑器内部保存请求（Ctrl+S / QAT 保存）→ 壳的保存状态机 */
  onSaveRequest(): void
  /** 首次布局完成（页数） */
  onLoaded(pages: number): void
  /** 面内错误（打开/布局/保存/运行时） */
  onError(phase: DocxErrorPhase, message: string): void
}

/** DocxEditor 视图开关（视图 tab 的宿主 props；不是内核命令） */
interface OfficeViewSettings {
  ruler: boolean
  outline: boolean
  marginGuides: boolean
}

const INITIAL_VIEW_SETTINGS: OfficeViewSettings = {
  ruler: false,
  outline: false,
  marginGuides: false
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const DocxEditorPane = forwardRef<DocxEditorPaneHandle, DocxEditorPaneProps>(
  function DocxEditorPane(props, ref) {
    const editorRef = useRef<DocxEditorRef | null>(null)
    /** 最新 props 的 ref：命令式句柄与编辑器回调都不因父组件内联函数而重挂 */
    const propsRef = useRef(props)
    useEffect(() => {
      propsRef.current = props
    })

    /** 视图 tab 的宿主开关（标尺/大纲/页边距参考线） */
    const [viewSettings, setViewSettings] = useState<OfficeViewSettings>(INITIAL_VIEW_SETTINGS)
    /** 默认缩放：用户定调「1280 窗口下纸面视觉宽 ≈ 860px」（office-zoom.ts） */
    const [initialZoom] = useState(() => officeDefaultZoom(window.innerWidth))
    /**
     * A4：窗口 resize 后按 fit-width 重算 zoom（内核 `ref.setZoom`，clamp 在 officeDefaultZoom 内）。
     * 防抖 120ms：拖动窗口时只跟最后一帧；`initialZoom` 仍是 mount 的初始 prop。
     */
    const zoomRef = useRef(initialZoom)

    useEffect(() => {
      let timer: number | null = null
      const apply = (): void => {
        const next = officeDefaultZoom(window.innerWidth)
        if (next === zoomRef.current) return
        zoomRef.current = next
        editorRef.current?.setZoom(next)
      }
      const onResize = (): void => {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          apply()
        }, OFFICE_ZOOM_RESIZE_DEBOUNCE_MS)
      }
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('resize', onResize)
        if (timer !== null) window.clearTimeout(timer)
      }
    }, [initialZoom])

    useImperativeHandle(
      ref,
      () => ({
        async save(): Promise<Uint8Array | null> {
          const editor = editorRef.current
          if (editor === null) return null
          try {
            // 先提交输入法/未落字，再 save（spike 的 generate 口径）
            await editor.flushPendingInput()
            const buffer = await editor.save()
            return buffer === null ? null : new Uint8Array(buffer)
          } catch (error) {
            propsRef.current.onError('save', messageOf(error))
            return null
          }
        },
        async reload(bytes: Uint8Array): Promise<void> {
          const editor = editorRef.current
          if (editor === null) return
          try {
            await editor.loadDocumentBuffer(bytes)
          } catch (error) {
            propsRef.current.onError('open', messageOf(error))
          }
        }
      }),
      []
    )

    const handleChange = useCallback(() => {
      // 保存态由壳的事件驱动（A4.5）：这里只把"又有修改"报给壳/DocChanged，
      // QAT 的「未保存修改」由 SurfaceBoot 状态机翻（面不再自己猜）。
      propsRef.current.onChanged()
    }, [])

    const handleSaveRequest = useCallback(() => {
      // A4.5：QAT 保存按钮与编辑器内部 Ctrl+S 同一条路 —— 打给 SurfaceBoot 的统一保存入口
      // （它会发带 requestId 的 doc:save-request，并等壳的 doc:save-result 才回「已保存」）。
      propsRef.current.onSaveRequest()
      // false = 不走编辑器内置保存（下载/写盘都由宿主负责）
      return false
    }, [])

    const handleError = useCallback((error: Error) => {
      propsRef.current.onError('runtime', messageOf(error))
    }, [])

    const toggleHost = useCallback((host: 'ruler' | 'outline' | 'margin-guides'): void => {
      setViewSettings((current) => {
        switch (host) {
          case 'ruler':
            return { ...current, ruler: !current.ruler }
          case 'outline':
            return { ...current, outline: !current.outline }
          case 'margin-guides':
            return { ...current, marginGuides: !current.marginGuides }
        }
      })
    }, [])

    /** 首次布局完成 → 页数（壳只用于展示/排障；失败不算致命，交给 onError layout） */
    const layoutRequested = useRef(false)
    useEffect(() => {
      layoutRequested.current = false
    }, [props.documentId])
    useEffect(() => {
      const timer = window.setInterval(() => {
        const editor = editorRef.current
        if (editor === null || layoutRequested.current) return
        layoutRequested.current = true
        window.clearInterval(timer)
        editor
          .whenLayoutComplete({ timeoutMs: 60_000 })
          .then((pages) => propsRef.current.onLoaded(pages))
          .catch((error: unknown) => propsRef.current.onError('layout', messageOf(error)))
      }, 100)
      return () => window.clearInterval(timer)
    }, [props.documentId])

    return (
      <div
        data-testid="surface-docx-editor"
        data-document-id={props.documentId}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <DocxEditor
          ref={editorRef as RefObject<DocxEditorRef>}
          documentBuffer={props.bytes}
          documentName={props.name}
          documentNameEditable={false}
          downloadOnSave={false}
          showFileOpen={false}
          showZoomControl={false}
          showOutlineButton={false}
          showRuler={viewSettings.ruler}
          showOutline={viewSettings.outline}
          showMarginGuides={viewSettings.marginGuides}
          initialZoom={initialZoom}
          i18n={zhCN}
          readOnly={props.readOnly}
          colorMode={props.theme}
          onChange={handleChange}
          onSaveRequest={handleSaveRequest}
          onError={handleError}
          toolbar={
            <OfficeRibbon
              documentName={props.name}
              saveState={props.saveState}
              readOnly={props.readOnly}
              onRequestSave={handleSaveRequest}
              hostToggles={{
                ruler: viewSettings.ruler,
                outline: viewSettings.outline,
                'margin-guides': viewSettings.marginGuides
              }}
              onToggleHost={toggleHost}
            />
          }
        />
      </div>
    )
  }
)
