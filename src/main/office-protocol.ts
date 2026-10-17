/**
 * `kyclaw-office://` 本地资源协议（M3-S1）：把隔离面的静态资源从 `out/renderer` 只读地供出来。
 *
 * 为什么要有它（而不是让 iframe 直接 loadFile）：隔离面的安全边界靠"另一个 origin"——
 * iframe 必须跑在 `kyclaw-office://surface` 上，才能和 `file://` 主窗口跨源，
 * 从而拿到独立的 CSP（`'wasm-unsafe-eval'` 只在面里）与零 preload 的权限面。
 *
 * 结构：**纯函数 + 薄 handler**
 *   - `resolveOfficeAsset` / `parseByteRange` / `officeContentType` 是纯函数（不碰 fs、不碰 Electron），
 *     单测直接打它们；
 *   - `createOfficeProtocolHandler` 只做 fs 读取与 Response 拼装，`main/index.ts` 用一行接上
 *     `protocol.handle`。
 *
 * 规则（见 .superpowers/handover/office-docx-plan.md §3.2）：
 *   - host 只认 `surface`，其余 404；
 *   - `decodeURIComponent` 之后再归一化：`..`/编码后的 `%2e%2e`/`%2f` 逃逸一律 403，
 *     不许出 `rootDir`（Windows 上大小写不敏感，containment 用同一套口径）；
 *   - 根路径（`/`、空、带 query）→ `office.html`；
 *   - MIME 按扩展名（大小写不敏感）查表；wasm 必须是 `application/wasm`（否则 streaming 编译退化）；
 *   - Range：`bytes=start-end` / `start-` / `-suffix`，命中 206 + `content-range`；
 *     无法满足时按"忽略 Range 回 200 全量"处理（与 spike 同口径，防御性收益、不做 416）；
 *   - HTML 响应带与 `src/renderer/office.html` meta **逐字一致**的 CSP 响应头；所有响应带
 *     `x-content-type-options: nosniff`；`cache-control: no-store`（wasm/字体冷读 asar 也够快）；
 *   - 错误只回文本，不回绝对路径。
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/** 自定义 scheme 名。未来如需"每文档独立 origin"，扩 host，不扩 scheme。 */
export const OFFICE_SCHEME = 'kyclaw-office'

/** 唯一的 host：`kyclaw-office://surface/…` */
export const OFFICE_HOST = 'surface'

/**
 * `protocol.registerSchemesAsPrivileged` 的 privileges（Electron 44 字段见 electron.d.ts 的
 * `Privileges`）。必须在 app ready 之前注册（Electron 硬要求），见 main/index.ts 顶层。
 *
 * `corsEnabled: false`：面的资源全是同源读取，不需要 CORS 面；`stream: true` 给大文件/字体留余地；
 * `allowServiceWorkers: false` 与服务端 worker 无关、也不给面开额外能力。
 */
export const OFFICE_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: false,
  stream: true,
  allowServiceWorkers: false
} as const

/**
 * 隔离面的 CSP：**协议响应头与 `src/renderer/office.html` 的 meta 必须逐字一致**
 * （单测双向核对，避免打包态/直开态两套口径）。这是本方案安全核心：
 *   - `'wasm-unsafe-eval'` **只在这里**出现，主 renderer 绝不放宽；
 *   - `connect-src 'self'`：面内网络外请被 CSP 封死（第二道是主进程 webRequest 拦截）。
 */
export const OFFICE_SURFACE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

/** 根路径落到的页面（第二个 HTML 入口的构建产物名，见 electron.vite.config.ts） */
const OFFICE_ROOT_PAGE = 'office.html'

/** 扩展名 → MIME（查表时先 `toLowerCase()`）。未知扩展名回落 `application/octet-stream`。 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
}

/** 解析成功：一个 rootDir 内的真实文件路径 + 其 MIME */
export interface OfficeAssetFound {
  kind: 'file'
  status: 200
  filePath: string
  contentType: string
}

/** 解析失败：只带状态码与人话原因（不回绝对路径，避免把本机目录结构透给面） */
export interface OfficeAssetError {
  kind: 'error'
  status: 400 | 403 | 404
  reason: string
}

export type OfficeAssetResolution = OfficeAssetFound | OfficeAssetError

/** 文件扩展名查 MIME（大小写不敏感；未知回落八位字节流） */
export function officeContentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 把 `rest` 归一化成 rootDir 内的相对路径（posix 风格，无前导斜杠；根路径 = `''`）。
 * 只做字符串层面的折叠：真正的逃逸由 `resolve` + containment 兜住。
 */
function normalizeRelativePath(pathname: string): string {
  // Windows 上 `\` 也是分隔符，先统一成 `/` 再折叠空段
  const segments = pathname.replace(/\\/g, '/').split('/')
  const kept: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    kept.push(segment)
  }
  return kept.join('/')
}

/** `candidate` 是否在 `root` 内（Windows 路径大小写不敏感，两边同口径比较） */
function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  if (process.platform === 'win32') {
    const lowerRoot = rootResolved.toLowerCase()
    const lowerCandidate = candidateResolved.toLowerCase()
    return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}${sep}`)
  }
  return candidateResolved === rootResolved || candidateResolved.startsWith(`${rootResolved}${sep}`)
}

/**
 * 纯函数：把 `kyclaw-office://surface/<path>` 映射到 `rootDir` 下的文件路径与 MIME。
 *
 * 只做解析与边界检查，**不碰 fs**：文件是否存在、是不是普通文件由 handler 的 stat 决定
 * （单测因此可以脱离真实目录覆盖 MIME/逃逸/host 全部规则）。
 */
export function resolveOfficeAsset(rootDir: string, rawUrl: string): OfficeAssetResolution {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'error', status: 400, reason: 'invalid url' }
  }
  if (url.protocol !== `${OFFICE_SCHEME}:`) {
    return { kind: 'error', status: 404, reason: 'unknown scheme' }
  }
  // URL 解析会把 host 小写化；这里按原样比较，非 surface 一律 404
  if (url.host !== OFFICE_HOST) {
    return { kind: 'error', status: 404, reason: 'unknown host' }
  }

  // 先解码再归一化：`%2e%2e` / `%2f` 这类编码逃逸必须在解码之后才看得见
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return { kind: 'error', status: 400, reason: 'invalid encoding' }
  }
  if (decodedPath.includes('\0')) {
    return { kind: 'error', status: 400, reason: 'invalid path' }
  }

  const relativePath = normalizeRelativePath(decodedPath)
  const filePath =
    relativePath === '' ? resolve(rootDir, OFFICE_ROOT_PAGE) : resolve(rootDir, relativePath)
  if (!isInsideRoot(rootDir, filePath)) {
    return { kind: 'error', status: 403, reason: 'forbidden' }
  }
  return { kind: 'file', status: 200, filePath, contentType: officeContentType(filePath) }
}

/** Range 命中的字节区间（含两端） */
export interface ByteRange {
  start: number
  end: number
}

/**
 * 解析单段 `Range` 请求头；不合法/越界/多段一律回落 `null`（调用方回 200 全量）。
 *
 * 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix` 三种；`size <= 0` 不接 Range。
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | null {
  if (header === null || header === undefined || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    // `bytes=-N`：最后 N 个字节
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isSafeInteger(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

export interface OfficeProtocolOptions {
  /** 资源根目录：生产/debug 都是 `join(__dirname, '../renderer')`（打包态即 asar 内 out/renderer） */
  rootDir: string
}

/** 纯文本错误响应（不暴露绝对路径） */
function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/**
 * `protocol.handle(OFFICE_SCHEME, handler)` 的 handler：只读 rootDir 下的文件并拼 Response。
 *
 * 不缓存（cache-control: no-store）：S3 起编辑器资产会是带 hash 的构建产物，冷读 asar 也够快；
 * 不做目录列表、不接 POST/其它方法（只服务 GET 语义的静态资源；非 GET 直接 404）。
 */
export function createOfficeProtocolHandler(
  options: OfficeProtocolOptions
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(404, 'not found')
    }
    const asset = resolveOfficeAsset(options.rootDir, request.url)
    if (asset.kind === 'error') {
      return textResponse(asset.status, asset.reason)
    }

    let size: number
    try {
      const info = await stat(asset.filePath)
      if (!info.isFile()) return textResponse(404, 'not found')
      size = info.size
    } catch {
      // ENOENT / EPERM / 目录 …：一律 404（不回 errno 细节）
      return textResponse(404, 'not found')
    }

    const range =
      request.method === 'GET' ? parseByteRange(request.headers.get('range'), size) : null
    let data: Buffer
    let status = 200
    try {
      // 与 spike 同口径：整文件读入再切片。Range 是防御性对齐（大字体未来分段），
      // 不是性能诉求；文件都不大（S3 的 wasm 是 30MB 级，冷读 asar 仍在 10ms 量级）。
      data = await readFile(asset.filePath)
    } catch {
      return textResponse(404, 'not found')
    }

    const headers: Record<string, string> = {
      'content-type': asset.contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes'
    }
    if (asset.contentType.startsWith('text/html')) {
      // 打包/预览态由协议响应头下同一份 CSP；dev 直开 office.html 时靠 meta（内容逐字一致）
      headers['content-security-policy'] = OFFICE_SURFACE_CSP
    }
    if (range !== null && range.start < data.length) {
      const end = Math.min(range.end, data.length - 1)
      data = data.subarray(range.start, end + 1)
      status = 206
      headers['content-range'] = `bytes ${range.start}-${end}/${size}`
    }
    headers['content-length'] = String(data.length)
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }
    return new Response(new Uint8Array(data), { status, headers })
  }
}
