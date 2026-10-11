/**
 * PDF 文本抽取（模块 2）：**所有模型统一走主进程**抽文本，再把文本按【附件】围栏口径内联进消息。
 *
 * 为什么不是"PDF 随消息发"：能收 PDF 的协议只有一部分端点支持（`file` part + `application/pdf`
 * 是 OpenAI 兼容层里的一条，Anthropic 又是另一套），而**文本抽取是普适的**——不认视觉的模型也读得到。
 * PDF 渲染成图（把整份 PDF 当图片发）留 v2：那要求本地有 canvas 能力（原生依赖），本轮明确不做。
 *
 * 依赖选择（pdfjs-dist 的 **legacy** 构建）：
 *   - 纯 JS、无原生依赖（它的可选依赖 @napi-rs/canvas 只为"渲染成图"，已在 pnpm-workspace.yaml 的
 *     ignoredOptionalDependencies 里排除）；
 *   - legacy 构建自带 Node 侧缺的那几个 DOM 垫片（`DOMMatrix` 之类），普通构建在 Node 里会直接炸；
 *   - 主进程产物是 CJS、它是 ESM-only：按本仓库对 ESM-only 依赖的既有口径走**动态 import()**。
 * 只调 getTextContent（不取值、不渲图），所以不需要 worker 之外的任何浏览器能力。
 *
 * 版本口径（pdfjs-dist 6）：文档代理没有 `destroy()`，**加载任务**才有 —— 收尾统一走任务，
 * 否则 worker 会一直挂着（Node 进程不退出）。
 */
import {
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_PAGE_MAX_CHARS,
  PDF_TEXT_MAX_CHARS,
  type PdfExtractResult
} from '../shared/attachments'

/** 没有文字层（扫描件 / 纯图 PDF）时给人话 */
const NO_TEXT_LAYER_MESSAGE = '这个 PDF 没有文字层（可能是扫描件），读不到文字内容'

/**
 * 用到的 pdfjs 形状（结构类型，不走它的 .d.mts —— 那是 ESM-only 的类型面，
 * 主进程这边只要这几个成员；签名对不上时编译期就会炸）。
 */
interface PdfPageLike {
  getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>
  cleanup(): void
}

interface PdfDocumentLike {
  numPages: number
  getPage(page: number): Promise<PdfPageLike>
}

interface PdfLoadingTask {
  promise: Promise<PdfDocumentLike>
  destroy(): Promise<void>
}

/** 一页的文字块（页码标记 + 正文）——与 composer 的【附件】围栏一起进消息 */
function pageBlock(page: number, text: string): string {
  return `【第 ${page} 页】\n${text}`
}

/** pdfjs 的异常名 → 人话（拿不到名字就通用文案；真实原因已经没地方给用户看了） */
function pdfErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return '这个 PDF 有密码，打不开'
  if (name === 'InvalidPDFException') return '读不出这个 PDF（文件可能损坏）'
  return '读不出这个 PDF 的内容'
}

/** 实义字符数（判"有没有文字层"；空白不算） */
function textCharCount(text: string): number {
  return text.replace(/\s/g, '').length
}

/** 载入 pdfjs 并打开一份内存里的 PDF（动态 import：ESM-only 依赖走本仓库既有口径） */
async function loadDocument(bytes: Uint8Array): Promise<PdfLoadingTask> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // 复制一份：pdfjs 会**转移**（detach）传进去的 buffer，调用方手里的那个不能再借给别人
  return pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    // 只抽文字：不取系统字体、不发网络请求（Node 侧也就没有 canvas 的需求）。
    // 注：pdfjs v6 起已没有 isEvalSupported 这个选项（旧版的 eval 字体路径被移除了）。
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true
  }) as unknown as PdfLoadingTask
}

/** 抽文字层本体（document 已经打开；抛出的错误由调用方翻人话） */
async function collectText(document: PdfDocumentLike): Promise<PdfExtractResult> {
  const totalPages = document.numPages
  const limit = Math.min(totalPages, PDF_MAX_PAGES)
  let truncated = totalPages > limit
  let chars = 0
  let used = 0
  const blocks: string[] = []

  for (let page = 1; page <= limit; page++) {
    const pageProxy = await document.getPage(page)
    try {
      const content = await pageProxy.getTextContent()
      let text = content.items
        .flatMap((item) =>
          'str' in (item as { str?: unknown }) && typeof (item as { str: unknown }).str === 'string'
            ? [(item as { str: string }).str]
            : []
        )
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length > PDF_PAGE_MAX_CHARS) {
        text = `${text.slice(0, PDF_PAGE_MAX_CHARS)}（本页超过 ${PDF_PAGE_MAX_CHARS} 字符，已截断）`
        truncated = true
      }
      chars += textCharCount(text)
      // 没有文字层的页（混在文档里的扫描页）不占一个空标记——页码标记留给真有内容的那几页
      if (text === '') continue

      const block = pageBlock(page, text)
      if (used + block.length > PDF_TEXT_MAX_CHARS) {
        truncated = true
        blocks.push(
          `【第 ${page} 页】\n（正文超过 ${PDF_TEXT_MAX_CHARS} 字符上限，后续内容已截断）`
        )
        break
      }
      used += block.length + 1
      blocks.push(block)
    } finally {
      pageProxy.cleanup()
    }
  }

  if (chars === 0) return { ok: false, message: NO_TEXT_LAYER_MESSAGE }
  return { ok: true, pages: totalPages, truncated, text: blocks.join('\n\n') }
}

/**
 * 抽一份 PDF 的文字层（有界：页数 / 单页 / 总量三道上限，超了如实标 truncated）。
 * 不抛：打不开、加密、没有文字层都走 `{ok:false, message}`（渲染端原样给人话）。
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtractResult> {
  if (bytes.byteLength === 0) return { ok: false, message: '这是空文件' }
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { ok: false, message: `超过 ${PDF_MAX_BYTES / 1024 / 1024}MB` }
  }

  let loading: PdfLoadingTask | null = null
  try {
    loading = await loadDocument(bytes)
    return await collectText(await loading.promise)
  } catch (error) {
    return { ok: false, message: pdfErrorText(error) }
  } finally {
    if (loading !== null) {
      await loading.destroy().catch(() => {
        /* 收尾失败不影响已经抽到的文本 */
      })
    }
  }
}
