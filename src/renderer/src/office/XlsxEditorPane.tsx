/**
 * 面内的 XLSX 编辑器（M4-X）：`@betteroffice/xlsx-react` 的 `XlsxEditor` 薄包装。
 *
 * 与 DocxEditorPane 同职责（打开字节 / dirty / 保存字节 / 重载 / 只读），差异：
 *   - XLSX 的 `api.save()` 同步、且可能 `XlsxSaveRefusedError`（input-pending/input-failed）：
 *     保存前先 `await api.version()` 让未提交输入落地，再 `api.save()`；
 *   - 没有 `onSaveRequest` 拦截入口；`onSave` 是「内置保存按钮/快捷键」的唯一落点 ——
 *     **必须传**（不传会触发浏览器下载；sandbox 不带 allow-downloads）。这里收到后只打给宿主
 *     的统一保存状态机（宿主再走 `doc:save` → 本 pane `save()`），不透传 bytes 造成双写；
 *   - 没有 loadBuffer API：`doc:reload` 用递增 key 重挂 `XlsxEditor`（以新 file 重开）；
 *   - XLSX 不需要 @betteroffice/fonts（canvas 用浏览器字体），SurfaceBoot 不为它等字体注册；
 *   - D16（sandbox 不动）：默认工具栏含 save/exportPng/print，这里换成**自定义 toolbar**，
 *     不含保存/导出/打印/演示入口，并在上方给一条能力提示（不是解释按钮功能）。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  EditorToolbar,
  ToolbarCommand,
  ToolbarCommandButton,
  ToolbarCommandSelect,
  ToolbarGroup,
  XlsxEditor,
  XlsxSaveRefusedError,
  type XlsxEditorApi
} from '@betteroffice/xlsx-react'
import zhCN from '@betteroffice/xlsx-i18n/zh-CN'
import type { SurfaceTheme } from './bridge-protocol'
import {
  OFFICE_CAPABILITY_NOTE,
  markCapabilityNoteSeen,
  shouldShowCapabilityNote
} from './capability-note'
// PB-020 A 类：chrome 覆盖（!important 压包内 inline style；升级复核见 CSS 头注释）
import './office-chrome-xlsx.css'

export interface XlsxEditorPaneHandle {
  /** 保存三阶段的 generate：flush（version）→ save()；失败回 null（错误已回调） */
  save(): Promise<Uint8Array | null>
  /** 冲突后以磁盘字节重开（重挂 XlsxEditor；调用方负责确认"丢内存修改"） */
  reload(bytes: Uint8Array): Promise<void>
}

export type XlsxErrorPhase = 'open' | 'layout' | 'save' | 'runtime'

export interface XlsxEditorPaneProps {
  documentId: string
  name: string
  bytes: Uint8Array
  readOnly: boolean
  /** 明暗（xlsx-react 0.3.0 的 canvas 颜色是内置浅色；这里只用于宿主 chrome token） */
  theme: SurfaceTheme
  /** D17 探针缝：仅 `?officeProbe=1` + dev 时向 window 暴露最小 read/edit/save API */
  probe?: boolean
  onChanged(): void
  /** 编辑器内置保存按钮 / 面内 Ctrl+S → 壳的统一保存状态机 */
  onSaveRequest(): void
  /** 首次挂载完成（xlsx 没有页数概念，回 0；壳只用于 editor-ready 门） */
  onLoaded(): void
  onError(phase: XlsxErrorPhase, message: string): void
}

/** D17 canvas 探针最小面（仅 dev + KYCLAW_OFFICE_PROBE；生产不设即不存在） */
interface OfficeXlsxProbeApi {
  version(): Promise<string>
  readCells(ranges: readonly unknown[]): Promise<unknown>
  applyCellInput(
    sheetId: string,
    row: number,
    col: number,
    input: string
  ): Promise<{ ok: boolean; code?: string }>
  save(): Promise<{ ok: boolean; byteLength?: number; code?: string }>
}

declare global {
  interface Window {
    __KYCLAW_OFFICE_XLSX_PROBE__?: OfficeXlsxProbeApi
  }
}

/** 明确不出现保存/导出/打印/演示的工具栏（D16：sandbox 不放宽，能力收口） */
function xlsxToolbar(): ReactNode {
  return (
    <EditorToolbar mode="commands">
      <EditorToolbar.Toolbar>
        <ToolbarGroup label="撤销">
          <ToolbarCommandButton id="undo" />
          <ToolbarCommandButton id="redo" />
          <ToolbarCommandButton id="paintFormat" />
        </ToolbarGroup>
        <ToolbarGroup label="字体">
          <ToolbarCommandSelect id="fontFamily" />
          <ToolbarCommandSelect id="fontSize" />
          <ToolbarCommandButton id="bold" />
          <ToolbarCommandButton id="italic" />
          <ToolbarCommandButton id="strikethrough" />
        </ToolbarGroup>
        <ToolbarGroup label="数字">
          <ToolbarCommandSelect id="numberFormat" />
          <ToolbarCommand id="decimalPlaces" />
        </ToolbarGroup>
        <ToolbarGroup label="颜色">
          <ToolbarCommand id="textColor" />
          <ToolbarCommand id="fillColor" />
        </ToolbarGroup>
        <ToolbarGroup label="边框">
          <ToolbarCommandSelect id="borderPreset" />
          <ToolbarCommandSelect id="borderStyle" />
          <ToolbarCommand id="borderColor" />
        </ToolbarGroup>
        <ToolbarGroup label="对齐">
          <ToolbarCommandSelect id="horizontalAlignment" />
          <ToolbarCommandSelect id="verticalAlignment" />
          <ToolbarCommandSelect id="textWrapping" />
          <ToolbarCommandSelect id="merge" />
        </ToolbarGroup>
        <ToolbarGroup label="查找">
          <ToolbarCommandButton id="searchMenus" />
        </ToolbarGroup>
        <ToolbarGroup label="视图">
          <ToolbarCommandSelect id="zoom" />
        </ToolbarGroup>
      </EditorToolbar.Toolbar>
      <EditorToolbar.FormulaBar />
    </EditorToolbar>
  )
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const XlsxEditorPane = forwardRef<XlsxEditorPaneHandle, XlsxEditorPaneProps>(
  function XlsxEditorPane(props, ref) {
    const apiRef = useRef<XlsxEditorApi | null>(null)
    const propsRef = useRef(props)
    useEffect(() => {
      propsRef.current = props
    })
    /** 重载 = 新 file + 新 key（xlsx-react 没有 loadBuffer） */
    const [file, setFile] = useState<Uint8Array>(props.bytes)
    const [generation, setGeneration] = useState(0)
    const [capabilityNoteVisible, setCapabilityNoteVisible] = useState(() =>
      shouldShowCapabilityNote('xlsx')
    )

    useEffect(() => {
      setFile(props.bytes)
    }, [props.bytes])

    const handleReady = useCallback((api: XlsxEditorApi) => {
      apiRef.current = api
      if (propsRef.current.probe === true && import.meta.env.DEV) {
        // D17：仅未打包 dev 构建 + ?officeProbe=1；生产构建里这段被 tree-shake/不执行
        window.__KYCLAW_OFFICE_XLSX_PROBE__ = {
          version: () => api.version(),
          readCells: (ranges) => api.readCells({ ranges } as never),
          applyCellInput: async (sheetId, row, col, input) => {
            const expectVersion = await api.version()
            const result = (await api.applyEdits({
              expectVersion,
              steps: [
                {
                  op: 'setCellInputs',
                  target: {
                    sheetId,
                    range: { kind: 'rowCol', start: { row, col }, end: { row, col } }
                  },
                  inputs: [[input]]
                }
              ]
            } as never)) as { ok?: boolean; refusal?: { failure?: { code?: string } } }
            return result.ok === true
              ? { ok: true }
              : { ok: false, code: result.refusal?.failure?.code ?? 'apply-failed' }
          },
          save: async () => {
            try {
              await api.version()
              const bytes = api.save()
              return { ok: true, byteLength: bytes.byteLength }
            } catch (error) {
              if (error instanceof XlsxSaveRefusedError) return { ok: false, code: error.code }
              return { ok: false, code: messageOf(error) }
            }
          }
        }
      }
      propsRef.current.onLoaded()
    }, [])

    // 探针面随 pane 卸载消失（生产不设即不存在）
    useEffect(
      () => () => {
        delete window.__KYCLAW_OFFICE_XLSX_PROBE__
      },
      []
    )

    useImperativeHandle(
      ref,
      () => ({
        async save(): Promise<Uint8Array | null> {
          const api = apiRef.current
          if (api === null) return null
          try {
            // 先 flush 未提交输入（version() 会把 input 队列跑完），再取字节
            await api.version()
            return api.save()
          } catch (error) {
            if (error instanceof XlsxSaveRefusedError) {
              propsRef.current.onError(
                'save',
                error.code === 'input-pending'
                  ? '上一个单元格的输入还没落定，请稍后再保存'
                  : '单元格输入未被接受，请先修正或按 Esc 取消再保存'
              )
              return null
            }
            propsRef.current.onError('save', messageOf(error))
            return null
          }
        },
        async reload(bytes: Uint8Array): Promise<void> {
          apiRef.current = null
          setFile(bytes)
          setGeneration((current) => current + 1)
          setCapabilityNoteVisible(true)
        }
      }),
      []
    )

    const handleChange = useCallback(() => {
      propsRef.current.onChanged()
    }, [])

    const handleSave = useCallback(() => {
      // 不传 onSave 会触发浏览器下载（sandbox 无 allow-downloads）；这里改走宿主状态机。
      // 宿主保存时会经 surface 的 doc:save → 本 pane save() 重新生成字节，所以不透传 bytes。
      propsRef.current.onSaveRequest()
    }, [])

    return (
      <div
        data-testid="surface-xlsx-editor"
        data-document-id={props.documentId}
        data-theme={props.theme}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {capabilityNoteVisible ? (
          <p
            data-testid="office-format-note"
            role="note"
            title={OFFICE_CAPABILITY_NOTE.xlsx}
            style={{
              margin: 0,
              padding: '3px 10px',
              borderBottom: '1px solid var(--border-hairline)',
              background: 'var(--bg-primary)',
              color: 'var(--text-tertiary)',
              fontSize: 'var(--font-size-c1, 11px)',
              lineHeight: 1.4,
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <span style={{ minWidth: 0, flex: 1 }}>{OFFICE_CAPABILITY_NOTE.xlsx}</span>
            <button
              type="button"
              data-testid="office-format-note-dismiss"
              onClick={() => {
                markCapabilityNoteSeen('xlsx')
                setCapabilityNoteVisible(false)
              }}
              style={{
                flex: 'none',
                border: '1px solid var(--border-hairline)',
                borderRadius: 6,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                padding: '1px 6px',
                cursor: 'pointer'
              }}
            >
              知道了
            </button>
          </p>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <XlsxEditor
            key={`${props.documentId}:${String(generation)}`}
            file={file}
            fileName={props.name}
            readOnly={props.readOnly}
            i18n={zhCN}
            onChange={handleChange}
            onSave={handleSave}
            onReady={handleReady}
            toolbar={xlsxToolbar()}
            className="office-xlsx-editor"
          />
        </div>
      </div>
    )
  }
)
