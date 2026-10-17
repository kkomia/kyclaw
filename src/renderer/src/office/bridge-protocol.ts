/**
 * 壳 ↔ Office 隔离面的 handshake 协议（M3-S1）。
 *
 * 这是壳（主 renderer，`file://`）与面（`kyclaw-office://surface`，无 preload）之间**唯一**
 * 共用的协议定义：两端都 import 它，所以它必须**零依赖**（不许 import React、编辑器内核或
 * 其它渲染端模块）——壳 import 它不会把 surface-only 的东西带进主 bundle。
 *
 * S1 只做一次性握手（`.superpowers/handover/office-docx-plan.md` §5）：
 *   面 → 壳  `surface:hello`  { nonce, version }     页面已加载，请求初始化
 *   壳 → 面  `surface:init`   { nonce, locale, theme } 回初始化（nonce 原样带回）
 *   面 → 壳  `surface:ready`  { nonce }               面已应用初始化
 *   面 → 壳  `surface:fatal`  { message }             整面起不来（壳可重载 iframe）
 *
 * 安全口径：父页是 `file://`，它的 origin 是 opaque，**不能用 `event.origin` 判断来源**；
 * 壳侧只认 `event.source === iframe.contentWindow`，面侧只认 init 里的 nonce 与自己的相同。
 * S2 起的数据面先走 `postMessage` 的结构化克隆（`doc:open` 带字节）；MessagePort 到 S3 再换，
 * 消息判别联合与 nonce 口径不变。
 */

/** 协议版本：S1 起为 1；字段不兼容变更时 +1（壳与面同时改） */
export const SURFACE_PROTOCOL_VERSION = 1

export type SurfaceTheme = 'light' | 'dark'

/** 面 → 壳：页面已加载（nonce 由面生成，壳原样回带） */
export interface SurfaceHelloMessage {
  type: 'surface:hello'
  nonce: string
  version: number
}

/** 面 → 壳：初始化已应用（壳据此把状态从 loading 切到 ready） */
export interface SurfaceReadyMessage {
  type: 'surface:ready'
  nonce: string
}

/** 面 → 壳：整面致命错误（壳可重载 iframe；S1 只展示 fatal 态） */
export interface SurfaceFatalMessage {
  type: 'surface:fatal'
  message: string
}

export type SurfaceToShellMessage = SurfaceHelloMessage | SurfaceReadyMessage | SurfaceFatalMessage

/** 壳 → 面：一次性初始化（S2 起也用于**运行时主题切换**：同 nonce 再发一次，幂等） */
export interface SurfaceInitMessage {
  type: 'surface:init'
  nonce: string
  locale: string
  theme: SurfaceTheme
}

/**
 * 壳 → 面：打开/替换文档（S2 用 postMessage 结构化克隆，字节随消息过去）。
 *
 * `nonce` 是面生成的握手凭据：面只接受与自己的 nonce 相同的消息，别的 frame 伪造不了。
 * `sha256` 只为面的证据展示与 S3 保存前自检；面的 CSP 没有网络，拿不到父页任何东西。
 */
export interface DocOpenMessage {
  type: 'doc:open'
  nonce: string
  documentId: string
  name: string
  sha256: string
  readOnly: boolean
  bytes: Uint8Array
}

export type ShellToSurfaceMessage = SurfaceInitMessage | DocOpenMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 运行时形状检查：只信"我方 iframe"也要防 bug / 未知消息 */
export function isSurfaceHello(value: unknown): value is SurfaceHelloMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'surface:hello' &&
    isNonEmptyString(value.nonce) &&
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version >= 1
  )
}

export function isSurfaceReady(value: unknown): value is SurfaceReadyMessage {
  if (!isRecord(value)) return false
  return value.type === 'surface:ready' && isNonEmptyString(value.nonce)
}

export function isSurfaceFatal(value: unknown): value is SurfaceFatalMessage {
  if (!isRecord(value)) return false
  return value.type === 'surface:fatal' && typeof value.message === 'string'
}

export function isSurfaceInit(value: unknown): value is SurfaceInitMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'surface:init' &&
    isNonEmptyString(value.nonce) &&
    typeof value.locale === 'string' &&
    value.locale.length > 0 &&
    (value.theme === 'light' || value.theme === 'dark')
  )
}

/** 运行时形状检查：`doc:open`（字节必须是 Uint8Array，nonce 必须非空） */
export function isDocOpen(value: unknown): value is DocOpenMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:open' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId) &&
    isNonEmptyString(value.name) &&
    typeof value.sha256 === 'string' &&
    value.sha256.length > 0 &&
    typeof value.readOnly === 'boolean' &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 0
  )
}

/**
 * 面侧生成 handshake nonce（放在协议模块而不是组件文件里：组件文件只导出组件，不破坏 fast refresh）。
 * 优先 `crypto.randomUUID`（Electron 44 的 Chromium 有），缺了退到时间戳+随机（jsdom 等环境兜底）。
 */
export function createSurfaceNonce(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
