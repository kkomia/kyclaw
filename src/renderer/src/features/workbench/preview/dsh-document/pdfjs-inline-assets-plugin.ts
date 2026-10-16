/**
 * 构建期把 pdf.js 的本地资源（预定义 CMap / 标准字体）**内联进按需加载的 JS 分块**。
 *
 * ── 为什么需要它（这是打包态能不能看 CJK 的分水岭）─────────────────────────
 * pdf.js 取 CMap / 标准字体走的是自己的 `fetchData`（fetch → XHR 回落）。打包态渲染端是
 * `file://`，Chromium 默认拦住 file:// 的 fetch/XHR（也没有为它放宽 CSP / 加协议的道理）——
 * 结果是**没有内嵌字体的 PDF 整页画不出来**（不是"只有文字层没字"）。
 * 而 **JS 分块的按需加载在打包态本来就在用**（`out/renderer/assets/` 里已经有 14 个懒块，
 * 含 pdfjs 自己那一块），所以：把资源以 base64 落进独立的懒分块，运行期只 `import()` 对应那几块，
 * **一个请求都不发**。既不放宽 CSP、也不引入自定义协议、更不下载任何东西。
 *
 * ── 有界读取（**只碰这两处**）──────────────────────────────────────────────
 *   - `<root>/cmaps/*.bcmap`
 *   - `<root>/standard_fonts/*.{ttf,pfb}`（`root` 由配置传进来，就是 `node_modules/pdfjs-dist`）
 * 只看这两层目录、**不递归**、按扩展名过滤（`LICENSE_FOXIT` / `LICENSE_LIBERATION` 这类
 * 不是资源，不进分块）；单文件与总量都有上限，超了当场抛错（不悄悄内联一个巨物）。
 * 不做任何宽泛的资产处理：除了这两个目录，本插件不认识别的路径。
 *
 * ── 产出的两个虚拟模块 ───────────────────────────────────────────────────
 *   - `virtual:kyclaw-pdfjs-assets`：`CMAP_FILES` / `FONT_FILES` 两张表，值是"文件名 →
 *     懒加载器"（每个加载器是一次 `import()`，因此一个资源一个分块）；
 *   - `virtual:kyclaw-pdfjs-assets/file/<组>/<文件名>`：`export default "<base64>"`，只认索引里
 *     有的名字（没扫到的名字一律不认，`../` 之类走不进来）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

/** 清单模块的 id（消费者按它 import；类型面见同目录 `pdfjs-assets-virtual.d.ts`）。 */
export const PDFJS_ASSETS_MANIFEST_ID = 'virtual:kyclaw-pdfjs-assets'

const RESOLVED_MANIFEST_ID = `\0${PDFJS_ASSETS_MANIFEST_ID}`
const FILE_ID_PREFIX = `${PDFJS_ASSETS_MANIFEST_ID}/file/`
const RESOLVED_FILE_ID_PREFIX = `\0${FILE_ID_PREFIX}`

/** 插件名（构建日志里能认出来）。 */
export const PDFJS_ASSETS_PLUGIN_NAME = 'kyclaw:pdfjs-inline-assets'

/** 两个资源组：pdf.js 的目录名 + 认得哪些扩展名 + 清单里导出成什么名字。 */
const ASSET_GROUPS = [
  { group: 'cmaps', exportName: 'CMAP_FILES', dir: 'cmaps', extensions: ['.bcmap'] },
  { group: 'fonts', exportName: 'FONT_FILES', dir: 'standard_fonts', extensions: ['.ttf', '.pfb'] }
] as const

/** 单文件上限（字节）：实测最大的 CMap/字体也就几百 KB，16 MiB 是护栏不是口径。 */
const DEFAULT_MAX_ASSET_BYTES = 16 * 1024 * 1024
/** 两者合计上限（字节）：实测 1.5 MB + 820 KB，32 MiB 同理是护栏。 */
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024

export interface PdfjsInlineAssetsOptions {
  /** pdfjs-dist 的包根目录（**明确那一条路径**，配置里传绝对路径进来）。 */
  readonly root: string
  readonly maxAssetBytes?: number
  readonly maxTotalBytes?: number
}

interface GroupIndex {
  readonly group: string
  readonly exportName: string
  readonly files: readonly string[]
}

interface AssetIndex {
  readonly groups: readonly GroupIndex[]
  /** `组/文件名` → 绝对路径 */
  readonly paths: ReadonlyMap<string, string>
}

/** 扫一遍两个目录（有界：不递归、按扩展名过滤、只收常规文件）。 */
function scanAssets(options: PdfjsInlineAssetsOptions): AssetIndex {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const groups: GroupIndex[] = []
  const paths = new Map<string, string>()
  let total = 0

  for (const { group, exportName, dir, extensions } of ASSET_GROUPS) {
    const dirPath = join(options.root, dir)
    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch (error) {
      throw new Error(`pdf.js 资源目录读不到：${dirPath}（pdfjs-dist 装了吗？）`, { cause: error })
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => extensions.some((extension) => name.toLowerCase().endsWith(extension)))
      .sort()
    if (files.length === 0) {
      throw new Error(`pdf.js 资源目录里没有可内联的文件：${dirPath}`)
    }
    for (const name of files) {
      const path = join(dirPath, name)
      const size = statSync(path).size
      if (size > maxAssetBytes) {
        throw new Error(`pdf.js 资源超过单文件上限（${size} > ${maxAssetBytes}）：${path}`)
      }
      total += size
      if (total > maxTotalBytes) {
        throw new Error(`pdf.js 资源总量超过上限（${total} > ${maxTotalBytes}）：${dirPath}`)
      }
      paths.set(`${group}/${name}`, path)
    }
    groups.push({ group, exportName, files })
  }

  return { groups, paths }
}

/** 清单模块的代码：每张表一个"文件名 → () => import(该文件).then(m => m.default)"。 */
function manifestCode(index: AssetIndex): string {
  const blocks = index.groups.map(({ group, exportName, files }) => {
    const entries = files.map((name) => {
      const id = `${FILE_ID_PREFIX}${group}/${name}`
      // `.then((mod) => mod.default)` 不是装饰：每个资源模块是 `export default "<base64>"`，
      // 光 `import()` 拿到的是模块命名空间（`{ default }`），而消费侧的约定是**直接给字符串**。
      return `${JSON.stringify(name)}: () => import(${JSON.stringify(id)}).then((mod) => mod.default)`
    })
    return `export const ${exportName} = {\n${entries.join(',\n')}\n}\n`
  })
  return blocks.join('\n')
}

/**
 * 造插件。
 * @param options `root` 指向 `node_modules/pdfjs-dist`（绝对路径），其余是可选护栏。
 * @returns 只服务上面两个虚拟模块的 Vite 插件。
 */
export function createPdfjsInlineAssetsPlugin(options: PdfjsInlineAssetsOptions): Plugin {
  // 扫一次就够：目录内容在构建期不会变（换了 pdfjs 版本要重跑构建）
  const index = scanAssets(options)

  return {
    name: PDFJS_ASSETS_PLUGIN_NAME,
    resolveId(id) {
      if (id === PDFJS_ASSETS_MANIFEST_ID) return RESOLVED_MANIFEST_ID
      if (id.startsWith(FILE_ID_PREFIX)) {
        const key = id.slice(FILE_ID_PREFIX.length)
        return index.paths.has(key) ? `${RESOLVED_FILE_ID_PREFIX}${key}` : null
      }
      return null
    },
    load(id) {
      if (id === RESOLVED_MANIFEST_ID) return manifestCode(index)
      if (id.startsWith(RESOLVED_FILE_ID_PREFIX)) {
        const key = id.slice(RESOLVED_FILE_ID_PREFIX.length)
        const path = index.paths.get(key)
        if (path === undefined) return null
        this.addWatchFile(path)
        return `export default ${JSON.stringify(readFileSync(path).toString('base64'))}`
      }
      return null
    }
  }
}
