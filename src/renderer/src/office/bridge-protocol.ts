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
 *   面 → 壳  `doc:save-request` { nonce, requestId, documentId } 用户发起保存（QAT / 面内 Ctrl+S）
 *   壳 → 面  `doc:save`         { nonce, requestId }            要求面生成保存字节
 *   面 → 壳  `doc:save-bytes`   { nonce, requestId, documentId, bytes }
 *   壳 → 面  `doc:save-result`  { nonce, requestId, ok, code?, message? } 写盘结果回执（A4.5）
 *   壳 → 面  `doc:reload`       { nonce, bytes }                冲突后从磁盘重载（丢内存修改）
 *   壳 → 面  `doc:close`        { nonce, documentId }           卸载编辑器
 *   面 → 壳  `doc:error`        { nonce, documentId?, phase, message }
 *   面 → 壳  `surface:shortcut` { nonce, action }               焦点在 iframe 内时 Ctrl+S/W/Tab 的转发
 *
 * 快捷键（M3-S4）：浏览器事件不跨文档，焦点在面内编辑器里时壳的 window 监听收不到 Ctrl+S/W/Tab。
 * 面在 capture 阶段拦下这组组合键、只发"动作名"（不带键值/业务数据），由壳的常驻 AppTabBar
 * 走与壳侧按键完全相同的一条 `office-actions` 分发（保存/关标签/切标签三态都在壳里）。
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

/**
 * 面 → 壳：用户发起了保存（A2 QAT 按钮 / 面内 Ctrl+S 同一路）。
 *
 * A4.5 起带 `requestId`：壳在**写盘结果落定**后用同一条 id 回 `doc:save-result`，
 * 面内 QAT 据此驱动 已保存/未保存/错误（不再靠 1.5s 乐观窗口猜）。
 */
export interface DocSaveRequestMessage {
  type: 'doc:save-request'
  nonce: string
  requestId: string
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

/** 面内快捷键动作（只发动作名；键值/平台差异留在面侧） */
export type SurfaceShortcutAction = 'save' | 'close' | 'next-tab' | 'prev-tab'

/** 面 → 壳：焦点在 iframe 内时按了 Ctrl+S/W/Tab（壳按当前路由/标签状态统一处理） */
export interface SurfaceShortcutMessage {
  type: 'surface:shortcut'
  nonce: string
  action: SurfaceShortcutAction
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
  | SurfaceShortcutMessage

/** 壳 → 面：初始化（S2 起也用于**运行时主题切换**：同 nonce 再发一次，幂等） */
export interface SurfaceInitMessage {
  type: 'surface:init'
  nonce: string
  locale: string
  theme: SurfaceTheme
  /** D17：测试探针缝（仅未打包 + KYCLAW_OFFICE_PROBE；复用的预热面靠这条拿到开关） */
  probe?: boolean
  /** PB-019：应用内「减弱动效」传进隔离面（缺省 full，向后兼容） */
  motion?: 'full' | 'reduced'
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
  /** M4-X/P：编辑器格式；面据此挂 DocxEditor / XlsxEditor / PptxEditor */
  kind: 'docx' | 'xlsx' | 'pptx'
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

/**
 * 壳 → 面：**保存结果回执**（A4.5）：壳的保存状态机写盘落定后回发，把面内 QAT 从乐观窗口
 * 改成事件驱动。
 *
 * - `ok:true`：写盘 + commit 成功（面据此进「已保存」；若保存期间又有编辑，面自己按 revision
 *   判定仍显示「未保存修改」——真相与壳的 save-machine 对齐）；
 * - `ok:false`：失败（`code` 是壳的分类：`write-locked` / `conflict` / `write-failed` /
 *   `no-space` / `save-failed` …），面进「未保存修改」+ 错误态，文案只用壳给 `message`（不自造）；
 * - `requestId`：面发起的那次保存的 id（原样回带）；壳侧主动发起的保存（壳按钮/壳侧 Ctrl+S）
 *   也会回一条，面按"没有在途请求 → 直接采信"处理。
 */
export interface DocSaveResultMessage {
  type: 'doc:save-result'
  nonce: string
  requestId: string
  ok: boolean
  code?: string
  message?: string
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

/** 壳 → 面：请求面重新发一次 `surface:hello`（task-100 复用启动预热面：面已 boot，
 * 但 hello 重试窗口（5s）早已结束，壳需要重新握手才能拿 nonce / init / doc:open）。 */
export interface SurfaceHelloRequestMessage {
  type: 'surface:hello-request'
}

export type ShellToSurfaceMessage =
  | SurfaceInitMessage
  | DocOpenMessage
  | DocSaveMessage
  | DocSaveResultMessage
  | DocReloadMessage
  | DocCloseMessage
  | SurfaceHelloRequestMessage

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

/** 面侧守卫：壳请求重新 hello */
export function isSurfaceHelloRequest(value: unknown): value is SurfaceHelloRequestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'surface:hello-request'
  )
}

export function isSurfaceInit(value: unknown): value is SurfaceInitMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'surface:init' &&
    isNonEmptyString(value.nonce) &&
    typeof value.locale === 'string' &&
    value.locale.length > 0 &&
    (value.theme === 'light' || value.theme === 'dark') &&
    (value.probe === undefined || typeof value.probe === 'boolean') &&
    (value.motion === undefined || value.motion === 'full' || value.motion === 'reduced')
  )
}

export function isDocOpen(value: unknown): value is DocOpenMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:open' &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.documentId) &&
    (value.kind === 'docx' || value.kind === 'xlsx' || value.kind === 'pptx') &&
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
    isNonEmptyString(value.requestId) &&
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

const SURFACE_SHORTCUT_ACTIONS: readonly SurfaceShortcutAction[] = [
  'save',
  'close',
  'next-tab',
  'prev-tab'
]

export function isSurfaceShortcut(value: unknown): value is SurfaceShortcutMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'surface:shortcut' &&
    isNonEmptyString(value.nonce) &&
    typeof value.action === 'string' &&
    SURFACE_SHORTCUT_ACTIONS.includes(value.action as SurfaceShortcutAction)
  )
}

export function isDocSave(value: unknown): value is DocSaveMessage {
  if (!isRecord(value)) return false
  return (
    value.type === 'doc:save' && isNonEmptyString(value.nonce) && isNonEmptyString(value.requestId)
  )
}

/**
 * 保存结果回执（壳 → 面）的形状检查：`ok` 必须是布尔、`code`/`message` 若给必须是非空字符串
 * （面只显示壳给的人话，不收半截/伪造的回执）。
 */
export function isDocSaveResult(value: unknown): value is DocSaveResultMessage {
  if (!isRecord(value)) return false
  if (value.type !== 'doc:save-result') return false
  if (!isNonEmptyString(value.nonce) || !isNonEmptyString(value.requestId)) return false
  if (typeof value.ok !== 'boolean') return false
  if (value.code !== undefined && !isNonEmptyString(value.code)) return false
  if (value.message !== undefined && !isNonEmptyString(value.message)) return false
  return true
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
