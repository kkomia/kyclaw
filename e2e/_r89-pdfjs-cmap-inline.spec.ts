import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp } from './harness'

/**
 * R89 探针：**pdf.js 的本地资源（中文 CMap / 标准字体）在 file:// 运行时的内联链路**。
 *
 * 门槛是"要 `pnpm build` 的产物"（`out/renderer/assets`）：默认 skip，开关见下。
 * 它验四件事，缺一不可：
 *   1. 起的是**真 Electron + 真 file://**（`location.protocol === 'file:'`）——不是 dev server；
 *   2. 构建期那份清单分块**能在 file:// 下 import**，并且里面的中文 CMap（`UniGB-UCS2-H.bcmap`）
 *      解出来的字节与 `node_modules/pdfjs-dist` 的源文件**逐字节一致**（长度 + 校验和）；
 *   3. **pdf.js 真用它**：拿应用自己那份 pdfjs 分块 + 应用自己那份清单分块，画一份"没有内嵌字体、
 *      只声明 UniGB-UCS2-H 的中文 PDF"——断言 pdf.js 确实向 `BinaryDataFactory` 要了
 *      `cMapUrl: UniGB-UCS2-H.bcmap`，并且抽出来的文字是「中文」（说明 CMap 数据被解析并用上了）；
 *   4. 整段过程**没有任何** `.bcmap/.ttf/.pfb` 网络请求（这就是"内联"与"运行时 fetch"的分界）。
 *
 * 诚实边界（别把它读大）：第 3 步的 `BinaryDataFactory` 是**探针按同一约定现场拼的**
 * （清单 → 懒分块 → 字节），不是应用里那个 `LocalPdfBinaryDataFactory` 本身；它证明的是
 * "这份清单分块的字节在 file:// 下能满足 pdf.js 的 CMap 请求"。生产那份工厂的行为由
 * `dsh-document/__tests__/pdf-assets.spec.ts` 覆盖（同一张表、同一套解码）。
 *
 * 跑法（先 `pnpm build`）：
 *   KYCLAW_R89_PDFJS=1 node_modules/.bin/playwright test e2e/_r89-pdfjs-cmap-inline.spec.ts
 */
const ENABLED = process.env.KYCLAW_R89_PDFJS === '1'
const repoRoot = resolve(__dirname, '..')
const assetsDir = join(repoRoot, 'out', 'renderer', 'assets')
const evidenceDir = join(repoRoot, '.superpowers', 'pdfjs-cmap-inline')

/** 一个够用的完整性校验（比只比长度硬，且不必进 crypto）。 */
function checksum(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${bytes.byteLength}:${hash.toString(16)}`
}

function assetsNamed(prefix: string, suffix: string): string[] {
  return readdirSync(assetsDir).filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
}

/**
 * 造一份**没有内嵌字体**的中文 PDF：Type0 + 预定义 CMap `UniGB-UCS2-H` + 无 `FontFile*`。
 * 这正是"不给本地 CMap 就整页画不出来"的那一类文档；文字是「中文」（U+4E2D U+6587）。
 */
function syntheticCjkPdf(): Buffer {
  const content = 'BT /F1 24 Tf 12 40 Td <4E2D6587> Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /UniGB-UCS2-H ' +
      '/DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /SimSun ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> ' +
      '/FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /SimSun /Flags 4 /FontBBox [0 -200 1000 900] ' +
      '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>'
  ]
  let body = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = body.length
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(
    xrefOffset
  )}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

test.describe('R89 · pdf.js 本地资源内联（构建产物 + file:// 运行时）', () => {
  test.skip(!ENABLED, 'KYCLAW_R89_PDFJS=1 才跑（需先 pnpm build）')

  test('file:// 下：清单分块可 import、中文 CMap 字节一致、pdf.js 真用它、零字体请求', async () => {
    const manifestCandidates = assetsNamed('pdf-assets-bundled-', '.js')
    // `pdf-<hash>.js` 是 pdfjs 自己那块；别把清单块（也是 pdf- 开头）和 `pdf_viewer-*` 混进来
    const pdfjsCandidates = assetsNamed('pdf-', '.js').filter(
      (name) => !name.startsWith('pdf-assets-bundled-')
    )
    const workerCandidates = assetsNamed('pdf.worker.min-', '.mjs')
    expect(manifestCandidates).toHaveLength(1)
    expect(pdfjsCandidates).toHaveLength(1)
    expect(workerCandidates).toHaveLength(1)

    const cmapSource = readFileSync(
      join(repoRoot, 'node_modules', 'pdfjs-dist', 'cmaps', 'UniGB-UCS2-H.bcmap')
    )
    const expectedBytes = cmapSource.byteLength
    const expectedChecksum = checksum(new Uint8Array(cmapSource))
    const pdfBase64 = syntheticCjkPdf().toString('base64')

    const launched = await launchApp()
    const requests: string[] = []
    launched.page.on('request', (request) => requests.push(request.url()))
    try {
      const result = await launched.page.evaluate(
        async (args): Promise<Record<string, unknown>> => {
          const decode = (base64: string): Uint8Array =>
            Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
          const checksumOf = (bytes: Uint8Array): string => {
            let hash = 0x811c9dc5
            for (const byte of bytes) {
              hash ^= byte
              hash = Math.imul(hash, 0x01000193) >>> 0
            }
            return `${bytes.byteLength}:${hash.toString(16)}`
          }

          // ① 清单分块：优先用它导出的 `pdfAssetTables()`（值是 Map，要先摊平成记录）；
          //    没有那个导出就按"哪张表的键是 .bcmap / 字体后缀"认，不依赖压缩后的名字
          const manifest: Record<string, unknown> = await import(args.manifestUrl)
          const buildTables = manifest['pdfAssetTables']
          const asRecord = (value: unknown): Record<string, () => Promise<string>> | null => {
            if (value instanceof Map) {
              return Object.fromEntries(value as Map<string, () => Promise<string>>) as Record<
                string,
                () => Promise<string>
              >
            }
            if (typeof value === 'object' && value !== null) {
              return value as Record<string, () => Promise<string>>
            }
            return null
          }
          const rawTables =
            typeof buildTables === 'function'
              ? Object.values((buildTables as () => Record<string, unknown>)())
              : Object.values(manifest)
          const tables = rawTables
            .map(asRecord)
            .filter((table): table is Record<string, () => Promise<string>> => table !== null)
          const cmapTable = tables.find((table) =>
            Object.keys(table).some((key) => key.endsWith('.bcmap'))
          )
          const fontTable = tables.find((table) =>
            Object.keys(table).some((key) => /\.(ttf|pfb)$/.test(key))
          )
          if (cmapTable === undefined) {
            throw new Error(
              `清单里没有 CMap 表（导出的键：${Object.keys(manifest).join(',')}；` +
                `值类型：${Object.values(manifest)
                  .map((value) => typeof value)
                  .join(',')}；表数：${String(tables.length)}）`
            )
          }

          const cmapBytes = decode(await cmapTable['UniGB-UCS2-H.bcmap']())
          const fontName = fontTable === undefined ? null : (Object.keys(fontTable)[0] ?? null)
          const fontBytes =
            fontTable === undefined || fontName === null
              ? null
              : decode(await fontTable[fontName]()).byteLength

          // ② 应用自己那份 pdfjs 分块 + 现场拼一个"清单 → 懒分块 → 字节"的工厂
          const pdfjs: {
            GlobalWorkerOptions: { workerSrc: string }
            getDocument: (init: Record<string, unknown>) => { promise: Promise<unknown> }
          } = await import(args.pdfjsUrl)
          pdfjs.GlobalWorkerOptions.workerSrc = args.workerUrl
          const asked: string[] = []
          const loadBytes = async (
            table: Record<string, () => Promise<string>>,
            name: string
          ): Promise<Uint8Array> => {
            const load = table[name]
            if (load === undefined) throw new Error(`清单里没有 ${name}`)
            return decode(await load())
          }
          class ProbeFactory {
            async fetch(request: { kind: string; filename: string }): Promise<Uint8Array> {
              asked.push(`${request.kind}:${request.filename}`)
              if (request.kind === 'cMapUrl') return loadBytes(cmapTable as never, request.filename)
              if (request.kind === 'standardFontDataUrl' && fontTable !== undefined) {
                return loadBytes(fontTable, request.filename)
              }
              throw new Error(`探针没准备这一类：${request.kind}`)
            }
          }

          // 别把这个变量叫 `document`：那会遮蔽 DOM 的 document（画布就建不出来了）
          const pdfDocument = (await pdfjs.getDocument({
            data: decode(args.pdfBase64),
            useWorkerFetch: false,
            cMapPacked: true,
            stopAtErrors: false,
            enableXfa: false,
            BinaryDataFactory: ProbeFactory
          }).promise) as {
            getPage: (page: number) => Promise<{
              getViewport: (options: { scale: number }) => {
                width: number
                height: number
              }
              getTextContent: () => Promise<{ items: { str?: string }[] }>
              render: (options: { canvas: HTMLCanvasElement; viewport: unknown }) => {
                promise: Promise<void>
              }
            }>
          }

          const page = await pdfDocument.getPage(1)
          const text = (await page.getTextContent()).items.map((item) => item.str ?? '').join('')
          const viewport = page.getViewport({ scale: 2 })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          await page.render({ canvas, viewport }).promise
          const context = canvas.getContext('2d')
          let inkedPixels = 0
          if (context !== null) {
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
            for (let index = 0; index < pixels.length; index += 4) {
              if (pixels[index + 3] > 0 && pixels[index] < 250) inkedPixels += 1
            }
          }

          return {
            protocol: location.protocol,
            href: location.href,
            cmapNames: Object.keys(cmapTable).length,
            fontNames: fontTable === undefined ? 0 : Object.keys(fontTable).length,
            cmapBytes: cmapBytes.byteLength,
            cmapChecksum: checksumOf(cmapBytes),
            fontSampleBytes: fontBytes,
            asked,
            text,
            inkedPixels,
            png: canvas.toDataURL('image/png')
          }
        },
        {
          manifestUrl: `./assets/${manifestCandidates[0] ?? ''}`,
          pdfjsUrl: `./assets/${pdfjsCandidates[0] ?? ''}`,
          workerUrl: `./assets/${workerCandidates[0] ?? ''}`,
          pdfBase64
        }
      )

      // 证据落盘（本地，不入库）
      mkdirSync(evidenceDir, { recursive: true })
      const png = String(result['png'] ?? '')
      writeFileSync(
        join(evidenceDir, 'cjk-page.png'),
        Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64')
      )
      writeFileSync(
        join(evidenceDir, 'evidence.json'),
        `${JSON.stringify({ ...result, png: undefined, requests: requests.length }, null, 2)}\n`,
        'utf8'
      )

      // ① 真 file://
      expect(result['protocol']).toBe('file:')

      // ② 中文 CMap 的字节与研究源件逐字节一致（长度 + 校验和）
      expect(result['cmapBytes']).toBe(expectedBytes)
      expect(result['cmapChecksum']).toBe(expectedChecksum)
      expect(result['cmapNames']).toBeGreaterThan(100)
      expect(result['fontNames']).toBeGreaterThan(5)

      // ③ pdf.js 真要了这份 CMap，并且把「中文」抽了出来
      expect(result['asked']).toContain('cMapUrl:UniGB-UCS2-H.bcmap')
      expect(String(result['text'])).toContain('中文')

      // ④ 一条字体 / CMap 的网络请求都没有（内联的分界）
      const fontRequests = requests.filter((url) => /\.(bcmap|ttf|pfb)(\?|$)/i.test(url))
      expect(fontRequests).toEqual([])

      console.log(
        JSON.stringify(
          {
            protocol: result['protocol'],
            cmapBytes: result['cmapBytes'],
            cmapChecksum: result['cmapChecksum'],
            asked: result['asked'],
            text: result['text'],
            inkedPixels: result['inkedPixels'],
            requests: requests.length,
            fontRequests: fontRequests.length
          },
          null,
          1
        )
      )
    } finally {
      await closeApp(launched)
    }
  })
})
