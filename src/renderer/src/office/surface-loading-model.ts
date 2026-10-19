/**
 * PB-019：Office 加载态的阶段推导/文案（纯函数）。
 *
 * PB-048（lint-only 收口）：从 `SurfaceLoading.tsx` 拆出——组件文件只导出组件，避免
 * `react-refresh/only-export-components`；逻辑与文案逐字未改。
 */
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
    const size =
      docBytes >= 1024 * 1024
        ? `${(docBytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(docBytes / 1024))} KB`
    return { label: '正在读取内容', meta: `${size} · ${kind.toUpperCase()}` }
  }
  if (stage === 4) return { label: '即将显示', meta: '' }
  if (kind === 'xlsx') return { label: '正在准备表格引擎', meta: '表格运行时 · 本地' }
  if (kind === 'pptx') return { label: '正在准备演示文稿字体 · 6 面', meta: '本地读取' }
  return { label: '正在准备中文字体', meta: '46 个字面 · 本地读取' }
}
