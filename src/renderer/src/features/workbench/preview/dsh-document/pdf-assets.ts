/**
 * 新版 PDF 阅读器的**本地资源供给**：把 pdf.js 要的 CMap / 标准字体从"构建期内联的懒分块"喂给它。
 *
 * ── 为什么这不是"选字用的锦上添花"（一处必须说准的话）────────────────────────
 * pdf.js 画**没有内嵌字体**的 PDF（典型：只声明"宋体/黑体"这类字体名、不嵌字形的中文文档）
 * 需要两样东西：预定义 CMap（字符码 → CID 的映射）与标准字体数据。**两样都缺时坏的是整页**：
 * 字体加载发生在页面那趟渲染里，pdf.js 的 `BaseBinaryDataFactory.fetch` 会直接抛
 * "Ensure that the `cMapUrl` API parameter is provided."，这一页**根本画不出来** ——
 * 不是"位图正常、只是选不中字"。所以"给不给本地资源"决定的是**能不能看**，不只是能不能选。
 *
 * ── 怎么给的（构建期内联，运行期零请求）──────────────────────────────────────
 * 本组件的阅读器跑在 `useWorkerFetch: false` 这一档（完整字节在手上，不让 worker 去 fetch），
 * 于是 worker 会把 `{kind, filename}` 发回主线程要数据，`BinaryDataFactory` 就是接这一问的地方
 * （`getDocument` 会用 `new BinaryDataFactory({ cMapUrl, standardFontDataUrl, wasmUrl })` 起它）。
 *
 * 我们的工厂把 `filename` 映射成**构建期内联进懒分块的字节**（`pdfjs-inline-assets-plugin.ts`
 * 装在 `electron.vite.config.ts`；清单模块是 `pdf-assets-bundled.ts`），一字节都不从网上、
 * 也不从 `file://` 取：pdf.js 自己那条 `fetchData`（fetch → XHR）在打包态会被 Chromium 拦，
 * 而**懒分块的 `import()` 在打包态本来就在跑**（渲染产物里已有十几个懒块）。
 * 不放宽 CSP、不加协议、不下载任何资源。
 *
 * **表是可注入的**：`localPdfAssets(tables)` 收一份"文件名 → base64 懒加载器"的表，
 * 单测直接喂假表就能验"解码 + 回答 worker"这一层；真的那份来自构建期虚拟模块（见
 * `pdf-assets-bundled.ts`），由 `bundledPdfAssets()` 接上。
 */

/** 一张资源表：文件名 → 该文件 base64 文本的懒加载器（调用它才会去 import 那个分块）。 */
export type PdfAssetTable = Map<string, () => Promise<string>>

/** pdf.js 认的两类本地资源的表（`wasmUrl` 不在这里：随包 pdfjs-dist 不带 wasm 文件）。 */
export interface PdfAssetTables {
  readonly cMapUrl: PdfAssetTable
  readonly standardFontDataUrl: PdfAssetTable
}

/** pdf.js 认的两类本地资源（类型面透出去给宿主用）。 */
export type PdfAssetKind = keyof PdfAssetTables

/** pdf.js 发回主线程的那一问（`FetchBinaryData`）：类别 + 文件名。 */
export interface BinaryDataRequest {
  readonly kind: string
  readonly filename: string
}

/** pdf.js 只用到这一个方法（`binaryDataFactory.fetch(request)`）。 */
export interface PdfBinaryDataFactory {
  fetch(request: BinaryDataRequest): Promise<Uint8Array>
}

/**
 * 工厂的**构造器**（不是实例）。
 * pdf.js 是这么用它自己的：`binaryDataFactory: useWorkerFetch ? null : new BinaryDataFactory({ cMapUrl, standardFontDataUrl, wasmUrl })`
 * —— 所以 `getDocument({ BinaryDataFactory })` 收到的必须是**一个类**；给实例会在打开文档时炸成
 * `BinaryDataFactory is not a constructor`（真机上就是这么炸的，R90 探针抓到的）。
 */
export type PdfBinaryDataFactoryConstructor = new (options?: {
  cMapUrl?: string | null
  standardFontDataUrl?: string | null
  wasmUrl?: string | null
}) => PdfBinaryDataFactory

/** `getDocument` 的资源相关入参（可选：整份交给它）。 */
export interface PdfAssetOptions {
  cMapPacked?: boolean
  BinaryDataFactory?: PdfBinaryDataFactoryConstructor
}

/** base64 → 原始字节（`atob` 给的是"一个字符一个字节"的串，逐字节搬回来）。 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * 造一个"本地资源（构建期内联的懒分块）供字节"的**工厂类**：pdf.js 的 worker 要什么，就取什么。
 *
 * 返回的是**构造器**（pdf.js 会用 `new` 起它，并传 `{cMapUrl, standardFontDataUrl, wasmUrl}`）：
 * 我们不吃那个参数 —— 它给的是"某个目录前缀"（`cMapUrl + filename`），而我们的资源是逐文件的
 * 懒分块，对不上号；真正要回答的是 `fetch({ kind, filename })` 那一问。
 * @param tables 取表：工厂第一次被问到时才调用（清单模块本身也是那时才 import），随后记住。
 */
function binaryDataFactoryClass(
  tables: () => Promise<PdfAssetTables>
): PdfBinaryDataFactoryConstructor {
  return class implements PdfBinaryDataFactory {
    /** 表只取一次：同一份阅读器会被问很多次（多个 CMap / 标准字体），别每次重建两张表。 */
    private tablesOnce: Promise<PdfAssetTables> | undefined

    async fetch({ kind, filename }: BinaryDataRequest): Promise<Uint8Array> {
      if (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl') {
        throw new Error(`本地资源里没有这一类：${kind}`)
      }
      this.tablesOnce ??= tables()
      const load = (await this.tablesOnce)[kind].get(filename)
      if (load === undefined) {
        throw new Error(
          `本地资源表里没有 ${filename}（随包 pdfjs 的 cmaps / standard_fonts 没内联进构建？）`
        )
      }
      return decodeBase64(await load())
    }
  }
}

/**
 * 用一份（可能是晚一步才拿到的）资源表造阅读器选项。
 * @param tables 取表：工厂第一次被问到时才调用（清单模块本身也是那时才 import）。
 */
export function localPdfAssets(tables: () => Promise<PdfAssetTables>): PdfAssetOptions {
  return { cMapPacked: true, BinaryDataFactory: binaryDataFactoryClass(tables) }
}

/**
 * 这一版阅读器默认用的资源包：**构建期内联**的本地 CMap + 标准字体。
 * 不设 `cMapUrl` / `standardFontDataUrl` 是有意的 —— 那两项是"某个目录前缀"的形态，
 * 而我们是逐文件的内联分块；worker 那一问由工厂直接回答。
 */
export function bundledPdfAssets(): PdfAssetOptions {
  return localPdfAssets(async () => (await import('./pdf-assets-bundled')).pdfAssetTables())
}
