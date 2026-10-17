import { describe, expect, it } from 'vitest'
import {
  currentSurfaceUrl,
  OFFICE_SURFACE_ORIGIN,
  OFFICE_SURFACE_SCHEME,
  resolveSurfaceUrl
} from '../surface-url'

/**
 * surface URL 决策（M3-S1）：三种形态按 location 区分。
 * 真机形态由 e2e 探针（file:// 父页 → kyclaw-office://surface/）验收，这里只钉纯函数规则。
 */
describe('resolveSurfaceUrl：preview / 打包（file://）走自定义协议', () => {
  it('file:// 父页 → kyclaw-office://surface/', () => {
    expect(resolveSurfaceUrl({ protocol: 'file:', origin: 'null' })).toBe(
      'kyclaw-office://surface/'
    )
  })

  it('dev（http/https 主窗口）→ 同源 /office.html（隔离不成立，只影响开发期）', () => {
    expect(resolveSurfaceUrl({ protocol: 'http:', origin: 'http://localhost:5173' })).toBe(
      'http://localhost:5173/office.html'
    )
    expect(resolveSurfaceUrl({ protocol: 'https:', origin: 'https://kyclaw.local' })).toBe(
      'https://kyclaw.local/office.html'
    )
  })

  it('其它协议兜底走自定义协议（不猜别的开发形态）', () => {
    expect(resolveSurfaceUrl({ protocol: 'app:', origin: 'null' })).toBe('kyclaw-office://surface/')
  })

  it('常量与主进程协议口径一致（跨进程不能共享常量，这里钉死）', () => {
    expect(OFFICE_SURFACE_SCHEME).toBe('kyclaw-office')
    expect(OFFICE_SURFACE_ORIGIN).toBe('kyclaw-office://surface')
  })

  it('currentSurfaceUrl 跟随当前 window.location（jsdom 下是 http）', () => {
    expect(currentSurfaceUrl()).toBe(`${window.location.origin}/office.html`)
  })
})
