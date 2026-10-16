import { describe, expect, it } from 'vitest'
import {
  localPdfAssets,
  type PdfAssetTable,
  type PdfAssetTables,
  type PdfBinaryDataFactory,
  type PdfBinaryDataFactoryConstructor
} from '../pdf-assets'

/**
 * 这一层是"表 → pdf.js 的回答"：解码、按名字取、不认识就报清楚。
 * **表是可注入的**，所以这里不需要构建期虚拟模块（真的那份由 `pdfjs-inline-assets-plugin.spec.ts`
 * 对着磁盘验：字节逐字节一致、只收要用的扩展名）。
 */

/** 一份 base64（故意带上 ≥0x80 的字节：验二进制不被当文本处理）。 */
const base64Of = (values: readonly number[]): string =>
  Buffer.from(Uint8Array.from(values)).toString('base64')

const CMAP_BYTES = [0x25, 0xbb, 0x80, 0xff, 0x00, 0x41]
const FONT_BYTES = [0x00, 0x01, 0x00, 0x00, 0xfe]

/** 一份假表（真表由构建期插件生成，见 pdfjs-inline-assets-plugin.spec.ts）。 */
function fakeTables(): PdfAssetTables {
  const cmap: PdfAssetTable = new Map([
    ['Adobe-Japan1-0.bcmap', async () => base64Of(CMAP_BYTES)],
    ['UniGB-UCS2-H.bcmap', async () => base64Of([1, 2, 3])]
  ])
  const font: PdfAssetTable = new Map([
    ['LiberationSans-Regular.ttf', async () => base64Of(FONT_BYTES)]
  ])
  return { cMapUrl: cmap, standardFontDataUrl: font }
}

/** `localPdfAssets(...)` 里那个工厂：**构造器**（pdf.js 会 `new` 它），这里也照它那样起一个。 */
function factoryOf(assets: {
  BinaryDataFactory?: PdfBinaryDataFactoryConstructor
}): PdfBinaryDataFactory {
  const Factory = assets.BinaryDataFactory
  if (Factory === undefined) throw new Error('资源包里没有工厂')
  return new Factory()
}

/** 取字节的便捷壳（顺带断言取出的是"加载器"而不是已经解好的字节）。 */
async function fetchBytes(
  factory: PdfBinaryDataFactory,
  kind: 'cMapUrl' | 'standardFontDataUrl',
  filename: string
): Promise<number[]> {
  return [...(await factory.fetch({ kind, filename }))]
}

describe('localPdfAssets：资源包本身', () => {
  it('带上打包标记与那个工厂；装它的时候**不去碰表**（表是第一次被问到时才取）', async () => {
    let reads = 0
    const assets = localPdfAssets(async () => {
      reads += 1
      return fakeTables()
    })

    expect(assets.cMapPacked).toBe(true)
    expect(typeof assets.BinaryDataFactory).toBe('function') // 是构造器，不是实例（给实例 pdf.js 会炸）
    expect(typeof factoryOf(assets).fetch).toBe('function')
    expect(reads).toBe(0)
  })
})

describe('本地资源工厂：worker 要什么就给什么', () => {
  it('CMap：按文件名取到分块，base64 解回原始字节（含 ≥0x80 的字节）', async () => {
    const factory = factoryOf(localPdfAssets(async () => fakeTables()))

    expect(await fetchBytes(factory, 'cMapUrl', 'Adobe-Japan1-0.bcmap')).toEqual(CMAP_BYTES)
    expect(await fetchBytes(factory, 'cMapUrl', 'UniGB-UCS2-H.bcmap')).toEqual([1, 2, 3])
  })

  it('标准字体：同一条路（Symbol / ZapfDingbats 那两个要它）', async () => {
    const factory = factoryOf(localPdfAssets(async () => fakeTables()))

    expect(await fetchBytes(factory, 'standardFontDataUrl', 'LiberationSans-Regular.ttf')).toEqual(
      FONT_BYTES
    )
  })

  it('表里没有的文件名：报清楚是哪个（不静默给空数据）', async () => {
    const factory = factoryOf(localPdfAssets(async () => fakeTables()))

    await expect(factory.fetch({ kind: 'cMapUrl', filename: '查无此表.bcmap' })).rejects.toThrow(
      '查无此表.bcmap'
    )
    await expect(
      factory.fetch({ kind: 'standardFontDataUrl', filename: 'ComicSans.ttf' })
    ).rejects.toThrow('ComicSans.ttf')
  })

  it('不认识的类别（wasm 之类）：报错，不去猜，也不白取表', async () => {
    let reads = 0
    const factory = factoryOf(
      localPdfAssets(async () => {
        reads += 1
        return fakeTables()
      })
    )

    await expect(factory.fetch({ kind: 'wasmUrl', filename: 'x.wasm' })).rejects.toThrow('wasmUrl')
    expect(reads).toBe(0)
  })

  it('取表只取一次：同一个工厂反复被问不会重复 import 清单', async () => {
    let reads = 0
    const factory = factoryOf(
      localPdfAssets(async () => {
        reads += 1
        return fakeTables()
      })
    )

    await fetchBytes(factory, 'cMapUrl', 'UniGB-UCS2-H.bcmap')
    await fetchBytes(factory, 'cMapUrl', 'UniGB-UCS2-H.bcmap')
    await fetchBytes(factory, 'standardFontDataUrl', 'LiberationSans-Regular.ttf')

    expect(reads).toBe(1)
  })

  it('表取不到（清单模块坏了）：失败往上抛，不假装有资源', async () => {
    const factory = factoryOf(
      localPdfAssets(async () => {
        throw new Error('清单分块加载失败')
      })
    )

    await expect(
      factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' })
    ).rejects.toThrow('清单分块加载失败')
  })
})

describe('base64 解码：二进制安全', () => {
  it('全零 / 全 0xff / 含 NUL 的字节都原样（`atob` 出来的串逐字节搬）', async () => {
    const zeros = [0, 0, 0]
    const high = [0xff, 0xff, 0x00, 0x80]
    const factory = factoryOf(
      localPdfAssets(async () => ({
        cMapUrl: new Map([
          ['zeros.bcmap', async () => base64Of(zeros)],
          ['high.bcmap', async () => base64Of(high)]
        ]),
        standardFontDataUrl: new Map()
      }))
    )

    expect(await fetchBytes(factory, 'cMapUrl', 'zeros.bcmap')).toEqual(zeros)
    expect(await fetchBytes(factory, 'cMapUrl', 'high.bcmap')).toEqual(high)
  })
})
