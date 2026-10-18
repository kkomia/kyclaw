/**
 * M4-P · pptx 字体加载器单测（vitest / jsdom）。
 *
 * 覆盖：
 *   1. 6 条面清单 / 5 唯一 face / 10,467,004 B / Noto 两别名共享同一 Uint8Array；
 *   2. 缓存命中：同一文档面内重复调用不重复读字节（fetch 只 5 次）；
 *   3. 失败路径：加载 reject 且清缓存，恢复后可重试成功（不返回空数组）。
 *
 * 说明：dev 分支（`import.meta.env.DEV === true`）走 `loadDevFontBytes` → 本测试 mock fetch；
 * 构建态分支由真机 probe/构建态冒烟覆盖（`loadBundledFontBytes` 走包内 bytesCache）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const FACES = vi.hoisted(() => [
  {
    family: 'Liberation Sans',
    metricCompatWith: 'Arial',
    weight: 400,
    style: 'normal',
    file: 'LiberationSans-Regular.ttf',
    byteLength: 410712
  },
  {
    family: 'Liberation Sans',
    metricCompatWith: 'Arial',
    weight: 700,
    style: 'normal',
    file: 'LiberationSans-Bold.ttf',
    byteLength: 414456
  },
  {
    family: 'Carlito',
    metricCompatWith: 'Calibri',
    weight: 400,
    style: 'normal',
    file: 'Carlito-Regular.ttf',
    byteLength: 628032
  },
  {
    family: 'Carlito',
    metricCompatWith: 'Calibri',
    weight: 700,
    style: 'normal',
    file: 'Carlito-Bold.ttf',
    byteLength: 682468
  },
  {
    family: 'Noto Sans SC',
    metricCompatWith: 'Microsoft YaHei',
    weight: 400,
    style: 'normal',
    file: 'NotoSansSC-Regular.otf',
    byteLength: 8331336
  }
])

const EXPECTED_BYTES = 410712 + 414456 + 628032 + 682468 + 8331336

vi.mock('@betteroffice/docx', () => ({ setGoogleFontsEnabled: vi.fn() }))
vi.mock('@betteroffice/docx/layout', () => ({ configureDefaultFonts: vi.fn() }))
vi.mock('@betteroffice/fonts', () => ({
  BUNDLED_FONTS: FACES,
  loadBundledFontBytes: vi.fn(),
  registerBundledFontFace: vi.fn(),
  resolveBundledFamilyFace: vi.fn(),
  resolveLastResortFace: vi.fn(),
  resolveMetricCompatFace: vi.fn(),
  resolveScriptFallbackFace: vi.fn()
}))

/** dev 分支的 fetch：按 URL 末尾文件名返回对应长度的 ArrayBuffer（内容不重要） */
function installFetchSuccess(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    const face = FACES.find((candidate) => url.includes(candidate.file))
    if (face === undefined) throw new Error(`测试 fetch 未匹配字体：${url}`)
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(face.byteLength)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('loadPptxFonts：pptx 6 面清单与字节', () => {
  it('6 条别名 / 5 唯一 face / 10,467,004 B；Noto 两别名共享同一份字节', async () => {
    const fetchMock = installFetchSuccess()
    const { loadPptxFonts } = await import('../fonts')
    const stats = await loadPptxFonts()

    expect(stats.faces).toBe(6)
    expect(stats.uniqueFaces).toBe(5)
    expect(stats.bytes).toBe(EXPECTED_BYTES)
    expect(stats.ms).toBeGreaterThanOrEqual(0)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    const aliases = stats.fonts.map(
      (font) => `${font.family}:${font.bold === true ? 'bold' : 'regular'}`
    )
    expect(aliases).toEqual([
      'Arial:regular',
      'Arial:bold',
      'Calibri:regular',
      'Calibri:bold',
      'Microsoft YaHei:regular',
      'Noto Sans SC:regular'
    ])
    expect(stats.fonts.map((font) => font.bytes.byteLength)).toEqual([
      410712, 414456, 628032, 682468, 8331336, 8331336
    ])
    // Noto 的两个别名必须复用同一 Uint8Array（不重复读 8.33MB）
    expect(stats.fonts[4]?.bytes).toBe(stats.fonts[5]?.bytes)
    expect(stats.fonts.every((font) => font.italic === false)).toBe(true)
  })

  it('缓存命中：同一面内第二次调用复用同一结果，不再读字节', async () => {
    const fetchMock = installFetchSuccess()
    const { loadPptxFonts } = await import('../fonts')
    const first = await loadPptxFonts()
    const second = await loadPptxFonts()

    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})

describe('loadPptxFonts：失败路径与重试', () => {
  it('读字节失败 → reject（不返回空数组）；恢复后重试成功', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', failingFetch)
    const { loadPptxFonts } = await import('../fonts')

    await expect(loadPptxFonts()).rejects.toThrow(/network down|pptx/i)

    // 失败不缓存：换可用 fetch 后重试应成功（且字节读取重新进行）
    const okFetch = installFetchSuccess()
    const stats = await loadPptxFonts()
    expect(stats.faces).toBe(6)
    expect(stats.bytes).toBe(EXPECTED_BYTES)
    expect(okFetch).toHaveBeenCalledTimes(5)
  })
})
