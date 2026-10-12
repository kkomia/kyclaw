import { describe, expect, it } from 'vitest'
import { fileIconKindOf, fileIconOf } from '../file-icon'

/**
 * 文件类型图标：预览标签页的 tab 图标与预览头部那个图标块**共用**这一张表（唯一出处）。
 * 判据是后缀，与 modes.ts 的 previewModeOf 同一套（那边决定"怎么渲染"，这边决定"画哪个图标"）。
 */
describe('fileIconKindOf：后缀 → 图标档', () => {
  it('八档各归各的（大小写不敏感）', () => {
    const cases: Array<[string, string]> = [
      ['报告.pdf', 'pdf'],
      ['报告.PDF', 'pdf'],
      ['图.png', 'image'],
      ['照片.JPEG', 'image'],
      ['动画.gif', 'image'],
      ['方案.docx', 'word'],
      ['旧方案.doc', 'word'],
      ['台账.xlsx', 'excel'],
      ['名单.csv', 'excel'],
      ['旧台账.xls', 'excel'],
      ['汇报.pptx', 'ppt'],
      ['旧汇报.ppt', 'ppt'],
      ['src/index.ts', 'code'],
      ['package.json', 'code'],
      ['README.md', 'markdown'],
      ['说明.MARKDOWN', 'markdown'],
      ['Makefile', 'other'],
      ['不认得.xyz', 'other'],
      ['.gitignore', 'other']
    ]
    for (const [name, kind] of cases) expect([name, fileIconKindOf(name)]).toEqual([name, kind])
  })

  it('反斜杠路径也认（Windows 上复制出来的写法）', () => {
    expect(fileIconKindOf('子目录\\图片.png')).toBe('image')
    expect(fileIconKindOf('子目录\\说明.md')).toBe('markdown')
  })
})

describe('fileIconOf：一个档一个图标，两处（tab / 头部）永远不会打架', () => {
  it('同档同图标、异档异图标', () => {
    expect(fileIconOf('a.pdf')).toBe(fileIconOf('b/c.pdf'))
    expect(fileIconOf('a.pdf')).not.toBe(fileIconOf('a.png'))
    expect(fileIconOf('a.md')).not.toBe(fileIconOf('a.txt'))
  })

  it('八档各自是哪一张 lucide 图标（类名/显示名对得上）', () => {
    expect(fileIconOf('a.pdf').displayName).toBe('FileText')
    expect(fileIconOf('a.png').displayName).toBe('FileImage')
    expect(fileIconOf('a.docx').displayName).toBe('FileType')
    expect(fileIconOf('a.xlsx').displayName).toBe('FileSpreadsheet')
    expect(fileIconOf('a.pptx').displayName).toBe('Presentation')
    expect(fileIconOf('a.ts').displayName).toBe('FileCode')
    expect(fileIconOf('a.md').displayName).toBe('BookText')
    expect(fileIconOf('a.log').displayName).toBe('File')
  })
})
