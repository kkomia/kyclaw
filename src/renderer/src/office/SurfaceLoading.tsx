/**
 * PB-019 · Office 打开加载态（方案 A）：骨架 ribbon + 灰画布 + 纸 + 阶段读数。
 *
 * 设计稿：`.superpowers/dev-verify/20261018-resume/pb019-loading-design.md` §3–§4。
 * 纪律：
 *  - 纯 CSS 骨架（无图/无 chunk/无定时器动画），只动 opacity/transform，不抢首帧；
 *  - 骨架 ribbon 高度 = 真实 chrome 的 83px（`--office-ribbon-total-height`），就绪时不跳 83px；
 *  - 只按阶段推进（4 段 meter），**不报假百分比**；文案只说事实（46 字面 / 6 面 / 表格运行时）；
 *  - 同一阶段停留 <80ms 时跳过该阶段文案（避免 4 句文案在 300ms 内轮播）；
 *  - 升格命中的预热面（`?officePrewarm=1`）不渲染骨架（见 SurfaceBoot）。
 */
import { useEffect, useRef, useState } from 'react'
import './surface-loading.css'

export type SurfaceLoadingKind = 'docx' | 'xlsx' | 'pptx'
export type SurfaceLoadingStage = 1 | 2 | 3 | 4

export interface LoadingStageInput {
  kind: SurfaceLoadingKind | null
  /** 是否已收到 doc:open */
  doc: boolean
  fontsState: 'idle' | 'loading' | 'ready' | 'error'
  pptxFontsState: 'idle' | 'loading' | 'ready' | 'error'
  editorState: 'idle' | 'loading' | 'ready' | 'error'
}

/**
 * 阶段推导（纯函数，单测可直接断言）：
 *  1 准备（还没收到文档）→ 2 读取（收到 doc:open、字体/引擎还没开始）→
 *  3 解析/渲染（字体或引擎 loading；也覆盖“字体已好、编辑器首帧未到”）→ 4 就绪。
 */
export function loadingStageOf(input: LoadingStageInput): SurfaceLoadingStage {
  if (!input.doc || input.kind === null) return 1
  if (input.editorState === 'ready') return 4
  if (input.kind === 'docx') {
    return input.fontsState === 'idle' && input.editorState === 'idle' ? 2 : 3
  }
  if (input.kind === 'pptx') {
    return input.pptxFontsState === 'idle' && input.editorState === 'idle' ? 2 : 3
  }
  // xlsx：没有字体阶段，doc:open → 引擎/编辑器 loading
  return input.editorState === 'idle' ? 2 : 3
}

/** 阶段文案（事实口径；pptx 不再复用 docx 的“正在注册本地字体…”，见 PB-019 §3.5） */
export function loadingCopyOf(
  kind: SurfaceLoadingKind,
  stage: SurfaceLoadingStage,
  docBytes: number
): { label: string; meta: string } {
  if (stage === 1) return { label: '正在打开文档', meta: '' }
  if (stage === 2) {
    const size = docBytes >= 1024 * 1024 ? `${(docBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(docBytes / 1024))} KB`
    return { label: '正在读取内容', meta: `${size} · ${kind.toUpperCase()}` }
  }
  if (stage === 4) return { label: '即将显示', meta: '' }
  if (kind === 'xlsx') return { label: '正在准备表格引擎', meta: '表格运行时 · 本地' }
  if (kind === 'pptx') return { label: '正在准备演示文稿字体 · 6 面', meta: '本地读取' }
  return { label: '正在准备中文字体', meta: '46 个字面 · 本地读取' }
}

/** 阶段停留 <80ms 时跳过该句文案（设计 §3.9）；stage 4 永远立即生效 */
function useDisplayedStage(stage: SurfaceLoadingStage): SurfaceLoadingStage {
  const [displayed, setDisplayed] = useState<SurfaceLoadingStage>(stage)
  const lastChangeRef = useRef<number>(performance.now())
  const stageRef = useRef(stage)
  stageRef.current = stage
  useEffect(() => {
    if (stage === displayed) return
    const elapsed = performance.now() - lastChangeRef.current
    if (stage === 4 || elapsed >= 80) {
      lastChangeRef.current = performance.now()
      setDisplayed(stage)
      return
    }
    const timer = window.setTimeout(() => {
      lastChangeRef.current = performance.now()
      setDisplayed(stageRef.current)
    }, 80 - elapsed)
    return () => window.clearTimeout(timer)
  }, [stage, displayed])
  return displayed
}

export interface SurfaceLoadingProps {
  kind: SurfaceLoadingKind
  stage: SurfaceLoadingStage
  docBytes: number
  testId: string
  /** 就绪后淡出（150ms）用；true 时不再接受指针事件 */
  leaving?: boolean
}

export function SurfaceLoading({
  kind,
  stage,
  docBytes,
  testId,
  leaving = false
}: SurfaceLoadingProps): React.JSX.Element {
  const shownStage = useDisplayedStage(stage)
  const { label, meta } = loadingCopyOf(kind, shownStage, docBytes)
  return (
    <div
      className="office-surface-loading"
      data-testid={testId}
      data-surface-loading-stage={stage}
      data-surface-loading-shown-stage={shownStage}
      data-kind={kind}
      data-leaving={leaving ? 'true' : 'false'}
      aria-live="polite"
    >
      {/* 骨架 ribbon：28 tabs + 54 band + 1 hairline = 83（与真实 chrome 同高，就绪不跳） */}
      <div className="osl-ribbon" aria-hidden="true">
        <div className="osl-tabs">
          <i />
          <i />
          <i />
        </div>
        <div className="osl-band">
          {[0, 1, 2, 3, 4].map((group) => (
            <div className="osl-group" key={group}>
              <i />
              <i />
              <i />
            </div>
          ))}
        </div>
      </div>
      <div className="osl-canvas">
        <div className="osl-paper" aria-hidden="true">
          <i className="osl-line" data-row="title" />
          <i className="osl-line" data-row="1" />
          <i className="osl-line" data-row="2" />
          <i className="osl-line" data-row="3" />
          <i className="osl-line" data-row="4" />
        </div>
        <div className="osl-status">
          <span className="osl-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="osl-label">{label}</span>
          {meta === '' ? null : <span className="osl-meta">{meta}</span>}
        </div>
        <div className="osl-meter" aria-hidden="true">
          {[1, 2, 3, 4].map((segment) => (
            <i
              key={segment}
              data-seg={segment}
              data-state={segment < shownStage ? 'done' : segment === shownStage && shownStage < 4 ? 'current' : segment === shownStage && shownStage === 4 ? 'done' : 'todo'}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
