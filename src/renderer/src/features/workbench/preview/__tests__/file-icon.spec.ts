import { render } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { fileIconKindOf, fileIconOf, type FileIconKind } from '../file-icon'

/**
 * 文件类型图标（round 56 换成 iconfont 收藏集 233548 那套彩色 glyph）：两层各钉一次 ——
 * ① `fileIconKindOf` 后缀 → 档的语义映射；② `fileIconOf` 档 → 组件的静态表（引用稳定，
 * 预览标签 / 预览头部 / 文件树行 / 搜索结果行 / 交付卡共用同一张表）。
 *
 * 判据与 modes.ts 的 previewModeOf 同一套（那边决定"怎么渲染"，这边决定"画哪个图标"）：
 * 先查后缀直映射表，查不到按预览分组回退，最后 `generic`。
 */
describe('fileIconKindOf：后缀 → 图标档', () => {
  it('逐档对得上（大小写不敏感）', () => {
    const cases: Array<[string, FileIconKind]> = [
      ['报告.pdf', 'pdf'],
      ['报告.PDF', 'pdf'],
      ['方案.docx', 'word'],
      ['旧方案.doc', 'word'],
      ['台账.xlsx', 'excel'],
      ['旧台账.xls', 'excel'],
      ['汇报.pptx', 'ppt'],
      ['旧汇报.ppt', 'ppt'],
      ['说明.md', 'markdown'],
      ['NOTES.MARKDOWN', 'markdown'],
      ['日志.log', 'txt'],
      ['字幕.srt', 'txt'],
      ['图.png', 'image'],
      ['照片.JPEG', 'image'],
      ['网页.webp', 'image'],
      ['图标.ico', 'image'],
      ['动画.gif', 'gif'],
      ['矢量.svg', 'svg'],
      ['片子.mp4', 'video'],
      ['短片.mov', 'video'],
      ['歌.mp3', 'audio'],
      ['无损.flac', 'audio'],
      ['录音.wav', 'wav'],
      ['包.zip', 'archive'],
      ['包.7z', 'archive'],
      ['包.rar', 'rar'],
      ['页.html', 'html'],
      ['组件.vue', 'html'],
      ['样式.css', 'css'],
      ['脚本.js', 'js'],
      ['src/index.ts', 'js'],
      ['src/App.tsx', 'js'],
      ['package.json', 'json'],
      ['脚本.sh', 'code'],
      ['配置.yml', 'code'],
      ['main.go', 'code'],
      ['爬虫.py', 'python'],
      ['笔记本.ipynb', 'python'],
      ['名单.csv', 'csv'],
      ['配置.xml', 'xml'],
      ['setup.exe', 'exe'],
      ['装机.dmg', 'dmg'],
      ['应用.apk', 'apk'],
      ['设计稿.psd', 'psd']
    ]
    for (const [name, kind] of cases) expect([name, fileIconKindOf(name)]).toEqual([name, kind])
  })

  it('认不出的后缀 / 没有后缀 → generic；反斜杠路径也认', () => {
    expect(fileIconKindOf('不认得.xyz')).toBe('generic')
    expect(fileIconKindOf('.gitignore')).toBe('generic')
    expect(fileIconKindOf('Makefile')).toBe('generic')
    expect(fileIconKindOf('子目录\\图片.png')).toBe('image')
    expect(fileIconKindOf('子目录\\说明.md')).toBe('markdown')
  })
})

describe('fileIconOf：档 → 组件（引用稳定，几处界面共用同一张表）', () => {
  it('同档 = 同一个组件引用（不论路径怎么写）', () => {
    expect(fileIconOf('a.pdf')).toBe(fileIconOf('b/c.pdf'))
    expect(fileIconOf('报告.PDF')).toBe(fileIconOf('docs/报告.pdf'))
    expect(fileIconOf('a.docx')).toBe(fileIconOf('子目录\\a.doc'))
  })

  it('异档 = 不同引用（哪怕后缀同属预览的一条通道）', () => {
    expect(fileIconOf('a.pdf')).not.toBe(fileIconOf('a.png'))
    expect(fileIconOf('a.ts')).toBe(fileIconOf('a.js'))
    expect(fileIconOf('a.ts')).not.toBe(fileIconOf('a.py'))
    expect(fileIconOf('a.zip')).not.toBe(fileIconOf('a.rar'))
    expect(fileIconOf('a.txt')).not.toBe(fileIconOf('a.xyz'))
  })

  it('拿到的组件能直接画：出来就是数据层那张图（data-file-icon 是档）', () => {
    const { container } = render(
      createElement(fileIconOf('报表.pdf'), { className: 'size-4', 'aria-hidden': true })
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('data-file-icon')).toBe('pdf')
    expect(svg?.getAttribute('class')).toBe('size-4')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
