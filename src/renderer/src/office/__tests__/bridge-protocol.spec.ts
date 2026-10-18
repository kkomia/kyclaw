import { describe, expect, it } from 'vitest'
import {
  isDocOpen,
  isDocSaveRequest,
  isDocSaveResult,
  isSurfaceFatal,
  isSurfaceHello,
  isSurfaceInit,
  isSurfaceReady,
  isSurfaceShortcut,
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
describe('bridge-protocol：M3-S4 面内快捷键', () => {
  it('surface:shortcut：type + 非空 nonce + 动作白名单（save/close/next-tab/prev-tab）', () => {
    for (const action of ['save', 'close', 'next-tab', 'prev-tab']) {
      expect(isSurfaceShortcut({ type: 'surface:shortcut', nonce: 'n1', action })).toBe(true)
    }
    expect(isSurfaceShortcut({ type: 'surface:shortcut', nonce: '', action: 'save' })).toBe(false)
    expect(isSurfaceShortcut({ type: 'surface:shortcut', nonce: 'n1', action: 'quit' })).toBe(false)
    expect(isSurfaceShortcut({ type: 'surface:shortcut', nonce: 'n1' })).toBe(false)
    expect(isSurfaceShortcut({ type: 'doc:save', nonce: 'n1', action: 'save' })).toBe(false)
    expect(isSurfaceShortcut(null)).toBe(false)
  })
})

describe('bridge-protocol：M4-X/P doc:open kind', () => {
  const base = {
    type: 'doc:open' as const,
    nonce: 'n1',
    documentId: 'doc-1',
    name: '文件',
    sha256: 'a'.repeat(64),
    readOnly: false,
    bytes: new Uint8Array([1])
  }
  it('docx / xlsx / pptx 三种 kind 都接受', () => {
    for (const kind of ['docx', 'xlsx', 'pptx'] as const) {
      expect(isDocOpen({ ...base, kind })).toBe(true)
    }
  })
  it('缺 kind / 未知 kind / 非 kind 字段一律拒绝', () => {
    expect(isDocOpen(base)).toBe(false)
    expect(isDocOpen({ ...base, kind: 'pdf' })).toBe(false)
    expect(isDocOpen({ ...base, kind: 1 })).toBe(false)
  })
})

describe('bridge-protocol：A4.5 保存请求与结果回执', () => {
  it('doc:save-request：必须带 requestId + documentId（面发起保存，回执按它兑现）', () => {
    expect(
      isDocSaveRequest({
        type: 'doc:save-request',
        nonce: 'n1',
        requestId: 'r1',
        documentId: 'doc-1'
      })
    ).toBe(true)
    // 缺 requestId（A4.5 之前的形状）→ 不认
    expect(isDocSaveRequest({ type: 'doc:save-request', nonce: 'n1', documentId: 'doc-1' })).toBe(
      false
    )
    expect(
      isDocSaveRequest({
        type: 'doc:save-request',
        nonce: 'n1',
        requestId: '',
        documentId: 'doc-1'
      })
    ).toBe(false)
    expect(
      isDocSaveRequest({ type: 'doc:save-request', nonce: 'n1', requestId: 'r1', documentId: '' })
    ).toBe(false)
    expect(isDocSaveRequest({ type: 'doc:save', nonce: 'n1', requestId: 'r1' })).toBe(false)
    expect(isDocSaveRequest(null)).toBe(false)
  })

  it('doc:save-result：ok 布尔 + requestId；code/message 可选，给了就必须非空字符串', () => {
    const base = { type: 'doc:save-result', nonce: 'n1', requestId: 'r1' } as const
    expect(isDocSaveResult({ ...base, ok: true })).toBe(true)
    expect(isDocSaveResult({ ...base, ok: false })).toBe(true)
    expect(
      isDocSaveResult({
        ...base,
        ok: false,
        code: 'write-locked',
        message: '文件被其他程序占用'
      })
    ).toBe(true)
    // 缺 ok / ok 不是布尔
    expect(isDocSaveResult(base)).toBe(false)
    expect(isDocSaveResult({ ...base, ok: 'true' })).toBe(false)
    // 空 requestId
    expect(isDocSaveResult({ ...base, requestId: '', ok: true })).toBe(false)
    // 半截字符串不收
    expect(isDocSaveResult({ ...base, ok: true, code: '' })).toBe(false)
    expect(isDocSaveResult({ ...base, ok: true, message: '' })).toBe(false)
    // 别的类型 / 非对象
    expect(isDocSaveResult({ type: 'doc:save', nonce: 'n1', requestId: 'r1', ok: true })).toBe(
      false
    )
    expect(isDocSaveResult(null)).toBe(false)
  })
})
