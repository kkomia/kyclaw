/**
 * 预览体（round 50 从 FilesTool 抽出来的"格式分流 + 人话态"，**行为逐字不变**）——
 * 单击文件的内联预览（FilesTool）与预览标签（PreviewTool）共用这一个渲染口。
 *
 * 按格式分派：
 *   - `.md` / `.markdown`：走 markdown 渲染器（内容仍来自文本通道）；
 *   - 代码扩展名（`previewModeOf` 认得出的那些）：同一份文本过代码高亮；
 *   - 图片 / `.pdf` / 办公三件 / csv：走字节通道（原始字节或主进程抽好的结构）；
 *   - `.doc` / `.xls` / `.ppt`：不读文件，直接给"另存为新格式"的人话；
 *   - 其余：文本档原样（monospace、换行保留）；二进制/过大给人话。
 */
import type { FileBytesResult, FilePreview } from '@shared/workbench'
import { Spinner } from '@renderer/components/ui/spinner'
import { ToolError } from '../bits'
import { formatBytes } from '../format'
import { CodePreview } from './CodePreview'
import { ImagePreview } from './ImagePreview'
import { MarkdownPreview } from './MarkdownPreview'
import { PdfPreview } from './PdfPreview'
import { PptxPreview } from './PptxPreview'
import { TablePreview } from './TablePreview'
import type { LoadedPreview } from './fetch'
import { codeLanguageOf, extensionOf, LEGACY_OFFICE_NOTICE, type PreviewMode } from './modes'

export function PreviewBody({
  relative,
  state,
  mode
}: {
  /** 看的是哪份文件（人话里要点出旧版 Office 的后缀、字节通道的 key 也用它） */
  relative: string
  /** 读到什么了 */
  state: LoadedPreview
  /** 按后缀定下来的渲染方式（调用方用 `previewModeOf(relative)` 算） */
  mode: PreviewMode
}): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex justify-center py-4">
        <Spinner label="加载中" className="text-ink-tertiary" />
      </div>
    )
  }
  if (state.status === 'error') {
    return <ToolError testId="file-preview-error" message={state.error ?? '读不了这个文件'} />
  }

  // 旧版 Office：没有 value（压根没读文件），人话在这儿收口
  if (mode === 'office-legacy') {
    return (
      <p data-testid="file-preview-legacy" className="px-3 py-2 text-b2 text-ink-secondary">
        {LEGACY_OFFICE_NOTICE[extensionOf(relative)] ?? '这个旧版 Office 文件暂不支持预览'}
      </p>
    )
  }

  const value = state.value
  if (value === undefined) return <div />
  if (value.channel === 'bytes') {
    // key 绑文件名：换文件即重挂，免得上一个文件的状态（坏图标记 / 已画页数 / 当前工作表）跟过来
    return <BytesBody key={relative} result={value.bytes} />
  }
  return <TextBody mode={mode} relative={relative} preview={value.preview} />
}

/** 文本通道的那三种结果（markdown / 代码只是把它们里的 `text` 过一遍对应的渲染器） */
function TextBody({
  mode,
  relative,
  preview
}: {
  mode: PreviewMode
  relative: string
  preview: FilePreview
}): React.JSX.Element {
  if (preview.kind === 'binary') {
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(preview.size)}）
      </p>
    )
  }
  if (preview.kind === 'too-large') {
    return (
      <p data-testid="file-preview-large" className="px-3 py-2 text-b2 text-ink-secondary">
        文件太大（{formatBytes(preview.size)}），不适合在这里预览
      </p>
    )
  }

  const language = mode === 'code' ? codeLanguageOf(relative) : null

  return (
    <div className="py-2">
      {mode === 'markdown' ? (
        <MarkdownPreview text={preview.text} />
      ) : language === null ? (
        <div data-testid="file-preview-text" className="px-3">
          <pre className="font-mono text-b2 whitespace-pre-wrap break-all text-ink">
            {preview.text}
          </pre>
        </div>
      ) : (
        <CodePreview text={preview.text} language={language} />
      )}
      {preview.truncated ? (
        <p className="px-3 pt-2 text-b2 text-ink-tertiary">
          只显示前面一部分（共 {formatBytes(preview.size)}）
        </p>
      ) : null}
    </div>
  )
}

/** 字节通道：认得出的格式交给对应的渲染器；其余三种给人话（与文本档同口径） */
function BytesBody({ result }: { result: FileBytesResult }): React.JSX.Element {
  if (result.kind === 'missing') {
    return (
      <p data-testid="file-preview-missing" className="px-3 py-2 text-b2 text-ink-secondary">
        这个文件不在磁盘上了（可能刚被删除或改名）
      </p>
    )
  }
  if (result.kind === 'too-large') {
    return (
      <p data-testid="file-preview-large" className="px-3 py-2 text-b2 text-ink-secondary">
        文件太大（{formatBytes(result.size)}），不适合在这里预览
      </p>
    )
  }
  if (result.kind === 'unsupported') {
    // 后缀认得、内容对不上暗号（或后缀不认得）：按二进制占位，不猜、不硬画
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(result.size)}）
      </p>
    )
  }

  if (result.kind === 'docx') {
    // Word 在主进程已转成 markdown：这里就是 markdown 渲染器（同一个组件，零新渲染器）
    return (
      <div className="py-2">
        <MarkdownPreview text={result.markdown} />
        {result.truncated ? (
          <p
            data-testid="file-preview-docx-truncated"
            className="px-3 pt-2 text-b2 text-ink-tertiary"
          >
            文档太长，只显示了前面一部分
          </p>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'xlsx') {
    return (
      <div className="py-2">
        <TablePreview sheets={result.sheets} />
        {result.truncated ? (
          <p
            data-testid="file-preview-table-sheets-truncated"
            className="px-3 pt-2 text-b2 text-ink-tertiary"
          >
            工作表太多，只显示了前 {result.sheets.length} 张
          </p>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'pptx') {
    return <PptxPreview slides={result.slides} truncated={result.truncated} />
  }

  return result.format === 'pdf' ? (
    <PdfPreview bytes={result.bytes} />
  ) : (
    <ImagePreview format={result.format} bytes={result.bytes} />
  )
}
