/**
 * 面内的 PPTX 编辑器（M4-P）：`@betteroffice/pptx-react` 的 `PptxEditor` 薄包装。
 *
 * 与 XlsxEditorPane 同职责（打开字节 / dirty / 保存字节 / 重载 / 只读），差异：
 *   - `fonts` **必填**（`PptxFontFace[]`）：由 SurfaceBoot 先 `loadPptxFonts()`（6 条/5 唯一 face/10.47MB），
 *     成功后才挂本组件；失败/超时由 SurfaceBoot 进错误态，**不传空数组**；
 *   - 保存：`await api.flushPendingInput()`（让未提交输入落地）→ `api.save()` 同步取字节；
 *   - 内置保存/下载必须接管：传 `onSave`（不传会触发浏览器下载，sandbox 无 allow-downloads）+
 *     `onSaveRequest` 返回 false（取消内置保存），两者都只通知宿主统一保存状态机，不透传 bytes；
 *   - 没有 loadBuffer API：`doc:reload` 用递增 key 重挂 `PptxEditor`（以新 file 重开）；
 *   - D16（sandbox 不动）：自定义 toolbar 里移除 `save` / `exportPng` / `slideshow`，上方常驻
 *     一条能力说明（预览 + 轻量编辑；图表/母版/动画只读；表格仅单元格文字；演示/导出/打印不可用）；
 *   - D17 探针：仅 `?officeProbe=1` + dev 时挂 `__KYCLAW_OFFICE_PPTX_PROBE__`，供真机 e2e 断言/编辑；
 *     生产不设即不存在。
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
import type { PptxFontFace } from '@betteroffice/pptx'
import {
  EditorToolbar,
  PptxEditor,
  ToolbarCommand,
  ToolbarCommandButton,
  ToolbarCommandSelect,
  ToolbarGroup,
  type PptxEditorApi
} from '@betteroffice/pptx-react'
import zhCN from '@betteroffice/pptx-i18n/zh-CN'
import type { PptxFontFaceInput } from './fonts'
import {
  OFFICE_CAPABILITY_NOTE,
  markCapabilityNoteSeen,
  shouldShowCapabilityNote
} from './capability-note'
import type { SurfaceTheme } from './bridge-protocol'
// PB-020 A 类：chrome 覆盖（!important 压包内 inline style；升级复核见 CSS 头注释）
import './office-chrome-pptx.css'

export interface PptxEditorPaneHandle {
  /** 保存三阶段的 generate：flushPendingInput → save()；失败回 null（错误已回调） */
  save(): Promise<Uint8Array | null>
  /** 冲突后以磁盘字节重开（重挂 PptxEditor；调用方负责确认"丢内存修改"） */
  reload(bytes: Uint8Array): Promise<void>
}

export type PptxErrorPhase = 'open' | 'layout' | 'save' | 'runtime'

export interface PptxEditorPaneProps {
  documentId: string
  name: string
  bytes: Uint8Array
  readOnly: boolean
  /** 6 条字体面（SurfaceBoot 已加载；首帧不阻塞，加载态由 SurfaceBoot 负责） */
  fonts: ReadonlyArray<PptxFontFaceInput>
  /** 明暗：pptx-react 0.2.0 无 colorMode（canvas 按主题内置），这里只用于宿主 chrome token */
  theme: SurfaceTheme
  /** D17 探针缝：仅 `?officeProbe=1` + dev 时向 window 暴露最小 read/edit/save API */
  probe?: boolean
  onChanged(): void
  /** 编辑器内置保存 / 面内 Ctrl+S → 壳的统一保存状态机 */
  onSaveRequest(): void
  /** 首次挂载完成（壳用于 editor-ready 门） */
  onLoaded(): void
  /** PB-020 E1：幻灯片总数（onReady 的 snapshot + 每次 onChange 变化时上报，供状态栏「共 N 页」） */
  onPageCount?(count: number): void
  onError(phase: PptxErrorPhase, message: string): void
}

/** D17 探针最小面（仅 dev + KYCLAW_OFFICE_PROBE；生产不设即不存在） */
interface OfficePptxProbeApi {
  version(): Promise<string>
  readContent(): Promise<unknown>
  /** 所有 story 的纯文本（按 deck 顺序），便于 e2e 断言改文字/备注后的内容 */
  readTexts(): Promise<string[]>
  replaceFirstText(search: string, replacement: string): Promise<{ ok: boolean; code?: string }>
  /** 把第一张 slide 的第一个 shape 的 x 改成 `xEmu`（形状编辑的最小面） */
  setFirstShapeX(xEmu: number): Promise<{ ok: boolean; code?: string }>
  setSlideNotes(slideIndex: number, text: string): Promise<{ ok: boolean; code?: string }>
  save(): Promise<{ ok: boolean; byteLength?: number; code?: string }>
}

declare global {
  interface Window {
    __KYCLAW_OFFICE_PPTX_PROBE__?: OfficePptxProbeApi
  }
}

/** 明确不出现保存/导出/演示的工具栏（D16：sandbox 不放宽，能力收口） */
function pptxToolbar(): ReactNode {
  return (
    <EditorToolbar mode="commands">
      <EditorToolbar.Toolbar>
        <ToolbarGroup label="撤销">
          <ToolbarCommandButton id="undo" />
          <ToolbarCommandButton id="redo" />
        </ToolbarGroup>
        <ToolbarGroup label="字体">
          <ToolbarCommandSelect id="fontFamily" />
          <ToolbarCommandSelect id="fontSize" />
          <ToolbarCommandButton id="bold" />
          <ToolbarCommandButton id="italic" />
          <ToolbarCommandButton id="underline" />
          <ToolbarCommand id="textColor" />
          <ToolbarCommandSelect id="alignment" />
        </ToolbarGroup>
        <ToolbarGroup label="插入">
          <ToolbarCommandButton id="insertSlide" />
          <ToolbarCommandButton id="insertImage" />
        </ToolbarGroup>
        <ToolbarGroup label="形状">
          <ToolbarCommand id="shapeFill" />
          <ToolbarCommand id="shapeStrokeColor" />
          <ToolbarCommandSelect id="shapeStrokeWidth" />
          <ToolbarCommand id="zOrder" />
        </ToolbarGroup>
        <ToolbarGroup label="视图">
          <ToolbarCommandSelect id="zoom" />
        </ToolbarGroup>
      </EditorToolbar.Toolbar>
    </EditorToolbar>
  )
}

/** 能力说明（首次打开一次性提示；之后可从状态栏「能力说明」查看） */
const CAPABILITY_NOTE = OFFICE_CAPABILITY_NOTE.pptx

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const PptxEditorPane = forwardRef<PptxEditorPaneHandle, PptxEditorPaneProps>(
  function PptxEditorPane(props, ref) {
    const apiRef = useRef<PptxEditorApi | null>(null)
    const propsRef = useRef(props)
    useEffect(() => {
      propsRef.current = props
    })
    /** 重载 = 新 file + 新 key（pptx-react 没有 loadBuffer） */
    const [file, setFile] = useState<Uint8Array>(props.bytes)
    const [generation, setGeneration] = useState(0)
    /** PB-020 R1：能力说明只在首次打开时出现（之后从状态栏入口看） */
    const [capabilityNoteVisible, setCapabilityNoteVisible] = useState(() =>
      shouldShowCapabilityNote('pptx')
    )
    /** PB-020 E1：最近一次上报的幻灯片总数（只在变化时上报，避免刷屏） */
    const lastPageCountRef = useRef<number | null>(null)
    const reportPageCount = useCallback((count: number) => {
      if (!Number.isFinite(count) || count <= 0) return
      if (lastPageCountRef.current === count) return
      lastPageCountRef.current = count
      propsRef.current.onPageCount?.(count)
    }, [])
    /** 同一 tick 内 onSave 与 onSaveRequest 都触发时只通知宿主一次 */
    const saveNotifyRef = useRef(false)

    useEffect(() => {
      setFile(props.bytes)
    }, [props.bytes])

    const notifySave = useCallback(() => {
      if (saveNotifyRef.current) return
      saveNotifyRef.current = true
      queueMicrotask(() => {
        saveNotifyRef.current = false
      })
      propsRef.current.onSaveRequest()
    }, [])

    const handleReady = useCallback((api: PptxEditorApi) => {
      apiRef.current = api
      if (propsRef.current.probe === true && import.meta.env.DEV) {
        // D17：仅未打包 dev 构建 + ?officeProbe=1；生产构建里这段不执行
        window.__KYCLAW_OFFICE_PPTX_PROBE__ = {
          version: () => api.version(),
          readContent: () => api.readContent(),
          readTexts: async () => {
            const result = (await api.readContent()) as {
              ok?: boolean
              stories?: Array<{ text?: string }>
            }
            if (result.ok !== true) return []
            return (result.stories ?? []).map((story) => story.text ?? '')
          },
          replaceFirstText: async (search, replacement) => {
            try {
              const found = (await api.findText({ text: search })) as {
                ok?: boolean
                failure?: { code?: string }
                matches?: Array<{
                  range?: { slideId: string; shapeId: string; storyId: string }
                }>
              }
              if (found.ok !== true)
                return { ok: false, code: found.failure?.code ?? 'find-failed' }
              const range = found.matches?.[0]?.range
              if (range === undefined) return { ok: false, code: 'not-found' }
              const expectVersion = await api.version()
              const result = (await api.applyEdits({
                expectVersion,
                steps: [
                  {
                    op: 'replaceText',
                    target: {
                      kind: 'search',
                      within: {
                        slideId: range.slideId,
                        shapeId: range.shapeId,
                        storyId: range.storyId
                      },
                      text: search
                    },
                    text: replacement
                  }
                ]
              } as never)) as { ok?: boolean; failure?: { code?: string } }
              return result.ok === true
                ? { ok: true }
                : { ok: false, code: result.failure?.code ?? 'apply-failed' }
            } catch (error) {
              return { ok: false, code: messageOf(error) }
            }
          },
          setFirstShapeX: async (xEmu) => {
            try {
              const read = (await api.readContent()) as {
                ok?: boolean
                failure?: { code?: string }
                slides?: Array<{
                  id?: string
                  shapes?: Array<{
                    id?: string
                    x?: number
                    y?: number
                    width?: number
                    height?: number
                  }>
                }>
              }
              if (read.ok !== true) return { ok: false, code: read.failure?.code ?? 'read-failed' }
              const slide = read.slides?.[0]
              const shape = slide?.shapes?.[0]
              if (slide?.id === undefined || shape?.id === undefined) {
                return { ok: false, code: 'no-shape' }
              }
              const expectVersion = await api.version()
              const result = (await api.applyEdits({
                expectVersion,
                steps: [
                  {
                    op: 'setShapeRect',
                    target: { slideId: slide.id, shapeId: shape.id },
                    rect: {
                      x: xEmu,
                      y: shape.y ?? 0,
                      width: shape.width ?? 1,
                      height: shape.height ?? 1
                    }
                  }
                ]
              } as never)) as { ok?: boolean; failure?: { code?: string } }
              return result.ok === true
                ? { ok: true }
                : { ok: false, code: result.failure?.code ?? 'apply-failed' }
            } catch (error) {
              return { ok: false, code: messageOf(error) }
            }
          },
          setSlideNotes: async (slideIndex, text) => {
            try {
              const read = (await api.readContent()) as {
                ok?: boolean
                failure?: { code?: string }
                slides?: Array<{ id?: string }>
              }
              if (read.ok !== true) return { ok: false, code: read.failure?.code ?? 'read-failed' }
              const slideId = read.slides?.[slideIndex]?.id
              if (slideId === undefined) return { ok: false, code: 'no-slide' }
              const expectVersion = await api.version()
              const result = (await api.applyEdits({
                expectVersion,
                steps: [{ op: 'setSlideNotes', target: { slideId }, text }]
              } as never)) as { ok?: boolean; failure?: { code?: string } }
              return result.ok === true
                ? { ok: true }
                : { ok: false, code: result.failure?.code ?? 'apply-failed' }
            } catch (error) {
              return { ok: false, code: messageOf(error) }
            }
          },
          save: async () => {
            try {
              await api.flushPendingInput()
              const bytes = api.save()
              return { ok: true, byteLength: bytes.byteLength }
            } catch (error) {
              return { ok: false, code: messageOf(error) }
            }
          }
        }
      }
      // PB-020 E1：打开即上报总页数（snapshot 是同步 API）；拿不到就回落到 onLoaded()
      let reported = false
      try {
        const snapshot = api.handle.snapshot() as { slides?: readonly unknown[] }
        const count = snapshot.slides?.length ?? 0
        if (count > 0) {
          reportPageCount(count)
          reported = true
        }
      } catch {
        // 拿不到就保持「—」，不影响编辑
      }
      if (!reported) propsRef.current.onLoaded()
    }, [reportPageCount])

    // 探针面随 pane 卸载消失（生产不设即不存在）
    useEffect(
      () => () => {
        delete window.__KYCLAW_OFFICE_PPTX_PROBE__
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
            // 先 flush 未提交输入，再取字节；失败不伪造成功
            await api.flushPendingInput()
            return api.save()
          } catch (error) {
            propsRef.current.onError('save', messageOf(error))
            return null
          }
        },
        async reload(bytes: Uint8Array): Promise<void> {
          apiRef.current = null
          setFile(bytes)
          setGeneration((current) => current + 1)
        }
      }),
      []
    )

    const handleChange = useCallback(
      (snapshot: { slides?: readonly unknown[] }) => {
        propsRef.current.onChanged()
        // PB-020 E1：插入/删除幻灯片后总数变化 → 状态栏跟着更新
        const count = snapshot?.slides?.length
        if (typeof count === 'number') reportPageCount(count)
      },
      [reportPageCount]
    )

    const handleEditorError = useCallback((error: Error) => {
      propsRef.current.onError('runtime', messageOf(error))
    }, [])

    const fonts = props.fonts as unknown as ReadonlyArray<PptxFontFace>

    return (
      <div
        data-testid="surface-pptx-editor"
        data-document-id={props.documentId}
        data-theme={props.theme}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        {capabilityNoteVisible ? (
          <p
            data-testid="office-format-note"
            role="note"
            title={CAPABILITY_NOTE}
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
            <span style={{ minWidth: 0, flex: 1 }}>{CAPABILITY_NOTE}</span>
            <button
              type="button"
              data-testid="office-format-note-dismiss"
              onClick={() => {
                markCapabilityNoteSeen('pptx')
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
          <PptxEditor
            key={`${props.documentId}:${String(generation)}`}
            file={file}
            fileName={props.name}
            readOnly={props.readOnly}
            fonts={fonts}
            i18n={zhCN}
            onChange={handleChange}
            onSave={notifySave}
            onSaveRequest={() => {
              // 接管内置保存（返回 false 取消下载/内置保存），统一走宿主保存状态机
              notifySave()
              return false
            }}
            onReady={handleReady}
            onError={handleEditorError}
            toolbar={pptxToolbar()}
            className="office-pptx-editor"
          />
        </div>
      </div>
    )
  }
)
