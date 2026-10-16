import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plugin } from 'vite'
import {
  createPdfjsInlineAssetsPlugin,
  PDFJS_ASSETS_MANIFEST_ID,
  PDFJS_ASSETS_PLUGIN_NAME
} from '../pdfjs-inline-assets-plugin'

/**
 * 构建期资源内联：这里验的是"插件对着**真的** node_modules/pdfjs-dist 干了什么"——
 * 只读那两个目录、只收要用的扩展名、字节逐字节一致、名字不认识就不认（含 `../` 这种）。
 * 这是"资源真进了构建"唯一能在测试里问到证据的地方（消费侧那支的虚拟模块在单测里是替身）。
 */

/** pdfjs-dist 的包根：与 `electron.vite.config.ts` 里传给插件的是同一条路径。 */
const PDFJS_ROOT = resolve('node_modules/pdfjs-dist')
const CMAPS_DIR = join(PDFJS_ROOT, 'cmaps')
const FONTS_DIR = join(PDFJS_ROOT, 'standard_fonts')
const RESOLVED_MANIFEST_ID = `\0${PDFJS_ASSETS_MANIFEST_ID}`

/** Rollup 的插件上下文替身：`load` 里会 `this.addWatchFile(...)`，直调 hook 时得给一个。 */
const HOOK_CONTEXT = { addWatchFile: (): void => undefined }

function resolveIdOf(instance: Plugin, id: string): string | null {
  const hook = instance.resolveId as unknown as (id: string, importer?: string) => string | null
  return hook.call(HOOK_CONTEXT, id)
}

function loadOf(instance: Plugin, id: string): string | null {
  const hook = instance.load as unknown as (id: string) => string | null
  return hook.call(HOOK_CONTEXT, id)
}

/** 只认这些扩展名（`LICENSE_FOXIT` 之类不是资源，不该被内联）。 */
function namesIn(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir)
    .filter((name) => extensions.some((extension) => name.toLowerCase().endsWith(extension)))
    .sort()
}

/** 最小的那个 bcmap（测试里只解码一个文件就够，别把 169 个都读一遍）。 */
function smallestCmap(): string {
  const names = namesIn(CMAPS_DIR, ['.bcmap'])
  return names.reduce((best, name) =>
    statSync(join(CMAPS_DIR, name)).size < statSync(join(CMAPS_DIR, best)).size ? name : best
  )
}

const created: string[] = []

/** 造一个"只有这几样"的 fixture 根（mkdtemp 独有目录，用例结束自己清）。 */
function fixtureRoot(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'kyclaw-pdfjs-assets-'))
  created.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('createPdfjsInlineAssetsPlugin：对着真的 pdfjs-dist 资源', () => {
  const plugin = createPdfjsInlineAssetsPlugin({ root: PDFJS_ROOT })

  it('插件名与清单 id 稳定（配置里装的就是这一个）', () => {
    expect(plugin.name).toBe(PDFJS_ASSETS_PLUGIN_NAME)
    expect(PDFJS_ASSETS_MANIFEST_ID).toBe('virtual:kyclaw-pdfjs-assets')
    expect(resolveIdOf(plugin, PDFJS_ASSETS_MANIFEST_ID)).toBe(RESOLVED_MANIFEST_ID)
  })

  it('只认自己那两个虚拟模块（清单 + 索引里有的文件）', () => {
    const cmap = smallestCmap()

    expect(resolveIdOf(plugin, `${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/${cmap}`)).toContain(cmap)
    // 不在索引里的名字一律不认（含 `../` 这种想爬出去的写法）
    expect(resolveIdOf(plugin, `${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/查无此表.bcmap`)).toBeNull()
    expect(resolveIdOf(plugin, `${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/../package.json`)).toBeNull()
    expect(resolveIdOf(plugin, '随便别的模块')).toBeNull()
  })

  it('清单代码：两张表、名字逐个都在（LICENSE 之类不在），且不把字节塞进清单', () => {
    const source = loadOf(plugin, RESOLVED_MANIFEST_ID)
    expect(typeof source).toBe('string')

    const cmaps = namesIn(CMAPS_DIR, ['.bcmap'])
    const fonts = namesIn(FONTS_DIR, ['.ttf', '.pfb'])
    expect(cmaps.length).toBeGreaterThan(100)
    expect(fonts.length).toBeGreaterThan(5)

    expect(source).toContain('export const CMAP_FILES')
    expect(source).toContain('export const FONT_FILES')
    for (const name of [...cmaps, ...fonts]) {
      expect(source).toContain(JSON.stringify(name))
    }
    for (const name of readdirSync(FONTS_DIR).filter((entry) => entry.startsWith('LICENSE'))) {
      expect(source).not.toContain(JSON.stringify(name))
    }
    // 每个条目都是"懒加载器"（动态 import），不是把字节塞进清单；
    // 而且**必须把默认导出的字符串解出来**：消费侧约定"加载器直接给 base64 字符串"，
    // 光 `import()` 拿到的是模块命名空间（`{ default }`）—— 这条不钉住就是打包后才炸的坑。
    expect(source).toContain('() => import(')
    expect(source).toContain('.then((mod) => mod.default)')
    expect(source).not.toContain('base64')
  })

  it('单个资源：base64 解码后与磁盘上的字节逐字节一致', () => {
    const name = smallestCmap()
    const resolved = resolveIdOf(plugin, `${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/${name}`) as string
    const code = loadOf(plugin, resolved) as string

    expect(code.startsWith('export default "')).toBe(true)
    const base64 = JSON.parse(code.slice('export default '.length)) as string
    const decoded = Buffer.from(base64, 'base64')
    const original = readFileSync(join(CMAPS_DIR, name))
    expect(decoded.equals(original)).toBe(true)
    expect(decoded.byteLength).toBe(original.byteLength)
  })

  it('不认识的名字：load 给 null（不会凭空编一个模块出来）', () => {
    expect(loadOf(plugin, `\0${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/查无此表.bcmap`)).toBeNull()
    expect(loadOf(plugin, '随便别的模块')).toBeNull()
  })
})

describe('createPdfjsInlineAssetsPlugin：有界读取与护栏', () => {
  it('目录不在（pdfjs-dist 没装）：直接抛，带清楚的那条路径', () => {
    expect(() => createPdfjsInlineAssetsPlugin({ root: fixtureRoot({}) })).toThrow(/cmaps/)
  })

  it('单文件超上限：抛错点名（不悄悄内联一个巨物）', () => {
    const root = fixtureRoot({
      'cmaps/小.bcmap': Buffer.alloc(4),
      'cmaps/大.bcmap': Buffer.alloc(64),
      'standard_fonts/x.ttf': Buffer.alloc(4)
    })

    expect(() => createPdfjsInlineAssetsPlugin({ root, maxAssetBytes: 16 })).toThrow(/单文件上限/)
  })

  it('总量超上限：抛错点名', () => {
    const root = fixtureRoot({
      'cmaps/a.bcmap': Buffer.alloc(20),
      'cmaps/b.bcmap': Buffer.alloc(20),
      'standard_fonts/x.ttf': Buffer.alloc(20)
    })

    expect(() =>
      createPdfjsInlineAssetsPlugin({ root, maxAssetBytes: 32, maxTotalBytes: 40 })
    ).toThrow(/总量超过上限/)
  })

  it('只收要用的扩展名：LICENSE 与别的文件不进表；一个都没有也不静默', () => {
    const root = fixtureRoot({
      'cmaps/a.bcmap': Buffer.from([1, 2, 3]),
      'cmaps/说明.txt': 'not a cmap',
      'standard_fonts/x.ttf': Buffer.from([4, 5, 6]),
      'standard_fonts/LICENSE_X': 'license text'
    })
    const plugin = createPdfjsInlineAssetsPlugin({ root })
    const source = loadOf(plugin, RESOLVED_MANIFEST_ID) as string

    expect(source).toContain('"a.bcmap"')
    expect(source).toContain('"x.ttf"')
    expect(source).not.toContain('说明.txt')
    expect(source).not.toContain('LICENSE_X')

    expect(() =>
      createPdfjsInlineAssetsPlugin({ root: fixtureRoot({ 'cmaps/说明.txt': 'x' }) })
    ).toThrow(/没有可内联的文件/)
  })

  it('fixture 也能走完整条（解析 → 加载 → 字节一致）', () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80])
    const root = fixtureRoot({ 'cmaps/a.bcmap': bytes, 'standard_fonts/x.ttf': Buffer.alloc(2) })
    const plugin = createPdfjsInlineAssetsPlugin({ root })
    const resolved = resolveIdOf(plugin, `${PDFJS_ASSETS_MANIFEST_ID}/file/cmaps/a.bcmap`) as string
    const code = loadOf(plugin, resolved) as string
    const base64 = JSON.parse(code.slice('export default '.length)) as string

    expect(Buffer.from(base64, 'base64').equals(bytes)).toBe(true)
  })
})
