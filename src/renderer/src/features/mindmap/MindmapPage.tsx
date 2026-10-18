/**
 * PB-024 导图模块（0.1.5）：Mermaid mindmap 文本 + Pele 实时预览。
 *
 * 取舍（Lead 决策）：Pele 只有渲染、没有编辑器 → 最小可用形态 = 左文本编辑、右 SVG 预览；
 * 不做节点拖拽/增删（那需要另写编辑器）。AI 入口与 Office 统一打样：复用 OfficeAiPanel 的
 * 诚实空态（不读内容、不产生修改），不做假按钮。
 *
 * 约束：Pele 按需注册（core + mindmap），不 import 全量入口；不参与首屏/预热路径
 * （本页 lazy 路由，进 /mindmap 才加载）；主题走 `--pele-*` → 现有 token 映射。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { mount, register, type Mounted } from 'pele/core'
import mindmap from 'pele/diagrams/mindmap'
import { OfficeAiPanel } from '@renderer/features/office/OfficeAiPanel'
import {
  DEFAULT_MINDMAP_TEXT,
  NEW_MINDMAP_TEXT,
  charCountOf,
  loadMindmapText,
  saveMindmapText
} from './mindmap-text'
import './mindmap.css'

/** 只注册一次 mindmap（按需注册，避免把另外 32 种图打进包）；必须同步注册在 mount 之前 */
let registered = false
function ensureRegistered(): void {
  if (registered) return
  registered = true
  register(mindmap)
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export interface MindmapPageHandle {
  /** 供单测/探针读取当前文本 */
  getText(): string
}

export const MindmapPage = forwardRef<MindmapPageHandle, Record<string, never>>(
  function MindmapPage(_props, ref) {
    const [text, setText] = useState<string>(() => loadMindmapText())
    const [error, setError] = useState('')
    const [aiOpen, setAiOpen] = useState(true)
    const previewRef = useRef<HTMLDivElement | null>(null)
    const mountedRef = useRef<Mounted | null>(null)
    const mountedOnceRef = useRef(false)

    useImperativeHandle(ref, () => ({ getText: () => text }), [text])

    // 首次挂载：Pele mount（含缩放/平移）；之后文本变化走 update()
    useEffect(() => {
      ensureRegistered()
      const el = previewRef.current
      if (el === null) return
      const handle = mount(el, loadMindmapText(), {
        zoom: true,
        onRender: () => setError(''),
        onError: (cause) => setError(messageOf(cause))
      })
      mountedRef.current = handle
      mountedOnceRef.current = true
      return () => {
        handle.destroy()
        mountedRef.current = null
        mountedOnceRef.current = false
      }
    }, [])

    useEffect(() => {
      if (!mountedOnceRef.current) return
      mountedRef.current?.update(text, {
        zoom: true,
        onRender: () => setError(''),
        onError: (cause) => setError(messageOf(cause))
      })
    }, [text])

    // 自动保存：debounce 500ms（单文档）
    useEffect(() => {
      const timer = window.setTimeout(() => saveMindmapText(text), 500)
      return () => window.clearTimeout(timer)
    }, [text])

    const resetZoom = useCallback(() => {
      mountedRef.current?.zoom?.reset()
    }, [])

    const useExample = useCallback(() => {
      setText(DEFAULT_MINDMAP_TEXT)
    }, [])

    const createNew = useCallback(() => {
      setText(NEW_MINDMAP_TEXT)
    }, [])

    return (
      <section data-testid="mindmap-page" className="mm-root" aria-label="导图">
        <header className="mm-toolbar">
          <h1 className="mm-title">导图</h1>
          <div className="mm-actions">
            <button type="button" data-testid="mindmap-new" className="mm-btn" onClick={createNew}>
              新建
            </button>
            <button
              type="button"
              data-testid="mindmap-example"
              className="mm-btn"
              onClick={useExample}
            >
              示例
            </button>
            <button
              type="button"
              data-testid="mindmap-reset-zoom"
              className="mm-btn"
              onClick={resetZoom}
            >
              适配
            </button>
          </div>
          <button
            type="button"
            data-testid="mindmap-ai-toggle"
            className="mm-btn"
            aria-expanded={aiOpen}
            aria-controls="mindmap-ai-panel"
            onClick={() => setAiOpen((open) => !open)}
          >
            AI 助手
          </button>
        </header>

        <div className="mm-body">
          <div className="mm-editor-pane">
            <label className="mm-editor-label" htmlFor="mindmap-editor">
              Mermaid 文本
            </label>
            <textarea
              id="mindmap-editor"
              data-testid="mindmap-editor"
              className="mm-editor"
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="mm-preview-wrap">
            <div ref={previewRef} data-testid="mindmap-preview" className="mm-preview" />
            {error === '' ? null : (
              <p data-testid="mindmap-error" role="alert" className="mm-error">
                {error}
              </p>
            )}
          </div>
          <OfficeAiPanel
            open={aiOpen}
            onCollapse={() => setAiOpen(false)}
            // 与 Office 同一套诚实空态（组件自带 aria-label="AI 助手"）
          />
        </div>

        <footer data-testid="mindmap-status" className="mm-status">
          <span className="mm-status-item" data-testid="mindmap-chars">
            {charCountOf(text)} 字符
          </span>
          <span className="mm-status-item mm-status-muted">Mermaid mindmap · 本地</span>
          {error === '' ? null : (
            <span className="mm-status-item mm-status-error" role="status">
              语法错误：请检查 Mermaid 文本
            </span>
          )}
        </footer>
      </section>
    )
  }
)
