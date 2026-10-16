import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DshImageBody } from '../image-body'

/** 渲染一份图片字节，拿回根元素与里面的 `<img>`（此时还没"解码完成"）。 */
function mount(format: Parameters<typeof DshImageBody>[0]['format'] = 'image-png'): {
  root: HTMLElement
  image: HTMLImageElement
} {
  render(<DshImageBody format={format} bytes={new Uint8Array([1, 2, 3])} />)
  const root = screen.getByTestId('file-preview-image')
  const image = root.querySelector('img') as HTMLImageElement
  return { root, image }
}

/** jsdom 不真解码：显式铺"原始像素尺寸"再触发 load。 */
function decode(image: HTMLImageElement, w = 1000, h = 400): void {
  Object.defineProperty(image, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: h, configurable: true })
  fireEvent.load(image)
}

describe('DshImageBody：格式与 data URL', () => {
  it('svg / ico 也编成 data URL，MIME 分别是 svg+xml 与 x-icon（CSP 只放行 img-src data:）', () => {
    const svg = render(<DshImageBody format="image-svg" bytes={new Uint8Array([1, 2, 3])} />)
    const svgImage = svg.container.querySelector('img') as HTMLImageElement
    expect(svgImage.getAttribute('src')).toBe('data:image/svg+xml;base64,AQID')
    svg.unmount()

    const ico = render(<DshImageBody format="image-ico" bytes={new Uint8Array([1, 2, 3])} />)
    const icoImage = ico.container.querySelector('img') as HTMLImageElement
    expect(icoImage.getAttribute('src')).toBe('data:image/x-icon;base64,AQID')
  })

  it('SVG 标记不进 DOM：img 里只有 data URL，没有 <svg>/<script> 元素', () => {
    const { root } = mount('image-svg')
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('script')).toBeNull()
  })
})

describe('DshImageBody：解码与回退', () => {
  it('解码完 → data-loaded=true、挂出统一缩放控件、百分比 100%（jsdom 量不到视口宽）', () => {
    const { root, image } = mount()
    expect(root).toHaveAttribute('data-loaded', 'false')
    expect(screen.queryByTestId('dsh-zoom-controls')).toBeNull()

    decode(image)
    expect(root).toHaveAttribute('data-loaded', 'true')
    expect(screen.getByTestId('image-frame')).not.toHaveAttribute('hidden')
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
  })

  it('坏图（onError）给人话，不空白', () => {
    const { image } = mount()
    fireEvent.error(image)
    expect(screen.getByTestId('file-preview-image-error')).toHaveTextContent('打不开')
  })

  it('量不出内在尺寸的 SVG 不判坏图：原始尺寸铺开、不给缩放控件', () => {
    const { root, image } = mount('image-svg')
    decode(image, 0, 0)
    expect(root).toHaveAttribute('data-loaded', 'true')
    expect(root.querySelector('.dsh-media-image-native')).not.toBeNull()
    expect(screen.queryByTestId('dsh-zoom-controls')).toBeNull()
    expect(screen.queryByTestId('file-preview-image-error')).toBeNull()
  })

  it('量不出内在尺寸的位图按坏图处理（png/jpeg 这类真坏件走这条）', () => {
    const { image } = mount('image-png')
    decode(image, 0, 0)
    expect(screen.getByTestId('file-preview-image-error')).toHaveTextContent('打不开')
  })
})

describe('DshImageBody：统一缩放（dsh-document 的 ZoomViewport）', () => {
  it('放大一档 = ×1.25（图片的既有口径，不是文档那套 0.25 栅格），并落到固定倍率模式', () => {
    const { image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('dsh-zoom-in'))
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('125%')
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
  })

  it('既有能力不缩水：一路缩到 10%（下限），按钮站住', () => {
    const { image } = mount()
    decode(image)
    const out = screen.getByTestId('dsh-zoom-out')
    for (let step = 0; step < 15; step += 1) fireEvent.click(out)
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('10%')
    expect(out).toBeDisabled()
  })

  it('既有能力不缩水：一路放到 800%（上限），按钮站住', () => {
    const { image } = mount()
    decode(image)
    const zoomIn = screen.getByTestId('dsh-zoom-in')
    for (let step = 0; step < 12; step += 1) fireEvent.click(zoomIn)
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('800%')
    expect(zoomIn).toBeDisabled()
  })

  it('适应宽度 → 固定倍率的切换（双击）', () => {
    const { image } = mount()
    decode(image)
    fireEvent.doubleClick(image)
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fixed')
    fireEvent.doubleClick(image)
    expect(screen.getByTestId('dsh-zoom-frame')).toHaveAttribute('data-dsh-zoom-mode', 'fit-width')
  })

  it('缩放面按适应宽度拿"原始宽"：--dsh-zoom-width 就是它', () => {
    const { image } = mount()
    decode(image)
    expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
      '1000px'
    )
  })
})

describe('DshImageBody：旋转（本仓保留的能力）', () => {
  it('未解码前不挂旋转钮（没有可转的内容）', () => {
    mount()
    expect(screen.queryByTestId('image-rotate-right')).toBeNull()
  })

  it('转 90°：外接框宽高对调（--dsh-zoom-width 换成原始高），图片只叠 transform', () => {
    const { root, image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '90')
    expect(image.style.transform).toContain('rotate(90deg)')
    expect(screen.getByTestId('image-frame').style.getPropertyValue('--dsh-zoom-width')).toBe(
      '400px'
    )
    // 图片元素自己的布局盒按"原始尺寸相对外接框"的百分比铺（1000×400 转成 400×1000 的口袋），
    // 铺 250% × 40% 正好等价于原始 1000×400；转的是 transform
    expect(image.style.width).toBe('250%')
    expect(image.style.height).toBe('40%')
  })

  it('左右各 90° 步进、取模回正，百分比不跟着变', () => {
    const { root, image } = mount()
    decode(image)
    fireEvent.click(screen.getByTestId('image-rotate-left'))
    expect(root).toHaveAttribute('data-rotation', '270')
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '90')
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    fireEvent.click(screen.getByTestId('image-rotate-right'))
    expect(root).toHaveAttribute('data-rotation', '0')
    expect(screen.getByTestId('dsh-zoom-value')).toHaveTextContent('100%')
  })
})
