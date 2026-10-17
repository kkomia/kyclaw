import { describe, expect, it } from 'vitest'
import { previewNeedsFixedHeight } from '../host-size'

describe('previewNeedsFixedHeight：哪些预览要宿主给确定高度', () => {
  it('内部自带滚动口的四档（办公 / 表格 / PDF / 图片）都要确定高度', () => {
    expect(previewNeedsFixedHeight('office')).toBe(true)
    expect(previewNeedsFixedHeight('table')).toBe(true)
    expect(previewNeedsFixedHeight('pdf')).toBe(true)
    // 图片：默认"适应窗口"（contain）要吃视口高 —— 宿主若由内容撑高，量到的高就是内容自己的高
    // （恒等测量），竖图永远"装得下"、适配失效（反馈 001 的同一个坑）
    expect(previewNeedsFixedHeight('image')).toBe(true)
  })

  it('文本 / markdown / 代码 / HTML 那几档维持"内容撑高"', () => {
    expect(previewNeedsFixedHeight('text')).toBe(false)
    expect(previewNeedsFixedHeight('markdown')).toBe(false)
    expect(previewNeedsFixedHeight('code')).toBe(false)
    expect(previewNeedsFixedHeight('html')).toBe(false)
  })
})
