/**
 * Office 隔离面内的**本地字体注册**（M3-S3，方案 §3.3；spike 唯一可行路径
 * `.superpowers/research/r020-office-spike/src/renderer/src/App.jsx:136-177`，
 * 实测口径 `report/REPORT.md:148-157`：22 个字体面 / 46 个注册 / 27.38 MB / 2.05–2.58 s）。
 *
 * 两条链缺一不可：
 *   1. `configureDefaultFonts({ fonts })`：把随包字体的**字节 provider** 交给 wasm 侧排版/测量引擎；
 *   2. `FontFace` 注册**别名**（Arial→Liberation Sans、微软雅黑→Noto Sans SC、宋体→Noto Serif SC…）：
 *      让浏览器绘制与 wasm 测量用**同一份字节**，否则 DOM 里的 fallback 字体和分页会分叉。
 *
 * 离线：`setGoogleFontsEnabled(false)`；只从 `@betteroffice/fonts(-cjk)` 的包内资产读字节，
 * **绝不 import `@betteroffice/fonts/cdn`**。CJK 由 fonts 包内部动态 import `@betteroffice/fonts-cjk`。
 *
 * dev 特例（M3-S3 真机验证发现）：Vite dev 会预打包 `@betteroffice/fonts`，esbuild 预打包不会改写
 * 包里的 `new URL('../assets/x.ttf', import.meta.url)` → dev 下 URL 落到 Vite 兜底页（HTML），
 * 字节长度校验失败、编辑器起不来（构建态 Rollup 会正确处理，preview/打包不受影响）。
 * 所以 dev 下改从 dev server 的原始文件路径 `/node_modules/@betteroffice/<pkg>/assets/<file>`
 * 取字节，并自带一个**同形的 provider** 交给 `configureDefaultFonts`；构建态仍走包默认逻辑。
 */
import { setGoogleFontsEnabled } from '@betteroffice/docx'
import { configureDefaultFonts } from '@betteroffice/docx/layout'
import type { BundledFontModule, BundledFontProvider } from '@betteroffice/docx/layout'
import * as fontsModule from '@betteroffice/fonts'
import {
  BUNDLED_FONTS,
  loadBundledFontBytes,
  registerBundledFontFace,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
  resolveScriptFallbackFace,
  type BundledFontFace
} from '@betteroffice/fonts'

/** 面的字体注册结果（进日志/探针证据；与 spike 的 stats 同形） */
export interface SurfaceFontStats {
  faces: number
  registrations: number
  fetchedBytes: number
  fontSetSize: number
  ms: number
  cjk: boolean
  /** dev 下走 Vite 原始文件 URL；构建态 false（走包默认资产解析） */
  devAssetUrls: boolean
}

/** Latin：随包字体的真实 family → 它要顶替的 Word 字体名（spike App.jsx:136-142） */
const LATIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Carlito: ['Calibri'],
  Caladea: ['Cambria'],
  'Liberation Sans': ['Arial', 'Helvetica'],
  'Liberation Serif': ['Times New Roman', 'Times'],
  'Liberation Mono': ['Courier New', 'Courier']
}

/** CJK：真实 family → Word 里的中文名（spike App.jsx:144-147；含 native 全角写法） */
const CJK_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'Noto Sans SC': [
    'Microsoft YaHei',
    '微软雅黑',
    'SimHei',
    '黑体',
    'DengXian',
    '等线',
    'Noto Sans SC'
  ],
  'Noto Serif SC': ['SimSun', '宋体', 'KaiTi', '楷体', 'FangSong', '仿宋', 'Noto Serif SC']
}

let pending: Promise<SurfaceFontStats> | null = null

/** 只注册一次（面内单实例）；失败不缓存，下次 doc:open 还能重试 */
export function ensureSurfaceFonts(): Promise<SurfaceFontStats> {
  if (pending === null) {
    pending = registerSurfaceFonts().catch((error: unknown) => {
      pending = null
      throw error
    })
  }
  return pending
}

/** dev（Vite serve）标记：模块级读一次；单测里不会执行到这里（fonts 被 mock） */
const DEV = import.meta.env.DEV

const devBytesCache = new Map<string, Promise<ArrayBuffer>>()

/**
 * dev 下字体资产的正确 URL：用 Vite 的 `?url` 静态导入（rollup 在构建态同样会处理，但这里只在 DEV 用）。
 * 为什么不能拼 `/node_modules/...`：Vite dev 对裸 `/node_modules` 请求给 SPA 兜底页（HTML），
 * 拿到 8KB 的 HTML 当字体（M3-S3 dev 真机验证踩过）；`?url` 导入会得到 `/@fs/...` 的真实文件 URL。
 */
const DEV_FONT_URLS: Readonly<Record<string, string>> = {
  ...import.meta.glob<string>('../../../../node_modules/@betteroffice/fonts/assets/*.{ttf,otf}', {
    eager: true,
    query: '?url',
    import: 'default'
  }),
  ...import.meta.glob<string>('../../../../node_modules/@betteroffice/fonts-cjk/assets/*.otf', {
    eager: true,
    query: '?url',
    import: 'default'
  })
}

function devFontUrl(face: BundledFontFace): string | undefined {
  const key = Object.keys(DEV_FONT_URLS).find((candidate) =>
    candidate.endsWith(`/assets/${face.file}`)
  )
  return key === undefined ? undefined : DEV_FONT_URLS[key]
}

/** dev 字节读取：与包内 validateByteLength 同口径（长度不对立刻报，不把兜底页当字体） */
function loadDevFontBytes(face: BundledFontFace): Promise<ArrayBuffer> {
  const key = face.file
  const cached = devBytesCache.get(key)
  if (cached !== undefined) return cached
  const promise = (async (): Promise<ArrayBuffer> => {
    const url = devFontUrl(face)
    if (url === undefined) {
      throw new Error(`dev 字体资产 URL 缺失：${face.file}（Vite ?url 映射里没有）`)
    }
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) {
      throw new Error(`Failed to fetch bundled font ${face.file}: HTTP ${response.status}`)
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength !== face.byteLength) {
      throw new Error(
        `Bundled font ${face.file} has ${bytes.byteLength} bytes; expected ${face.byteLength}`
      )
    }
    return bytes
  })()
  promise.catch(() => {
    if (devBytesCache.get(key) === promise) devBytesCache.delete(key)
  })
  devBytesCache.set(key, promise)
  return promise
}

/** dev 专用 provider：与 `@betteroffice/fonts` 的 createFontProvider 同形（解析函数直接用包导出的） */
const devFontProvider: BundledFontProvider = {
  resolve(family, bold, italic) {
    const face = resolveMetricCompatFace(family, bold, italic)
    return face === undefined ? undefined : () => loadDevFontBytes(face)
  },
  resolveFamily(family, bold, italic) {
    const face = resolveBundledFamilyFace(family, bold, italic)
    return face === undefined ? undefined : () => loadDevFontBytes(face)
  },
  resolveScriptFallback(script, bold, italic) {
    const face = resolveScriptFallbackFace(script, bold, italic)
    return face === undefined ? undefined : () => loadDevFontBytes(face)
  },
  resolveLastResort(family, bold, italic, office) {
    const face = resolveLastResortFace(family, bold, italic, office)
    return () => loadDevFontBytes(face)
  }
}

const devFontModule: BundledFontModule = {
  createFontProvider: () => devFontProvider
}

/** 面内注册全部字体别名 + 给 wasm 测量链装 provider；返回耗时/字节数证据 */
async function registerSurfaceFonts(): Promise<SurfaceFontStats> {
  const started = performance.now()
  // 离线口径：任何字体都不得走 Google Fonts（spike 同款；也是断网验收的一部分）
  setGoogleFontsEnabled(false)
  // 把字体字节 provider 交给 wasm 排版引擎（按 Word 字体名解析随包字体）
  configureDefaultFonts({ fonts: DEV ? devFontModule : fontsModule })

  const aliases: Readonly<Record<string, readonly string[]>> = {
    ...LATIN_ALIASES,
    ...CJK_ALIASES
  }
  const faces = BUNDLED_FONTS.filter((face) => aliases[face.family] !== undefined)
  let fetchedBytes = 0
  let registrations = 0

  for (const face of faces) {
    const bytes = DEV ? await loadDevFontBytes(face) : await loadBundledFontBytes(face)
    fetchedBytes += bytes.byteLength
    for (const alias of aliases[face.family] ?? []) {
      if (DEV) {
        // dev：包内 registerBundledFontFace 的资产解析同样会被预打包打坏，这里用同一份字节手动注册
        const fontFace = new FontFace(alias, bytes, {
          weight: String(face.weight),
          style: face.style
        })
        await fontFace.load()
        document.fonts.add(fontFace)
      } else {
        await registerBundledFontFace(face, alias)
      }
      registrations += 1
    }
  }

  return {
    faces: faces.length,
    registrations,
    fetchedBytes,
    fontSetSize: document.fonts.size,
    ms: Math.round((performance.now() - started) * 100) / 100,
    cjk: faces.some((face) => face.script !== undefined),
    devAssetUrls: DEV
  }
}

/** ---------------------------------------------------------------------------
 * M4-P：PPTX 编辑器字体面（6 条 / 5 唯一 face / 10,467,004 B，复用 docx 同一套随包字体字节）。
 *
 * 为什么单独一个加载器而不复用 `ensureSurfaceFonts`：
 *   - docx 是「document.fonts 注册 46 个别名」，pptx 的 `PptxEditor` 只要**字节数组**（`PptxFontFace[]`）；
 *   - pptx 只用到 3 个 family（Liberation Sans / Carlito / Noto Sans SC）→ 6 个条目、5 个唯一文件；
 *   - 仍走**同一套字节缓存**：构建态 `loadBundledFontBytes`（包内 bytesCache）、dev 态 `loadDevFontBytes`
 *     （devBytesCache），同一文档面内按 file 只读一次；Noto 两个别名共用同一 Uint8Array。
 *
 * 与上游 `@betteroffice/pptx` 的 `PptxFontFace { family; bold?; italic?; bytes }` **结构兼容**
 * （这里不 import 该包：依赖安装/构建期解耦，SurfaceBoot 直接把 `stats.fonts` 传给 PptxEditor）。
 * 失败/超时：整次 reject（清 pending 以便重试），**绝不返回空数组**给编辑器。
 * ------------------------------------------------------------------------- */

/** 与 `@betteroffice/pptx` 的 `PptxFontFace` 结构兼容的输入（不依赖该包的 import） */
export interface PptxFontFaceInput {
  family: string
  bold?: boolean
  italic?: boolean
  bytes: Uint8Array
}

/** pptx 字体加载结果（SurfaceBoot 用于挂 PptxEditor + 打点） */
export interface PptxFontsStats {
  fonts: readonly PptxFontFaceInput[]
  /** 条目数：6 */
  faces: number
  /** 唯一字节文件数：5 */
  uniqueFaces: number
  /** 唯一字节合计：10,467,004 */
  bytes: number
  ms: number
}

/** pptx 需要的 6 个 family 别名 → 随包字体面（源 family + 字重） */
const PPTX_FONT_ALIASES = [
  { sourceFamily: 'Liberation Sans', weight: 400, alias: 'Arial', bold: false },
  { sourceFamily: 'Liberation Sans', weight: 700, alias: 'Arial', bold: true },
  { sourceFamily: 'Carlito', weight: 400, alias: 'Calibri', bold: false },
  { sourceFamily: 'Carlito', weight: 700, alias: 'Calibri', bold: true },
  { sourceFamily: 'Noto Sans SC', weight: 400, alias: 'Microsoft YaHei', bold: false },
  { sourceFamily: 'Noto Sans SC', weight: 400, alias: 'Noto Sans SC', bold: false }
] as const

/** 单次加载上限：正常 6 面 ~0.3–2.5s（Noto 8.33MB 为主）；超时如实报错，不挂空字体编辑器 */
const PPTX_FONTS_TIMEOUT_MS = 20_000

function resolvePptxSourceFace(family: string, weight: number): BundledFontFace {
  const face = BUNDLED_FONTS.find(
    (candidate) =>
      candidate.family === family &&
      candidate.weight === weight &&
      candidate.style === 'normal' &&
      candidate.metricCompatWith !== undefined
  )
  if (face === undefined) {
    throw new Error(`pptx 字体面缺失：${family} ${weight}（随包字体清单里没有）`)
  }
  return face
}

let pptxPending: Promise<PptxFontsStats> | null = null

/**
 * 加载 pptx 编辑器需要的 6 条字体面（5 个唯一文件，≈10.47MB）。
 *
 * SurfaceBoot 的调用方式（`doc.kind === 'pptx'` 时，挂 PptxEditorPane 之前）：
 * ```ts
 * const stats = await loadPptxFonts()   // 失败/超时 → catch 后进错误态，可重试；不要空数组挂编辑器
 * setPptxFonts(stats.fonts)
 * setPptxFontStats(stats)               // { faces:6, uniqueFaces:5, bytes:10467004, ms }
 * ```
 * 同一文档面内重复调用返回同一个 Promise/结果（成功缓存；失败清缓存可重试）。
 */
export function loadPptxFonts(): Promise<PptxFontsStats> {
  if (pptxPending !== null) return pptxPending
  const promise = loadPptxFontsInner().catch((error: unknown) => {
    pptxPending = null
    throw error
  })
  pptxPending = promise
  return promise
}

async function loadPptxFontsInner(): Promise<PptxFontsStats> {
  const started = performance.now()
  let timer: number | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`pptx 本地字体加载超时（${PPTX_FONTS_TIMEOUT_MS}ms）`))
    }, PPTX_FONTS_TIMEOUT_MS)
  })

  const load = async (): Promise<PptxFontsStats> => {
    const bytesByFile = new Map<string, Promise<Uint8Array>>()
    /** 同一 face 文件只读一次（成功/失败都按 file 归一；失败由底层缓存清理，重试会重读） */
    const bytesOf = (face: BundledFontFace): Promise<Uint8Array> => {
      const cached = bytesByFile.get(face.file)
      if (cached !== undefined) return cached
      const promise = (DEV ? loadDevFontBytes(face) : loadBundledFontBytes(face)).then((buffer) => {
        if (buffer.byteLength !== face.byteLength) {
          throw new Error(
            `pptx 字体字节长度不符：${face.file} ${buffer.byteLength}≠${face.byteLength}`
          )
        }
        return new Uint8Array(buffer)
      })
      bytesByFile.set(face.file, promise)
      return promise
    }

    const fonts = await Promise.all(
      PPTX_FONT_ALIASES.map(async (spec) => {
        const face = resolvePptxSourceFace(spec.sourceFamily, spec.weight)
        const bytes = await bytesOf(face)
        return {
          family: spec.alias,
          bold: spec.bold,
          italic: false,
          bytes
        } satisfies PptxFontFaceInput
      })
    )
    const uniqueBytes = [...bytesByFile.keys()].reduce(
      (total, file) => total + (BUNDLED_FONTS.find((face) => face.file === file)?.byteLength ?? 0),
      0
    )
    return {
      fonts,
      faces: fonts.length,
      uniqueFaces: bytesByFile.size,
      bytes: uniqueBytes,
      ms: Math.round((performance.now() - started) * 100) / 100
    }
  }

  try {
    return await Promise.race([load(), timeout])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}
