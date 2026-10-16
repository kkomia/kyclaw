/**
 * XLSX 的预整理：只读地在内存里复刻一份"去掉 DrawingML"的包，并顺手点出认出来但不显示的内容。
 * 源字节与工作表 XML **一个字节都不改**。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/xlsx-archive.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 */
import { unzipSync, zipSync } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import type { ExcelUnsupportedFeature } from './model'

/** 预整理出来的包副本 + 认出的"不显示内容" */
export class XlsxPreviewArchive {
  /** 认出来但预览不显示的内容 */
  readonly unsupportedFeatures = new Set<ExcelUnsupportedFeature>()
  private readonly files: Record<string, Uint8Array>
  private readonly parts = new Map<string, Uint8Array>()

  /**
   * 读一个包（**不动借来的源字节**）。
   * @param bytes 完整 XLSX 源字节
   * @throws 包内存在"ASCII 大小写等价"的重名部件时抛错（OPC 口径下这是同一份部件）
   */
  constructor(private readonly bytes: Uint8Array) {
    this.files = unzipSync(bytes) as Record<string, Uint8Array>
    for (const [path, content] of Object.entries(this.files)) {
      if (path.endsWith('/')) continue
      const key = partKey(path)
      if (this.parts.has(key)) throw new Error(`Ambiguous XLSX part: ${path}`)
      this.parts.set(key, content)
    }
  }

  /**
   * 交给 ExcelJS 之前先把 DrawingML 部件摘掉；调用方**还要**同时忽略工作表的 drawing 引用。
   * @returns 没摘任何东西时原样回源字节，否则回一份不压缩的临时 ZIP
   */
  withoutDrawings(): Uint8Array {
    const entries = Object.entries(this.files)
    const omitted = new Set<string>()
    for (const [path, part] of entries) {
      // ExcelJS 还会按约定目录发现没人引用的 drawings。
      if (/^xl\/drawings\/(?:[^/]+\.xml|_rels\/[^/]+\.xml\.rels)$/i.test(path)) {
        omitted.add(partKey(path))
      }
      const match = /^(.*\/)?_rels\/([^/]+)\.rels$/i.exec(path)
      if (match === null) continue
      const owner = `${match[1] ?? ''}${match[2]}`
      new XMLParser({
        removeNSPrefix: true,
        ignoreAttributes: false,
        attributeNamePrefix: '',
        parseAttributeValue: false,
        updateTag: (tag, _path, attributes: Record<string, string>) => {
          const type =
            typeof attributes.Type === 'string'
              ? attributes.Type.replace(
                  /^http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships\//,
                  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
                )
              : undefined
          if (tag !== 'Relationship' || attributes.TargetMode === 'External') return tag
          const drawing =
            type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing'
          if (
            !drawing &&
            type !== 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
          ) {
            return tag
          }
          if (typeof attributes.Target !== 'string') {
            throw new Error('Missing XLSX relationship target')
          }
          const target = resolvePart(owner, attributes.Target)
          const content = this.parts.get(partKey(target))
          if (content === undefined) throw new Error(`Missing XLSX part: ${target}`)
          this.inspectContent(content)
          if (drawing) {
            omitted.add(partKey(target))
            const split = target.lastIndexOf('/')
            omitted.add(
              partKey(`${target.slice(0, split + 1)}_rels/${target.slice(split + 1)}.rels`)
            )
          }
          return tag
        }
      }).parse(decodeXml(part))
    }
    const retained = entries.filter(([path]) => !omitted.has(partKey(path)))
    return retained.length === entries.length
      ? this.bytes
      : new Uint8Array(zipSync(Object.fromEntries(retained), { level: 0 }))
  }

  private inspectContent(bytes: Uint8Array): void {
    new XMLParser({
      removeNSPrefix: true,
      processEntities: false,
      parseTagValue: false,
      stopNodes: ['*.sheetData'],
      updateTag: (tag) => {
        if (tag === 'chart') this.unsupportedFeatures.add('charts')
        if (tag === 'pic' || tag === 'picture') this.unsupportedFeatures.add('images')
        if (tag === 'sp' || tag === 'grpSp' || tag === 'cxnSp')
          this.unsupportedFeatures.add('shapes')
        if (tag === 'conditionalFormatting') this.unsupportedFeatures.add('conditionalFormatting')
        if (tag === 'sheetData') return false
        return tag
      }
    }).parse(decodeXml(bytes))
  }
}

/** OPC 判定部件名时按 ASCII 大小写等价，ZIP 里的名字原样保留 */
function partKey(path: string): string {
  return path.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

/** 按 XML 声明占到头两个字节的编码解（不改归档里的字节） */
function decodeXml(bytes: Uint8Array): string {
  const encoding =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
      ? 'utf-16le'
      : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0x00 && bytes[1] === 0x3c)
        ? 'utf-16be'
        : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

/** 相对关系目标按"拥有它的部件"解析，且不许越过包根 */
function resolvePart(owner: string, target: string): string {
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) throw new Error('XLSX relationship escapes package')
      parts.pop()
    } else parts.push(segment)
  }
  return parts.join('/')
}
