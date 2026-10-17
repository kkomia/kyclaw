import { describe, expect, it } from 'vitest'
import {
  isSurfaceFatal,
  isSurfaceHello,
  isSurfaceInit,
  isSurfaceReady,
  SURFACE_PROTOCOL_VERSION
} from '../bridge-protocol'

/**
 * 壳 ↔ 面 handshake 协议的形状检查（M3-S1）：只认白名单字段，畸形消息一律丢。
 * 这份 spec 与壳侧共用同一份定义（`src/renderer/src/office/bridge-protocol.ts`）。
 */
describe('bridge-protocol：hello / init / ready / fatal 判别', () => {
  it('hello：type + 非空 nonce + 正整数 version', () => {
    expect(
      isSurfaceHello({ type: 'surface:hello', nonce: 'n1', version: SURFACE_PROTOCOL_VERSION })
    ).toBe(true)
    expect(isSurfaceHello({ type: 'surface:hello', nonce: '', version: 1 })).toBe(false)
    expect(isSurfaceHello({ type: 'surface:hello', nonce: 'n1' })).toBe(false)
    expect(isSurfaceHello({ type: 'surface:hello', nonce: 'n1', version: 0 })).toBe(false)
    expect(isSurfaceHello({ type: 'surface:hello', nonce: 'n1', version: 1.5 })).toBe(false)
    expect(isSurfaceHello({ type: 'surface:init', nonce: 'n1', version: 1 })).toBe(false)
    expect(isSurfaceHello(null)).toBe(false)
    expect(isSurfaceHello('surface:hello')).toBe(false)
  })

  it('init：type + nonce + locale + theme ∈ {light,dark}', () => {
    expect(
      isSurfaceInit({ type: 'surface:init', nonce: 'n1', locale: 'zh-CN', theme: 'light' })
    ).toBe(true)
    expect(
      isSurfaceInit({ type: 'surface:init', nonce: 'n1', locale: 'zh-CN', theme: 'dark' })
    ).toBe(true)
    expect(
      isSurfaceInit({ type: 'surface:init', nonce: 'n1', locale: 'zh-CN', theme: 'pink' })
    ).toBe(false)
    expect(
      isSurfaceInit({ type: 'surface:init', nonce: '', locale: 'zh-CN', theme: 'light' })
    ).toBe(false)
    expect(isSurfaceInit({ type: 'surface:init', nonce: 'n1', locale: '', theme: 'light' })).toBe(
      false
    )
  })

  it('ready / fatal：判别字段正确；类型错的不认', () => {
    expect(isSurfaceReady({ type: 'surface:ready', nonce: 'n1' })).toBe(true)
    expect(isSurfaceReady({ type: 'surface:ready' })).toBe(false)
    expect(isSurfaceFatal({ type: 'surface:fatal', message: 'boom' })).toBe(true)
    expect(isSurfaceFatal({ type: 'surface:fatal', message: '' })).toBe(true)
    expect(isSurfaceFatal({ type: 'surface:fatal' })).toBe(false)
  })

  it('版本常量从 1 起（S1 冻结口径）', () => {
    expect(SURFACE_PROTOCOL_VERSION).toBe(1)
  })
})
