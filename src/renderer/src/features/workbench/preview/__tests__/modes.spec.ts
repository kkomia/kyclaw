import { describe, expect, it } from 'vitest'
import { extensionOf, previewModeOf } from '../modes'

/**
 * 预览路由：后缀 → 走哪条通道 / 哪个渲染器。
 * 认不出的后缀一律回落现有文本通道（行为与 round40 之前一致，不悄悄改变既有预览）。
 */
describe('previewModeOf：后缀决定渲染方式', () => {
  it('markdown 两种后缀都走 markdown', () => {
    expect(previewModeOf('README.md')).toBe('markdown')
    expect(previewModeOf('docs/说明.MARKDOWN')).toBe('markdown')
  })

  it('认得图片六种后缀（大小写不敏感）', () => {
    expect(previewModeOf('a.png')).toBe('image')
    expect(previewModeOf('a.JPG')).toBe('image')
    expect(previewModeOf('a.jpeg')).toBe('image')
    expect(previewModeOf('a.GIF')).toBe('image')
    expect(previewModeOf('a.webp')).toBe('image')
    expect(previewModeOf('a.BMP')).toBe('image')
  })

  it('pdf 走 pdf；其余（含无后缀、隐藏文件）回落文本', () => {
    expect(previewModeOf('报告.PDF')).toBe('pdf')
    expect(previewModeOf('src/index.ts')).toBe('text')
    expect(previewModeOf('package.json')).toBe('text')
    expect(previewModeOf('Makefile')).toBe('text')
    expect(previewModeOf('.gitignore')).toBe('text')
    expect(previewModeOf('目录.d/')).toBe('text')
  })

  it('反斜杠路径也认（Windows 上复制出来的写法）', () => {
    expect(previewModeOf('子目录\\图片.png')).toBe('image')
    expect(previewModeOf('子目录\\说明.md')).toBe('markdown')
  })

  it('extensionOf：只取最后一段后缀，没有后缀给空串', () => {
    expect(extensionOf('a/b/c.tar.gz')).toBe('gz')
    expect(extensionOf('没有后缀')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})
