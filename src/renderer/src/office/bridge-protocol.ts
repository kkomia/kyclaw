/**
 * 壳 ↔ Office 隔离面的桥协议（M3-S1 握手 → S2 投递字节 → S3 保存链路）。
 *
 * 这是壳（主 renderer，`file://`）与面（`kyclaw-office://surface`，无 preload）之间**唯一**
 * 共用的协议定义：两端都 import 它，所以它必须**零依赖**（不许 import React、编辑器内核或
 * 其它渲染端模块）——壳 import 它不会把 surface-only 的东西带进主 bundle。
 *
 * 消息一览（`.superpowers/handover/office-docx-plan.md` §5/§7.2）：
 *   面 → 壳  `surface:hello`    { nonce, version }              页面已加载，请求初始化
 *   壳 → 面  `surface:init`     { nonce, locale, theme }        初始化 / 运行时主题切换（可重发）
 *   面 → 壳  `surface:ready`    { nonce }                       初始化已应用
 *   面 → 壳  `surface:fatal`    { message }                     整面起不来
 *   壳 → 面  `doc:open`         { nonce, documentId, name, sha256, readOnly, bytes }
 *   面 → 壳  `doc:loaded`       { nonce, documentId, pages }    文档挂载 + 首次布局完成
 *   面 → 壳  `doc:changed`      { nonce, documentId, revision } 用户编辑（revision 单调）
 *   面 → 壳  `doc:save-request` { nonce, documentId }           用户点了编辑器自己的保存/菜单
 *   壳 → 面  `doc:save`         { nonce, requestId }            要求面生成保存字节
 *   面 → 壳  `doc:save-bytes`   { nonce, requestId, documentId, bytes }
 *   壳 → 面  `doc:reload`       { nonce, bytes }                冲突后从磁盘重载（丢内存修改）
 *   壳 → 面  `doc:close`        { nonce, documentId }           卸载编辑器
 *   面 → 壳  `doc:error`        { nonce, documentId?, phase, message }
 *
 * 安全口径：父页是 `file://`，它的 origin 是 opaque，**不能用 `event.origin` 判断来源**；
 * 壳侧只认 `event.source === iframe.contentWindow`，面侧只认消息里的 nonce 与自己的相同。
 * S3 仍用 `postMessage` 结构化克隆传字节（64MB 级文档会多一次拷贝；MessagePort 待后续需要时再换，
 * 消息判别联合与 nonce 口径不变）。
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

/** 面 → 壳：文档已挂载并完成首次布局 */
export interface DocLoadedMessage {
  type: 'doc:loaded'
  nonce: string
  documentId: string
  pages: number
}

/** 面 → 壳：用户编辑（revision 由面单调递增；壳的 editSeq 只信这条） */
export interface DocChangedMessage {
  type: 'doc:changed'
  nonce: string
  documentId: string
  revision: number
}

/** 面 → 壳：用户触发了编辑器内部的保存（Ctrl+S / File > Save）→ 由壳跑保存状态机 */
export interface DocSaveRequestMessage {
  type: 'doc:save-request'
  nonce: string
  documentId: string
}

/** 面 → 壳：保存字节已生成（回包带 requestId，壳按它兑现 doc:save 的等待） */
export interface DocSaveBytesMessage {
  type: 'doc:save-bytes'
  nonce: string
  requestId: string
  documentId: string
  bytes: Uint8Array
}

/** 面 → 壳：面内错误（打开/布局/保存/运行时；壳展示并决定是否重试） */
export type DocErrorPhase = 'open' | 'layout' | 'save' | 'runtime'

export interface DocErrorMessage {
  type: 'doc:error'
  nonce: string
  documentId?: string
  phase: DocErrorPhase
  message: string
}

export type SurfaceToShellMessage =
  | SurfaceHelloMessage
  | SurfaceReadyMessage
  | SurfaceFatalMessage
  | DocLoadedMessage
  | DocChangedMessage
  | DocSaveRequestMessage
  | DocSaveBytesMessage
  | DocErrorMessage

/** 壳 → 面：初始化（S2 起也用于**运行时主题切换**：同 nonce 再发一次，幂等） */
export interface SurfaceInitMessage {
  type: 'surface:init'
  nonce: string
  locale: string
  theme: SurfaceTheme
}

/**
 * 壳 → 面：打开/替换文档（S3 仍用 postMessage 结构化克隆，字节随消息过去）。
 *
 * `nonce` 是面生成的握手凭据：面只接受与自己的 nonce 相同的消息，别的 frame 伪造不了。
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

/** 壳 → 面：要求面生成当前文档的保存字节（面 `flushPendingInput()` + `ref.save()`） */
export interface DocSaveMessage {
  type: 'doc:save'
  nonce: string
  requestId: string
}

/** 壳 → 面：从磁盘字节重载（冲突后用户选择"重新载入"；丢内存修改前壳必须二次确认） */
export interface DocReloadMessage {
  type: 'doc:reload'
  nonce: string
  bytes: Uint8Array
}

/** 壳 → 面：卸载该文档的编辑器（关标签） */
export interface DocCloseMessage {
  type: 'doc:close'
  nonce: string
  documentId: string
}

export type ShellToSurfaceMessage =
  SurfaceInitMessage | DocOpenMessage | DocSaveMessage | DocReloadMessage | DocCloseMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
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

export function isDocLoaded(value: unknown): value is DocLoadedMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:loaded' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId) &&
    isRevision(value.pages)
  )
}

export function isDocChanged(value: unknown): value is DocChangedMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:changed' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId) &&
    isRevision(value.revision) &&
    value.revision > 0
  )
}

export function isDocSaveRequest(value: unknown): value is DocSaveRequestMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:save-request' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId)
  )
}

export function isDocSaveBytes(value: unknown): value is DocSaveBytesMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:save-bytes' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.documentId) &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 0
  )
}

const DOC_ERROR_PHASES: readonly string[] = ['open', 'layout', 'save', 'runtime']

export function isDocError(value: unknown): value is DocErrorMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:error' &&
    isNonEmptyString(value.nonce) &&
    typeof value.phase === 'string' &&
    DOC_ERROR_PHASES.includes(value.phase) &&
    typeof value.message === 'string' &&
    value.message.length > 0
  )
}

export function isDocSave(value: unknown): value is DocSaveMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:save' && isNonEmptyString(value.nonce) && isNonEmptyString(value.requestId)
  )
}

export function isDocReload(value: unknown): value is DocReloadMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:reload' &&
    isNonEmptyString(value.nonce) &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 0
  )
}

export function isDocClose(value: unknown): value is DocCloseMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:close' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId)
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
