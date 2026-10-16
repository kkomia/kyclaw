/**
 * 预览体（round 50 从 FilesTool 抽出来的"格式分流 + 人话态"）—— 单击文件的内联预览（FilesTool）
 * 与预览标签（PreviewTool）共用这一个渲染口。
 *
 * 按格式分派（分派判据在 `modes.ts`）：
 *   - `.md` / `.markdown`：markdown 渲染器（内容仍来自文本通道；DSH 那套含数学与 frontmatter）；
 *   - 代码扩展名：同一份文本过代码高亮（行号 + 换行开关在 `dsh-media/code-body.tsx`）；
 *   - `.html` / `.htm`：**字节通道** → `DshHtmlViewer` 的静态隔离预览（清洗 + `sandbox=""`，
 *     不启用脚本模式）；
 *   - 图片（png/jpeg/gif/webp/bmp **+ svg/ico**）/ `.pdf`：字节通道。图片交给 `DshImageBody`
 *     （统一缩放 + 旋转；SVG 走 `<img>` 的 data URL，不进 DOM）；**PDF 走既有 `PdfPreview`**
 *     （缩略图 + 目录书签那套能力保留）；
 *   - 纯文本 / markdown / 代码：**文本分页**（`workbench:read-text-page` 取第一页，之后
 *     `dsh-media/paged-text.tsx` 负责"加载更多"、版本变了提示重读、重读回位）——
 *     大文件不再停在 64KB；
 *   - `xls` / `xlsx` / `csv` / `tsv`：**表格原始字节**通道 → `ExcelPreview`（只读表格，渲染端解析）；
 *   - `doc` / `docx` / `ppt` / `pptx`：**页式预览** → `DshOfficeViewer`（主进程转 PDF → 新阅读器
 *     按页看；旧版 `.doc` / `.ppt` 也从"另存为"的人话升级成真能看）；
 *   - 二进制/过大给人话。
 */
import type { FileBytesResult } from '@shared/workbench'
import type { TextPage } from '@shared/workbench-text'
import { Spinner } from '@renderer/components/ui/spinner'
import { ToolError } from '../bits'
import { formatBytes } from '../format'
import { DshOfficeViewer } from './dsh-document/DshOfficeViewer'
import { describeOfficeFailure } from './dsh-document/office-bridge'
import { DshHtmlViewer } from './dsh-media/html-viewer'
import { PagedTextBody } from './dsh-media/paged-text'
import type { TextPager } from './dsh-media/text-pager'
import { ExcelPreview } from './dsh-table/ExcelPreview'
import type { LoadedPreview } from './fetch'
import { ImagePreview } from './ImagePreview'
import { PdfPreview } from './PdfPreview'
import { codeLanguageOf, type PreviewMode } from './modes'

/**
 * 页式预览 / 表格 / 旧 PDF 入口要**确定高度**（滚动口都在组件内部，表格画布也要按高度量，
 * 旧 PDF 入口的"当前页"也跟着自己那个滚动口算）。
 * 两条宿主都成立的一条 —— `h-full`：
 *   - 预览标签那侧：正文是 `flex min-h-0 flex-1`（确定高度）→ `h-full` 正好铺满；
 *   - 文件树的内联预览那侧（`BottomSheet`）：由 `sized` 那层给**确定高度**（55vh），
 *     中间每一层再 flex-1 透传（`FilesTool` 的 `file-preview-body`）。
 *     R90 探针实测：链断在哪一层，那一层以下的 `h-full` 就退化成 auto —— 表格只剩 59px、
 *     页式预览长到一千多像素（浮动控件落到可视区外）、旧 PDF 入口的目录高亮钉在最后一页。
 */
const SIZED_HOST_CLASS = 'flex h-full min-h-0 min-w-0 flex-col'

export function PreviewBody({
  relative,
  state,
  mode
}: {
  /** 看的是哪份文件（人话里要点出后缀、表格解析按它认格式、字节通道的 key 也用它） */
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

  // 办公档：页式预览（**转换在这里发生** —— 组件挂载即转，卸载/换文件即取消；
  // 取消走 requestId 那条 IPC，见 dsh-document/office-bridge.ts）
  if (mode === 'office') {
    if (state.office === undefined) {
      return <ToolError testId="file-preview-error" message="办公档预览没拿到转换口" />
    }
    return (
      <div className={SIZED_HOST_CLASS} data-testid="file-preview-office">
        <DshOfficeViewer
          load={state.office.load}
          revision={state.office.revision}
          describeFailure={describeOfficeFailure}
          className="min-h-0 flex-1"
        />
      </div>
    )
  }

  const value = state.value
  if (value === undefined) return <div />
  if (value.channel === 'table') {
    // 表格：整份原始字节已经到手，解析与画法都在 ExcelPreview（自己起 worker）
    return (
      <div className={SIZED_HOST_CLASS} data-testid="file-preview-table">
        <ExcelPreview bytes={value.table.bytes} filename={relative} />
      </div>
    )
  }
  if (value.channel === 'bytes') {
    // key 绑文件名：换文件即重挂，免得上一个文件的状态（坏图标记 / 已画页数 / 已画缩略图）跟过来
    return <BytesBody key={relative} result={value.bytes} />
  }
  return (
    <TextBody
      // key 绑"第一页的身份"（版本 + 游标 + 大小）：换文件 / 手动刷新拿到新一页时，
      // 分页组件的累计状态跟着重来（不然新文件的正文会接在旧文件后面）
      key={`${value.textPage.page.version}:${value.textPage.page.offset}:${value.textPage.page.size}`}
      mode={mode}
      relative={relative}
      page={value.textPage.page}
      pager={value.textPage.pager}
    />
  )
}

/**
 * 文本那一支：`PagedTextBody` 管"取多少、什么时候取、怎么提示"，
 * 里面再按 mode 交给 markdown / code / 纯文本三个渲染器（都是既有组件）。
 *
 * 读不到第一页（二进制 / 过大 / 没了 / 正在改）由 `fetch.ts` 翻成人话走错误落点，
 * 到不了这里 —— 所以这里只需要"有内容"这一种情形。
 */
function TextBody({
  mode,
  relative,
  page,
  pager
}: {
  mode: PreviewMode
  relative: string
  page: TextPage
  pager: TextPager
}): React.JSX.Element {
  const language = mode === 'code' ? codeLanguageOf(relative) : null
  return (
    <div className="py-2">
      <PagedTextBody mode={mode} language={language} first={page} pager={pager} />
    </div>
  )
}

/**
 * 字节通道：HTML / 图片 / PDF 各交给对应的渲染器；`missing` / `too-large` / `unsupported` 三种给人话。
 *
 * 结构档（`docx` / `xlsx` / `pptx`）**已经不走这条通道**：办公档走页式预览、表格走原始字节通道，
 * 所以这里不再有那三个渲染分支。真要回来一个结构档（不该发生），也只按二进制占位如实说 ——
 * 不拿旧渲染器硬画一份"看起来还行"的东西。
 */
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
    // 后缀认得、内容对不上暗号（改名的可执行/别的格式混进来）：按二进制占位，不猜、不硬画
    return (
      <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
        这是二进制文件（{formatBytes(result.size)}）
      </p>
    )
  }
  if (result.kind === 'bytes') {
    if (result.format === 'pdf') {
      // 旧 PDF 入口（缩略图 + 目录书签）自己也是一个滚动口：要确定高度，
      // 否则滚动口没有可滚动量，"当前页"会永远算成最后一页、点目录也不跳（见 host-size.ts）
      return (
        <div className={SIZED_HOST_CLASS} data-testid="file-preview-pdf-host">
          <PdfPreview bytes={result.bytes} />
        </div>
      )
    }
    if (result.format === 'html') {
      // HTML 要确定高度（iframe 自己铺满，滚动口在里面）
      return (
        <div className={SIZED_HOST_CLASS} data-testid="file-preview-html">
          <DshHtmlViewer bytes={result.bytes} />
        </div>
      )
    }
    // 其余是图片（含本轮新收的 svg / ico）：`DshImageBody` 自己按 MIME 表分流
    return <ImagePreview format={result.format} bytes={result.bytes} />
  }

  // 只可能是结构档（docx / xlsx / pptx）：不再由本组件渲染
  return (
    <p data-testid="file-preview-binary" className="px-3 py-2 text-b2 text-ink-secondary">
      这份文件现在不是我这条通道上的预览（换一种格式，或用本地应用打开）
    </p>
  )
}
