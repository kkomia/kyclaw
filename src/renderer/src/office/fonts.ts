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
