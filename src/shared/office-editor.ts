/**
 * Office 编辑器（第一步只接 DOCX）的跨进程合同（M3-S2）。
 *
 * 三层分工（`.superpowers/handover/office-docx-plan.md` §5/§6）：
 *   - **主进程**：原生选择器、文档注册表（documentId ↔ realpath/mtime/sha256/owner）、读字节；
 *     绝对路径只活在主进程与注册表里，渲染端只拿 `displayPath`（只读展示用）。
 *   - **壳渲染端**：`window.kyclaw.office.*`（本文件定义形状，preload 白名单实现）、标签、字节中转。
 *   - **隔离面**：拿不到 IPC / preload；字节由壳经 `postMessage`（S2）投递，S3 换 MessagePort。
 *
 * 安全口径：
 *   - 渲染端**永远不传绝对路径**：选择器路径由主进程给；会话文件只传 `threadId + 相对路径`，
 *     根解析（`sessionRootForThread`）与 containment（`resolveInsideWorkspace`）都在主进程；
 *   - `office:read` 只认 `documentId`，且必须由**打开它的那个 webContents** 调用（owner 校验）；
 *   - 主进程**不保存文档内容**，只保存 stat/hash/显示信息；每次读都重新落盘复核。
 *
 * 为什么 schema 都住这里：主进程入参闸门、preload 回包校验、渲染端类型共用一份。
 * 必须 `import { z } from './zod'`（jitless，见 shared/zod.ts）。
 */
import { z } from './zod'

/**
 * 通道名。`shared/ipc.ts` 把它们挂到 `IPC_CHANNELS.office` 下（渲染端/preload/主进程共用）。
 *
 * `save` / `save-as` 的**形状在 S2 先冻结、通道 S3 才注册**（见 §9-S3）：类型先定下来，
 * 免得 S3 再改一遍共享合同。S2 的注册表只做打开/读字节。
 */
export const OFFICE_IPC_CHANNELS = {
  /** 读隔离面配置（surfaceUrl / origin / 上限） */
  config: 'office:config',
  /** 原生「打开文件」选择器（`.docx`）；取消是一等结果 */
  openDialog: 'office:open-dialog',
  /** 打开会话根下的文件：渲染端只给 threadId + 相对路径 */
  openFromSession: 'office:open-from-session',
  /** 按 documentId 重读字节（复核 stat/hash；重载/冲突复查用） */
  read: 'office:read',
  /** 关标签时释放注册表条目（幂等） */
  release: 'office:release',
  /** S3：原子写 + 冲突检测（S2 仅定义，不注册） */
  save: 'office:save',
  /** S3：另存为（S2 仅定义，不注册） */
  saveAs: 'office:save-as',
  /** S5：壳把"当前未保存文档数"推给主进程（**只传计数**；退出拦截的快速判空用） */
  dirtyState: 'office:dirty-state',
  /** S5：主进程 → 壳：退出/关窗确认请求（壳据此弹三态对话框） */
  quitRequest: 'office:quit-request',
  /** S5：壳 → 主进程：退出确认结果（saved / discarded / cancelled） */
  quitResult: 'office:quit-result',
  /**
   * task-80（新增标签页 v1）：新建空白 Word 文档——主进程把随包最小模板写到
   * `app.getPath('temp')/kyclaw/未命名-<ts>.docx`、注册进文档注册表后返回 `OfficeOpenResult`。
   * v1 只接 docx（xlsx/pptx 编辑器未就绪，入口在新增标签页里隐藏）。
   */
  createBlank: 'office:create-blank'
} as const

/**
 * 单份文档上限（字节）：与 `OFFICE_PREVIEW_INPUT_MAX_BYTES` 同档 64MB
 * （`shared/office-preview.ts:139`）。超过的在 open 阶段就拒绝，不读进内存。
 */
export const OFFICE_EDITOR_MAX_BYTES = 64 * 1024 * 1024

/**
 * 注册表同时打开的文档上限（防泄漏；壳自己另有多文档上限 §7.5）。
 * 超限回 `too-many-open`，不静默淘汰（S2 没有 UI 提示淘汰；S5 再做 LRU）。
 */
export const OFFICE_MAX_OPEN_DOCUMENTS = 24

/**
 * 失败分类（渲染端据此给人话/动作；**人话口径只住 `OFFICE_EDITOR_ERROR_MESSAGES` 一处**）。
 *   - `unsupported-format`：第一步只接 .docx；
 *   - `too-large`：源文件 > 64MB；
 *   - `unreadable`：ENOENT/EACCES/EISDIR/被占用等读不出来的情况；
 *   - `write-locked` / `no-space` / `write-failed`：S3 写链路（先冻结词表）；
 *   - `conflict`：文件在打开/编辑期间被外部改过（hash 不一致）；
 *   - `cancelled`：用户取消选择器（一等结果，不是错误提示）；
 *   - `forbidden`：documentId 不存在 / 不是本窗口打开的 / 路径越权；
 *   - `too-many-open`：超过注册表上限；
 *   - `already-open-elsewhere`：同一文件已被另一个窗口打开（S3 另存为的目标冲突也用）。
 */
export const OFFICE_ERROR_CODES = [
  'unsupported-format',
  'too-large',
  'unreadable',
  'write-locked',
  'no-space',
  'write-failed',
  'conflict',
  'cancelled',
  'forbidden',
  'too-many-open',
  'already-open-elsewhere'
] as const
export const officeErrorCodeSchema = z.enum(OFFICE_ERROR_CODES)
export type OfficeErrorCode = z.infer<typeof officeErrorCodeSchema>

/** 分类 → 中文人话（主进程回包与渲染端提示共用；不回绝对路径/errno 细节给界面之外的地方） */
export const OFFICE_EDITOR_ERROR_MESSAGES: Readonly<Record<OfficeErrorCode, string>> = {
  'unsupported-format': '第一步只支持 .docx 文件',
  'too-large': '这个文件太大（超过 64MB），当前版本打不开',
  unreadable: '读不了这个文件：它可能已损坏、无权限，或不是普通文件',
  'write-locked': '文件被其他程序占用，可以先另存为再替换',
  'no-space': '磁盘空间不足，保存失败',
  'write-failed': '保存失败，修改仍然留在编辑器里',
  conflict: '文件在打开后被其他程序改过，需要先决定怎么处理',
  cancelled: '已取消',
  forbidden: '这个文档不属于当前窗口（或已关闭），不能访问',
  'too-many-open': '同时打开的文档太多，请先关闭一些再打开新的',
  'already-open-elsewhere': '这个文件已在另一个窗口打开'
}

/**
 * 注册表对外暴露的文档信息（**只读回包字段**，不含真实路径与 owner）。
 * `displayPath` 仅供界面展示：选择器给绝对路径，会话入口给相对路径。
 */
export const officeDocumentInfoSchema = z.strictObject({
  /** 主进程随机生成的不透明 id（同一 realpath 只发一个） */
  documentId: z.string().min(1),
  /** 文件名（标签标题） */
  displayName: z.string().min(1),
  /** 仅供显示：绝对路径或会话相对路径 */
  displayPath: z.string().min(1),
  /**
   * 主进程 realpath 归一后的**绝对路径**（只读回包字段）。
   *
   * 用途只有"匹配/展示"：S4 把聊天交付卡/右侧预览与已开标签对上同一个文件、去重提示都用它。
   * **安全红线：它绝不作授权/读写参数**——`office:read` / `office:save` 只认 `documentId`，
   * 路径授权（选择器 / 会话根 containment）只发生在主进程自己的解析里。
   */
  absolutePath: z.string().min(1),
  /** 最近一次读/写后的字节数 */
  size: z.number().int().nonnegative(),
  /** 最近一次读/写后的 mtime（ms） */
  mtimeMs: z.number().nonnegative(),
  /** 最近一次读/写内容的 sha256（冲突判据的权威） */
  sha256: z.string().min(1),
  /** 只读打开（会话入口可传；第一步编辑器未接，先如实带出） */
  readOnly: z.boolean()
})
export type OfficeDocumentInfo = z.infer<typeof officeDocumentInfoSchema>

/** 失败回包：`code` 分类 + 可直接显示的人话 */
export const officeFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: officeErrorCodeSchema,
  message: z.string().min(1)
})
export type OfficeFailure = z.infer<typeof officeFailureSchema>

/**
 * `office:open-dialog` / `office:open-from-session` 的回包：
 *   - `ok:true`：文档信息 + `alreadyOpen`（同 realpath 已在注册表里 → 壳只激活既有标签）；
 *   - `ok:false`：分类失败（取消 = `code:'cancelled'`，不当异常）。
 */
export const officeOpenResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    document: officeDocumentInfoSchema,
    alreadyOpen: z.boolean()
  }),
  officeFailureSchema
])
export type OfficeOpenResult = z.infer<typeof officeOpenResultSchema>

/**
 * `office:read` 的回包：字节（Uint8Array 过结构化克隆，不转 base64）+ **重读后的**文档信息。
 * 读的当口文件在变/超限/越权 → `ok:false` 分类失败（不交半截快照）。
 */
export const officeReadResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    document: officeDocumentInfoSchema,
    bytes: z.instanceof(Uint8Array)
  }),
  officeFailureSchema
])
/**
 * 类型手写而不是从 schema 推导：TS 6 的 typed array 带 ArrayBufferLike 泛型，
 * zod 的 `instanceof(Uint8Array)` 推成 `Uint8Array<ArrayBuffer>`；跨 `fs/promises` 读回来的
 * 是 `Uint8Array<ArrayBufferLike>`，两者在实现层是同一件事，别让类型细节逼着到处加断言。
 */
export type OfficeReadResult =
  { ok: true; document: OfficeDocumentInfo; bytes: Uint8Array } | OfficeFailure

/** `office:config` 的回包（壳建 iframe / 显示上限用） */
export const officeConfigSchema = z.strictObject({
  /** 面的完整 URL：preview/打包 `kyclaw-office://surface/`；dev 为 `<vite origin>/office.html` */
  surfaceUrl: z.string().min(1),
  /** 面的 origin（`http(s)` 取 URL.origin；自定义协议原样） */
  surfaceOrigin: z.string().min(1),
  maxBytes: z.number().int().positive(),
  maxOpenDocuments: z.number().int().positive()
})
export type OfficeConfig = z.infer<typeof officeConfigSchema>

/** `office:open-from-session` 入参：[threadId, 相对会话根的路径, readOnly?] */
export const officeOpenFromSessionArgsSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.boolean().optional()
])

/** `office:read` / `office:release` 入参：[documentId] */
export const officeDocumentIdArgsSchema = z.tuple([z.string().min(1)])

/** `office:config` / `office:open-dialog` 入参：空 */
export const officeNoArgsSchema = z.tuple([])

/**
 * `office:create-blank` 入参：`[{ kind: 'docx' }]`（task-80）。
 * v1 只允许 docx；别的 kind 由 handler 按 `unsupported-format` 拒绝（不做幽灵格式）。
 */
export const officeCreateBlankArgsSchema = z.tuple([z.strictObject({ kind: z.literal('docx') })])
export type OfficeCreateBlankInput = z.infer<typeof officeCreateBlankArgsSchema>[0]

/** 面常量：与 `src/main/office-protocol.ts` 的 OFFICE_SCHEME / OFFICE_HOST 一致（单测钉住） */
export const OFFICE_SURFACE_ORIGIN = 'kyclaw-office://surface'
export const OFFICE_SURFACE_URL = `${OFFICE_SURFACE_ORIGIN}/`
/** dev 下 Vite 的第二个 HTML 入口（与 electron.vite.config.ts 的 input 一致） */
export const OFFICE_DEV_SURFACE_PATH = '/office.html'

/**
 * 纯函数：由主窗口的 dev URL（`ELECTRON_RENDERER_URL`）算隔离面 URL 与 origin。
 * 非 http(s) / 没给 → preview/打包口径（`kyclaw-office://surface/`）。
 */
export function officeSurfaceUrls(rendererUrl?: string): {
  surfaceUrl: string
  surfaceOrigin: string
} {
  if (rendererUrl !== undefined && rendererUrl !== '') {
    try {
      const dev = new URL(OFFICE_DEV_SURFACE_PATH, rendererUrl)
      if (dev.protocol === 'http:' || dev.protocol === 'https:') {
        return { surfaceUrl: dev.href, surfaceOrigin: dev.origin }
      }
    } catch {
      // 畸形 dev URL 按 preview 口径兜底（不猜）
    }
  }
  return { surfaceUrl: OFFICE_SURFACE_URL, surfaceOrigin: OFFICE_SURFACE_ORIGIN }
}

/**
 * 纯函数：主窗口的 `will-frame-navigate` 判断——**子 frame** 只允许 Office 隔离面内部导航。
 *
 * 允许：
 *   - 面的文档本身（preview/打包 `kyclaw-office://surface/*`；dev 同源 `/office.html`，
 *     允许 query/hash，Vite 整页重载会带）；
 *   - `about:blank` / `about:srcdoc`：初始空文档与既有 HTML 预览的 `srcDoc`（无网络、无脚本面，
 *     不是外请通道；拦了反而打断既有预览）。
 * 主 frame 不经过这个判断（调用方先看 `isMainFrame`），不受影响。
 */
export function isAllowedOfficeFrameNavigation(url: string, rendererUrl?: string): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true

  const { surfaceUrl } = officeSurfaceUrls(rendererUrl)
  if (surfaceUrl.startsWith('http:') || surfaceUrl.startsWith('https:')) {
    let target: URL
    let devSurface: URL
    try {
      target = new URL(url)
      devSurface = new URL(surfaceUrl)
    } catch {
      return false
    }
    return target.origin === devSurface.origin && target.pathname === OFFICE_DEV_SURFACE_PATH
  }

  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  return target.protocol === 'kyclaw-office:' && target.host === 'surface'
}

/**
 * S3 保存合同（S3 落地：`office:save` / `office:save-as` 已注册）。
 * `expectedSha256` = 壳上次已知的磁盘内容 hash；主进程写前比对它（冲突检测的权威），
 * 只有磁盘内容仍是这个版本才允许覆盖 —— 发现外部改动回 `conflict` + 磁盘版本三选一。
 */
export const officeSaveArgsSchema = z.tuple([
  z.strictObject({
    documentId: z.string().min(1),
    /** 壳上次已知的磁盘内容 hash；只有相同才允许覆盖（冲突检测的权威） */
    expectedSha256: z.string().min(1).optional(),
    bytes: z.instanceof(Uint8Array)
  })
])

export const officeSaveAsArgsSchema = z.tuple([
  z.strictObject({
    documentId: z.string().min(1),
    bytes: z.instanceof(Uint8Array),
    suggestedName: z.string().min(1).optional()
  })
])

/**
 * 类型手写而不是从 schema 推导：TS 6 的 typed array 带 ArrayBufferLike 泛型，
 * zod 的 `instanceof(Uint8Array)` 推成 `Uint8Array<ArrayBuffer>`；壳/面里流过的字节
 * （fs 读、IPC 结构化克隆、ArrayBuffer 视图）都是同一件事，别让类型细节逼着到处断言。
 * schema 仍负责运行时形状校验（主进程入参闸门）。
 */
export interface OfficeSaveRequest {
  documentId: string
  expectedSha256?: string
  bytes: Uint8Array
}

export interface OfficeSaveAsRequest {
  documentId: string
  bytes: Uint8Array
  suggestedName?: string
}

/** 磁盘上当前那份内容的版本（冲突三选一时回给壳） */
export const officeDiskVersionSchema = z.strictObject({
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().min(1),
  size: z.number().int().nonnegative()
})

/** `office:save` 的回包（S3）：成功给新的 stat/hash；失败给分类 + 可选磁盘版本 */
export const officeSaveResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    documentId: z.string().min(1),
    mtimeMs: z.number().nonnegative(),
    sha256: z.string().min(1),
    size: z.number().int().nonnegative(),
    savedAt: z.number().nonnegative()
  }),
  z.strictObject({
    ok: z.literal(false),
    code: officeErrorCodeSchema,
    message: z.string().min(1),
    disk: officeDiskVersionSchema.optional()
  })
])
export type OfficeSaveResult = z.infer<typeof officeSaveResultSchema>

/**
 * `office:save-as` 的回包（S3）：成功 = 新落点 + **重定向后的文档信息**
 * （`documentId` 不变，`displayName/displayPath/absolutePath/size/mtime/sha` 换成新文件），
 * 壳据此更新标签标题/路径与后续保存的基线；失败形状与 `office:save` 相同。
 */
export const officeSaveAsResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    document: officeDocumentInfoSchema,
    mtimeMs: z.number().nonnegative(),
    sha256: z.string().min(1),
    size: z.number().int().nonnegative(),
    savedAt: z.number().nonnegative()
  }),
  z.strictObject({
    ok: z.literal(false),
    code: officeErrorCodeSchema,
    message: z.string().min(1),
    disk: officeDiskVersionSchema.optional()
  })
])
export type OfficeSaveAsResult = z.infer<typeof officeSaveAsResultSchema>

// ---------------------------------------------------------------------------------------------
// M3-S5：退出确认（S5-1 是主进程 plumbing；壳侧对话框/保存全部是 S5-2）
//
// 分工：**脏真相在壳**（`office-save-machine` 的 editSeq ≠ savedSeq），主进程只持一个计数快照
// 用于"退出时要不要问"的快速判空，以及一个请求-应答状态机。真退出/真关窗前主进程发
// `office:quit-request`，壳依次保存后回 `office:quit-result`；主进程不能自己保存
// （文档内容只在渲染端的 iframe 里）。
// ---------------------------------------------------------------------------------------------

/**
 * `office:dirty-state` 入参：[count]。
 * 只传计数——文档 id / 内容 / 路径都不过这条通道；计数为 0 时主进程同步放行退出，
 * 非 0 才去问壳（壳的应答才是权威：保存失败时壳回 `cancelled`）。
 */
export const officeDirtyStateArgsSchema = z.tuple([z.number().int().nonnegative()])

/**
 * `office:quit-request` 的推送载荷（主进程 → 壳）。
 * `requestId` 把回包和这一次请求对上（防伪造/过期回包）；`reason` 区分两条入口
 * （`quit` = 托盘退出 / app.quit；`close` = 点 X 且偏好 quit / 托盘不可用——这条路上
 * renderer 在 before-quit 之前就可能没了，所以必须在 close 放行前问）。
 */
export const officeQuitRequestPayloadSchema = z.strictObject({
  requestId: z.string().min(1),
  reason: z.enum(['quit', 'close']),
  dirtyCount: z.number().int().nonnegative()
})
export type OfficeQuitRequestPayload = z.infer<typeof officeQuitRequestPayloadSchema>

/**
 * 壳对退出请求的应答：
 *   - `saved`：全部未保存文档都保存成功 → 放行（主进程立"正在退出"标记后退出/关窗）；
 *   - `discarded`：用户明确放弃修改 → 同样放行；
 *   - `cancelled`：用户取消，**或任一保存失败停在失败项** → 不退出、不关窗（窗口原样保留，
 *     dirty 保持；主进程超时/拿不到壳也按这一档处理）。
 */
export const OFFICE_QUIT_ACTIONS = ['saved', 'discarded', 'cancelled'] as const
export const officeQuitActionSchema = z.enum(OFFICE_QUIT_ACTIONS)
export type OfficeQuitAction = z.infer<typeof officeQuitActionSchema>

/** `office:quit-result` 的回包形状 */
export const officeQuitResultSchema = z.strictObject({
  requestId: z.string().min(1),
  action: officeQuitActionSchema
})
export type OfficeQuitResult = z.infer<typeof officeQuitResultSchema>

/** `office:quit-result` 入参：[result]（主进程按 sender.id + requestId 双匹配后采信） */
export const officeQuitResultArgsSchema = z.tuple([officeQuitResultSchema])
