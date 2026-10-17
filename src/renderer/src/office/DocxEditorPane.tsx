/**
 * 面内的 DOCX 编辑器（M3-S3）：`@betteroffice/docx-react` 的 `DocxEditor` 薄包装。
 *
 * 只在面收到 `doc:open` 且字体就绪后挂载（由 `SurfaceBoot` 控制）；这里只做四件事：
 *   - `documentBuffer`：壳经 postMessage 投递的字节（S3 一次性，S4/S5 再谈复用）；
 *   - `onChange`：用户编辑 → 面内 revision 单调 +1（由 `SurfaceBoot` 转 `doc:changed`）；
 *   - `onSaveRequest`：编辑器自己的 Ctrl+S / File > Save → 交给壳的保存状态机
 *     （**不让编辑器内置保存生效**：返回 false，且 `downloadOnSave=false`）；
 *   - 命令式方法（`ref`）：`save()` = `flushPendingInput()` + `ref.save()`（保存三阶段的 generate），
 *     `reload(bytes)` = `loadDocumentBuffer`（冲突后重新载入）。
 *
 * 不 import 任何网络/CDN 字体；主题走 `colorMode`（壳的解析明暗）。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type RefObject
} from 'react'
import { DocxEditor, type DocxEditorRef } from '@betteroffice/docx-react'
import type { SurfaceTheme } from './bridge-protocol'

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
  /** 用户编辑（壳据此推进 editSeq / dirty） */
  onChanged(): void
  /** 编辑器内部保存请求（Ctrl+S / File > Save）→ 壳的保存状态机 */
  onSaveRequest(): void
  /** 首次布局完成（页数） */
  onLoaded(pages: number): void
  /** 面内错误（打开/布局/保存/运行时） */
  onError(phase: DocxErrorPhase, message: string): void
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
      propsRef.current.onChanged()
    }, [])

    const handleSaveRequest = useCallback(() => {
      propsRef.current.onSaveRequest()
      // false = 不走编辑器内置保存（下载/写盘都由宿主负责）
      return false
    }, [])

    const handleError = useCallback((error: Error) => {
      propsRef.current.onError('runtime', messageOf(error))
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
          readOnly={props.readOnly}
          colorMode={props.theme}
          onChange={handleChange}
          onSaveRequest={handleSaveRequest}
          onError={handleError}
        />
      </div>
    )
  }
)
