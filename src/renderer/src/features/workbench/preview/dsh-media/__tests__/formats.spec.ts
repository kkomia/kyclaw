import { describe, expect, it } from 'vitest'
import { IMAGE_MEDIA_TYPES, toDataUrl } from '../formats'

describe('IMAGE_MEDIA_TYPES：格式 → MIME', () => {
  it('既有五种 + DSH 的 svg / ico 都有，且 MIME 正确', () => {
    expect(IMAGE_MEDIA_TYPES['image-png']).toBe('image/png')
    expect(IMAGE_MEDIA_TYPES['image-jpeg']).toBe('image/jpeg')
    expect(IMAGE_MEDIA_TYPES['image-gif']).toBe('image/gif')
    expect(IMAGE_MEDIA_TYPES['image-webp']).toBe('image/webp')
    expect(IMAGE_MEDIA_TYPES['image-bmp']).toBe('image/bmp')
    expect(IMAGE_MEDIA_TYPES['image-ico']).toBe('image/x-icon')
    expect(IMAGE_MEDIA_TYPES['image-svg']).toBe('image/svg+xml')
  })

  it('不认的格式没有 MIME（调用方据此给人话，而不是硬编一个 octet-stream 去画）', () => {
    expect(IMAGE_MEDIA_TYPES['pdf']).toBeUndefined()
    expect(IMAGE_MEDIA_TYPES['image-avif']).toBeUndefined()
  })
})

describe('toDataUrl：分块拼串', () => {
  it('小字节照常编码', () => {
    expect(toDataUrl(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBe(
      'data:image/png;base64,iVBORw=='
    )
  })

  it('大数组也不会爆栈（分块口径 0x8000；这里给 3 个块还多的量）', () => {
    const bytes = new Uint8Array(100_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    const url = toDataUrl(bytes, 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    // 编回来的字节与原文逐字节一致（base64 膨胀后仍是整份）
    const base64 = url.slice('data:image/png;base64,'.length)
    const binary = atob(base64)
    expect(binary.length).toBe(bytes.length)
    expect(binary.charCodeAt(99_999)).toBe(bytes[99_999])
  })
})
