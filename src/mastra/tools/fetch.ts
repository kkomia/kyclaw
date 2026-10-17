/**
 * fetch 工具：发起任意 HTTP(S) 请求（round28 模块 1 的"网络请求"能力）。
 *
 * 能力面：GET / POST（method / headers / body 透传）、超时、重定向跟随（逐跳校验 + 最终地址回显）、
 * **阅读模式（round 45）**：`mode: 'reader'` 时改走 Jina Reader（`{阅读端点}/{url}`）拉干净正文。
 * 契约与取舍：
 *   - **非 2xx 也把状态码 + 正文交给模型**（404 的页面/JSON 是排障信息，不是异常）；
 *     网络层错误（DNS、拒绝连接、超时）才抛中文人话错误。
 *   - **阅读模式（round 45）**：只支持 GET；配了 Jina Key 就带 `Authorization: Bearer`（升配额），
 *     没配就走免费档。它失败时给人话 + "可以直接用默认模式抓原始内容"的出口（默认模式行为一字不动）。
 *   - **无 save_to**：正文最多读 1MB（多的截停，防把内存/上下文撑爆）；文本类回传正文
 *     （超过 64KB 首尾保留），二进制类只回元信息 —— 把 PNG 的字节塞给模型没有意义。
 *   - **有 save_to**：响应体流式落盘（走 guard 的工作区边界与审批；父目录自动建），
 *     **仅 2xx 才写**（404 页面不该以"下载成功"落地）；下载上限 100MB，超限中止并删半截。
 *   - 二进制判定：content-type 明确是文本/JSON/XML 类就按文本；否则看前 8KB 有没有 NUL；
 *     两者都不像文本就按二进制（保守：宁可少回字节，也不吐一屏乱码）。
 *   - **出站边界（round 73）**：环回 / 私网 / 链路本地（含云元数据 169.254.169.254）/ 本机名
 *     一律拒绝，且**重定向逐跳校验**（`redirect: 'manual'` 自己跟，见 requestFollowing）——
 *     否则一个网页或一份文档就能诱导模型回头去摸本机服务或内网（实测过 `redirect: 'follow'`
 *     让"公网 URL 302 到 http://127.0.0.1:…"直穿，事后只在回执里回显 `final-url:`）。
 *     域名**会解析**：解析到私网同样拒绝；解析不出来按 fail closed 处理（见 blockedTargetReason）。
 *     合法用法（用户就是要读自己机器上的服务）走白名单：设置 `network.allowLocalHosts`
 *     （经 FetchToolOptions.egress.allowHosts 现读）或环境变量 `KYCLAW_FETCH_ALLOW_HOSTS`。
 *   - **用户中止（round 73）**：`context.abortSignal` 与超时共用同一个 AbortController，
 *     但**分账**——中止回一条"已被用户中止"的回执（不是失败，也不伪装成超时）。
 *   - **内置回路不受影响**：llama 网关 / 内嵌 agent 服务都是主进程自己打 127.0.0.1（不经本工具），
 *     出站边界只管这个工具发出去的请求。
 *   - 审批仍由 guard 的 capability 分支兜底（默认问；fetch 不吃 Full access，只有显式
 *     "永久允许"规则能豁免）；出站边界是**执行层**的兜底，两者是两条独立防线。
 */
import { mkdir, open, rm } from 'node:fs/promises'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { dirname } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { WEB_SEARCH_PRESET, readerTargetUrl } from '../../shared/search'
import { clipText, formatSeconds } from './exec'
import {
  approvalSessionOf,
  needsApproval,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'

/** 默认超时（毫秒） */
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000
/** 超时上限（毫秒） */
export const FETCH_MAX_TIMEOUT_MS = 600_000
/** 无 save_to 时最多读取的响应体字节数（之后再读的截停） */
export const FETCH_READ_LIMIT_BYTES = 1024 * 1024
/** 回传给模型的正文上限（字节；超过首尾保留） */
export const FETCH_TEXT_LIMIT_BYTES = 64 * 1024
/** save_to 的下载上限（字节）：超限中止并删掉半截文件 */
export const FETCH_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** 重定向的跳数上限（与 fetch 规范里 `redirect: 'follow'` 的上限一致：20 跳） */
export const FETCH_MAX_REDIRECTS = 20

/**
 * 本机/内网白名单的环境变量（逗号或空格分隔）。设置里的 `network.allowLocalHosts` 是常规入口，
 * 这条是"设置页还没接上 / 想临时试"的逃生门；两处命中即放行。
 */
export const FETCH_ALLOW_HOSTS_ENV = 'KYCLAW_FETCH_ALLOW_HOSTS'

/** 解析主机名的等待上限（毫秒）：解析不动就当"解析不出来"（fail closed） */
const DNS_TIMEOUT_MS = 3000

/** 出站边界（round 73）：判定入口与可注入缝 */
export interface FetchEgressOptions {
  /**
   * 允许访问本机/内网地址的主机白名单（**现读**，改设置当场生效；缺省 = 一个都不放行）。
   * 形态见 hostAllowed：`example.com`（该主机所有端口）、`127.0.0.1:8080`（主机 + 端口）、
   * `*.local`（后缀通配）。
   */
  allowHosts?: () => readonly string[]
  /** 解析主机名（缺省走系统解析器；测试注入用，避免依赖真实 DNS） */
  lookup?: (host: string) => Promise<readonly string[]>
}

/** 本工具的依赖（阅读模式的端点/Key + 出站边界） */
export interface FetchToolOptions extends FetchReaderOptions {
  egress?: FetchEgressOptions
}

/** 明确按文本处理的 content-type（其余不带 charset 的类型按二进制，保守） */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'application/xhtml+xml',
  'image/svg+xml'
])

export const fetchInputSchema = z.object({
  url: z.string().min(1).describe('Request URL (http:// or https://)'),
  method: z.enum(['GET', 'POST']).optional().describe('Request method; defaults to GET'),
  headers: z.record(z.string(), z.string()).optional().describe('Request headers (optional)'),
  body: z.string().optional().describe('Request body for POST; a GET with a body is rejected'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(FETCH_MAX_TIMEOUT_MS)
    .optional()
    .describe('Timeout in milliseconds; defaults to 30000, maximum 600000'),
  save_to: z
    .string()
    .optional()
    .describe(
      'Save the response to this workspace path; parent directories are created and only 2xx responses are written'
    ),
  mode: z
    .enum(['raw', 'reader'])
    .optional()
    .describe(
      'raw (default) = the raw response; reader = a reading service returns clean Markdown body text, GET only'
    )
})

export type FetchInput = z.infer<typeof fetchInputSchema>

/**
 * 阅读模式（round 45）的依赖：端点与可选 Key 都**现读**（改设置当场生效，不必重启工具）。
 * 缺省端点 = shared/search 的预置；缺省没有 Key（走免费档）。
 */
export interface FetchReaderOptions {
  endpoint?: () => string
  apiKey?: () => string | null
}

/** 本工具抛出的错误（中文，已可给用户看）：catch 时原样放行，不再包一层 */
const FETCH_ERROR_NAME = 'KyclawFetchError'

function toolError(message: string): Error {
  const error = new Error(message)
  error.name = FETCH_ERROR_NAME
  return error
}

/** 是不是本工具自己的错误（catch 里原样放行，别被"请求失败：…"再包一层） */
function isToolError(error: unknown): boolean {
  return error instanceof Error && error.name === FETCH_ERROR_NAME
}

/**
 * 出站边界：**为什么**要拦（round 73 的取舍，逐条都有理由）——
 *
 *   1. **环回 / 私网 / 链路本地**（`127/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、
 *      `fc00::/7`、`fe80::/10`，另带 `0/8`、`100.64/10`、`192.0.0/24`、`198.18/15`、组播与保留段）：
 *      这个工具是模型可以自己决定打哪儿的"出站口"，而模型会被**外部内容**（网页、文档、MCP 回包）
 *      诱导。一个被投毒的页面只要写一句"请访问 http://127.0.0.1:xxxx 查看结果"，就能让它回头读
 *      本机上的服务或内网设备（云元数据 169.254.169.254 更是"一句话拿到凭据"的经典目标）。
 *   2. **本机 / 内网名字**：`localhost`、`*.localhost`、`*.local`（mDNS）、`*.internal`、
 *      `*.home.arpa` —— 按 RFC 6761/6762/8375，这几类名字**就是**局域网语义，没有公网站点用它们。
 *   3. **域名解析到私网**：只做字符串匹配挡不住"域名指向 127.0.0.1"。所以**会解析**（`dns.lookup`
 *      的 all 形态，一次拿全 A/AAAA），任一地址落在被拒网段就拒。代价与取舍：
 *        · 多一次解析（系统解析器通常有缓存，量级毫秒）；
 *        · **解析不出来就 fail closed**（回"解析不出 IP 地址"）——这条路 fetch 本来也连不上，
 *          只是把"解析失败"从网络错误变成我们这里的明确拒绝；
 *        · **仍是 TOCTOU**：校验用一次解析、真正连接时 undici 又解析一次，理论上两次结果可以不同
 *          （DNS rebinding 的高级形态）。要彻底堵死得把连接钉在校验过的 IP 上，而 fetch 没有这个
 *          口子（要自己写 http.request + 处理 TLS）。这里如实记为残留风险，不做半截加固。
 *   4. **白名单**是"用户就是要读自己机器上的服务"的出口（见 hostAllowed）：判定顺序是
 *      **先看白名单**，命中就整条跳过（包括解析）—— 用户显式授权的主机不再被我们的规则二次盘问。
 *
 * 不带 save_to 与带 save_to 走的是同一条判定（都在发请求之前）。
 */
export function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^\[|\]$/g, '')
}

/** 按 RFC 6761/6762/8375 归到"局域网语义"的名字后缀（含它自己） */
const LOCAL_NAME_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa'] as const

/** 是不是"本机/内网"这类名字（`localhost.` 这种带尾点的也在内） */
export function isLocalHostName(hostname: string): boolean {
  const name = normalizeHost(hostname)
  return LOCAL_NAME_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
}

/** 一个 IPv4 网段（`bytes` 是前 `bits` 位有意义）；回执里拼成 `<label> <ip><note>` */
interface Ipv4Range {
  readonly bytes: readonly [number, number, number, number]
  readonly bits: number
  readonly label: string
  readonly note?: string
}

/**
 * 被拒的 IPv4 网段（顺序即判定顺序：越"贴脸"的排越前，回执里的措辞越具体）。
 * `169.254.169.254`（云元数据）落在链路本地那一条里，不用单独列。
 */
const BLOCKED_IPV4: readonly Ipv4Range[] = [
  { bytes: [127, 0, 0, 0], bits: 8, label: '本机（环回）地址' },
  { bytes: [169, 254, 0, 0], bits: 16, label: '链路本地地址', note: '（云元数据服务在这个网段）' },
  { bytes: [10, 0, 0, 0], bits: 8, label: '内网地址' },
  { bytes: [172, 16, 0, 0], bits: 12, label: '内网地址' },
  { bytes: [192, 168, 0, 0], bits: 16, label: '内网地址' },
  {
    bytes: [100, 64, 0, 0],
    bits: 10,
    label: '运营商级 NAT 地址',
    note: '（Tailscale 这类组网也用这一段）'
  },
  { bytes: [0, 0, 0, 0], bits: 8, label: '本机地址', note: '（0.0.0.0/8）' },
  { bytes: [192, 0, 0, 0], bits: 24, label: '保留地址', note: '（192.0.0.0/24）' },
  { bytes: [198, 18, 0, 0], bits: 15, label: '保留地址', note: '（基准测试网段）' },
  { bytes: [224, 0, 0, 0], bits: 4, label: '组播地址' },
  { bytes: [240, 0, 0, 0], bits: 4, label: '保留地址', note: '（240/4）' }
]

/** 这个 IP 在被拒网段里吗？在就回一句**人话**原因（回执直接用），不在回 null */
export function blockedIpReason(ip: string): string | null {
  const v4 = ipv4Bytes(ip)
  if (v4 !== null) return blockedIpv4Reason(v4)

  const v6 = ipv6Bytes(ip)
  if (v6 === null) return `认不出的地址写法（${ip}）`

  // IPv4-mapped（::ffff:a.b.c.d）：按内嵌的那个 v4 判
  if (v6.subarray(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return blockedIpv4Reason([
      v6[12] as number,
      v6[13] as number,
      v6[14] as number,
      v6[15] as number
    ])
  }
  const label = blockedIpv6Label(v6)
  return label === null ? null : `${label} ${ip}`
}

function blockedIpv4Reason(bytes: readonly number[]): string | null {
  for (const range of BLOCKED_IPV4) {
    if (inIpv4Range(bytes, range)) {
      return `${range.label} ${bytes.join('.')}${range.note ?? ''}`
    }
  }
  return null
}

function blockedIpv6Label(bytes: Uint8Array): string | null {
  if (bytes.every((byte) => byte === 0)) return '未指定地址'
  if (bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1)
    return '本机（环回）地址'
  if (((bytes[0] as number) & 0xfe) === 0xfc) return '内网地址（唯一本地地址 fc00::/7）'
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80)
    return '链路本地地址（fe80::/10）'
  if (bytes[0] === 0xff) return '组播地址'
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return '保留地址（文档网段 2001:db8::/32）'
  }
  return null
}

/** 前 `bits` 位一致即命中（`bits` 不是 8 的倍数时按位判，172.16/12 靠它） */
function inIpv4Range(bytes: readonly number[], range: Ipv4Range): boolean {
  let remaining = range.bits
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const take = Math.min(8, remaining)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    const value = (bytes[index] as number) & mask
    if (value !== ((range.bytes[index] as number) & mask)) return false
    remaining -= take
  }
  return true
}

/** `a.b.c.d` → 4 个字节；不是点分四段就回 null */
function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

/** `::` 缩写与末尾内嵌 IPv4 都认；认不出回 null（调用方按"认不出即拒"处理） */
function ipv6Bytes(raw: string): Uint8Array | null {
  const text = (raw.split('%')[0] ?? '').trim().toLowerCase()
  if (text === '' || !text.includes(':')) return null

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = parseIpv6Groups(halves[0] ?? '')
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1] ?? '') : []
  if (head === null || tail === null) return null
  if (halves.length === 1 && head.length !== 8) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 && missing < 0) return null

  const groups =
    halves.length === 1 ? head : [...head, ...new Array<number>(missing).fill(0), ...tail]
  const bytes = new Uint8Array(16)
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff
    bytes[index * 2 + 1] = group & 0xff
  })
  return bytes
}

/** 一段 IPv6（无 `::`）→ 16 位一组；组里可以带点分 IPv4（如 `::ffff:127.0.0.1`） */
function parseIpv6Groups(part: string): number[] | null {
  if (part === '') return []
  const groups: number[] = []
  for (const group of part.split(':')) {
    if (group.includes('.')) {
      const v4 = ipv4Bytes(group)
      if (v4 === null) return null
      groups.push(
        ((v4[0] as number) << 8) | (v4[1] as number),
        ((v4[2] as number) << 8) | (v4[3] as number)
      )
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    groups.push(Number.parseInt(group, 16))
  }
  return groups
}

/**
 * 白名单命中判定（用户显式授权的那些"就是要读本机/内网"的主机）：
 *   - `example.com` —— 该主机名的**所有端口**；
 *   - `127.0.0.1:8080` —— 只放行这个主机 + 端口（IPv6 写 `[::1]:8080` 或 `::1`）；
 *   - `*.local` —— 后缀通配（`nas.local` 命中，`local` 自己不命中）。
 * 大小写不敏感、忽略尾部点；空串条目忽略。
 */
export function hostAllowed(url: URL, allow: readonly string[]): boolean {
  const host = normalizeHost(url.hostname)
  if (host === '') return false
  return allow.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/\.+$/, '')
    if (entry === '') return false
    const withPort = /^(\[.+\]|[^:]+):(\d+)$/.exec(entry)
    if (withPort !== null) {
      return normalizeHost(withPort[1] as string) === host && effectivePort(url) === withPort[2]
    }
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1))
    return normalizeHost(entry) === host
  })
}

/** URL 的生效端口（默认端口在 URL 里是空串，白名单要能写 `host:80`） */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * 这个地址能不能出站：`null` = 放行，否则是一句人话原因（回执直接用）。
 * 判定顺序 = 白名单 → 名字 → 字面 IP → 解析（见文件头注的四条）。
 */
export async function blockedTargetReason(
  url: URL,
  allow: readonly string[],
  lookup: (host: string) => Promise<readonly string[]>
): Promise<string | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `不支持的协议（${url.protocol}//）`
  }
  if (hostAllowed(url, allow)) return null

  const host = normalizeHost(url.hostname)
  if (host === '') return '没有主机名'
  if (isLocalHostName(host)) return `本机/内网域名（${host}）`
  if (isIP(host) !== 0) return blockedIpReason(host)

  let addresses: readonly string[]
  try {
    addresses = await withTimeout(lookup(host), DNS_TIMEOUT_MS)
  } catch (error) {
    return `域名 ${host} 解析不出 IP 地址（${detailOf(error)}）`
  }
  if (addresses.length === 0) return `域名 ${host} 解析不出 IP 地址`
  for (const address of addresses) {
    const reason = blockedIpReason(address)
    if (reason !== null) return `域名 ${host} 解析到${reason}`
  }
  return null
}

/** 系统解析器（一次拿全 A/AAAA；任一地址落在被拒网段就拒，见 blockedTargetReason） */
async function defaultLookup(host: string): Promise<readonly string[]> {
  const entries = await dnsLookup(host, { all: true })
  return entries.map((entry) => entry.address)
}

/** 给解析加一道时间闸：解析不动就按"解析不出来"处理，不让一次 fetch 挂死在解析上 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${ms} 毫秒没有响应`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/** 现读的白名单：设置（egress.allowHosts）+ 环境变量逃生门，两处命中即放行 */
function allowHostsFor(egress: FetchEgressOptions | undefined): readonly string[] {
  const fromSettings = egress?.allowHosts?.() ?? []
  const fromEnv = (process.env[FETCH_ALLOW_HOSTS_ENV] ?? '')
    .split(/[,\s]+/)
    .filter((entry) => entry !== '')
  return [...fromSettings, ...fromEnv]
}

/** 被出站边界拦下时的错误（人话 + 为什么 + 下一步；见文件头注） */
function blockedError(target: URL, reason: string, hop: number): Error {
  const head =
    hop === 0
      ? `fetch 已阻断：目标 ${target.href} 是${reason}，请求没有发出去。`
      : `fetch 已阻断：请求被重定向到 ${target.href}（第 ${hop} 跳），那是${reason}，已停止跟随。`
  return toolError(
    [
      head,
      '为什么：fetch 默认只访问公网地址 —— 本机（localhost / 127.0.0.1）、内网与链路本地地址一律挡下，' +
        '否则一个网页或一份文档就能诱导它回头去读你机器上的服务或内网设备。',
      `下一步：要读本机服务请改用 bash 跑 curl（例如 curl "${target.href}"，会先请你审批）；` +
        `确实要让 fetch 直连这个主机，设环境变量 ${FETCH_ALLOW_HOSTS_ENV}=${normalizeHost(target.hostname)}` +
        `（它等价于把这台主机写进本机/内网白名单）。`
    ].join('\n')
  )
}

/** 用户中止的回执（与 bash 同一口径：明说是"被中止"，不伪装成失败，也不伪装成超时） */
function abortedReceipt(href: string): string {
  return [
    `fetch 已被用户中止：请求已取消（${href}）`,
    '（这是你点了停止，不是这个地址或网络的问题；要接着取它就重新发起。）'
  ].join('\n')
}

/**
 * `options.reader` = 阅读模式的端点/Key；`options.egress` = 出站边界。
 * 两者都**现读**（改设置当场生效）；`egress` 不传 = 没有白名单 + 系统解析器。
 * 注意 `options` 本身就是 FetchReaderOptions 的超集：老调用点 `createFetchTool(ctx, {endpoint})`
 * 一字不用改。
 */
export async function createFetchTool(
  ctx: ToolContext,
  options: FetchToolOptions = {}
): Promise<Tool<FetchInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  const reader: FetchReaderOptions = options

  return createTool({
    id: 'fetch',
    description:
      // round 70 瘦身：阅读模式的机制（Markdown、只支持 GET）在 mode 字段上写过了，顶层只说"什么时候用它"
      // round 73：出站边界加到描述里 —— 模型撞上拒绝时才知道那是规则、不是网络故障，
      // 并且知道出口在哪（bash/curl 或白名单），不会换个写法反复重试
      'Make an HTTP(S) request (GET/POST, optional headers and body); returns status and body, non-2xx included. ' +
      'A binary or very large response returns metadata only, unless save_to downloads it to that workspace path. ' +
      'Read a page as clean body text, without navigation or ads, with mode: "reader". ' +
      'Refuses localhost, private and link-local addresses (and redirects to them), unless the host is whitelisted; ' +
      'to read a service on this machine use bash with curl instead.',
    inputSchema: fetchInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'fetch', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const url = parseHttpUrl(input.url)
      const method = input.method ?? 'GET'
      if (method === 'GET' && input.body !== undefined) {
        throw toolError('fetch 失败：GET 请求不能带 body（要发数据请用 method: "POST"）')
      }
      const useReader = input.mode === 'reader'
      if (useReader && method !== 'GET') {
        throw toolError('fetch 失败：阅读模式（mode: "reader"）只支持 GET')
      }

      // save_to 先解析：批了再打的目标写不进去就整单失败（fail closed，不打无意义的请求）
      const saveAbs =
        input.save_to === undefined || input.save_to.trim() === ''
          ? null
          : toolTarget(ctx, input.save_to, sessionKey(context)).abs
      if (saveAbs !== null) {
        const existing = await statOrNull(ctx, saveAbs)
        if (existing?.isDirectory() === true) {
          throw toolError(`fetch 失败：save_to 指向一个目录（${input.save_to}），请给文件路径`)
        }
      }

      // 阅读模式：请求打的是阅读服务（`{端点}/{原 url}`），可选 Jina Key 只进 Authorization 头
      const readerKey = useReader ? (reader.apiKey?.() ?? null) : null
      const requestUrl = useReader
        ? parseHttpUrl(
            readerTargetUrl(reader.endpoint?.() ?? WEB_SEARCH_PRESET.readerEndpoint, url.href)
          )
        : url
      const requestHeaders = useReader
        ? {
            accept: 'text/plain',
            ...(readerKey === null || readerKey === ''
              ? {}
              : { authorization: `Bearer ${readerKey}` }),
            ...input.headers
          }
        : input.headers

      const timeoutMs = input.timeout_ms ?? FETCH_DEFAULT_TIMEOUT_MS
      const controller = new AbortController()
      let timedOut = false
      let userAborted = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)

      // 用户点停止（round 73）：与超时共用同一个 controller（唯一的中止出口），但**分账**——
      // 回执一个说"被用户中止"、一个说"超时"，两件事不能混着报
      const outerSignal = context.abortSignal
      if (outerSignal?.aborted === true) {
        // 信号在请求发出之前就响了：一个字节都不发（fetch 的副作用可能就是"改了点什么"）
        clearTimeout(timer)
        return abortedReceipt(requestUrl.href)
      }
      const onAbort = (): void => {
        userAborted = true
        controller.abort()
      }
      outerSignal?.addEventListener('abort', onAbort, { once: true })

      try {
        let hop: FetchHop
        try {
          hop = await requestFollowing({
            start: requestUrl,
            method,
            headers: requestHeaders,
            body: useReader ? undefined : input.body,
            signal: controller.signal,
            allow: allowHostsFor(options.egress),
            lookup: options.egress?.lookup ?? defaultLookup
          })
        } catch (error) {
          // 中止不是失败：回一条说清"被谁停的"的回执（与 bash / git / render_ppt 同一口径）
          if (userAborted) return abortedReceipt(requestUrl.href)
          // 出站边界的拒绝已经是中文人话 + 下一步：原样放行，不再包成"请求失败"
          if (isToolError(error)) throw error
          const failure = fetchFailure(error, timedOut, requestUrl.href, timeoutMs)
          // 阅读模式失败给出口：默认模式一字未改，随时可以退回去抓原始内容
          if (useReader) {
            throw toolError(`${failure.message}；可以改用默认模式（不带 mode）抓原始内容`)
          }
          throw failure
        }
        const response = hop.response

        if (useReader && !response.ok) {
          throw toolError(
            `阅读模式抓取失败：HTTP ${response.status}${response.statusText.trim() === '' ? '' : ` ${response.statusText.trim()}`}` +
              `（${url.href}）；可以改用默认模式（不带 mode）抓原始内容`
          )
        }

        try {
          return saveAbs === null
            ? await readResponseText(response, requestUrl.href, hop.finalHref)
            : await downloadResponse(response, saveAbs, input.save_to ?? '', requestUrl.href)
        } catch (error) {
          if (userAborted) return abortedReceipt(requestUrl.href)
          if (isToolError(error)) throw error
          if (isAbortLike(error) || timedOut) {
            throw fetchFailure(error, timedOut, requestUrl.href, timeoutMs)
          }
          throw toolError(`请求失败：${detailOf(error)}（${requestUrl.href}）`)
        }
      } finally {
        clearTimeout(timer)
        outerSignal?.removeEventListener('abort', onAbort)
      }
    }
  })
}

function parseHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw toolError(`fetch 失败：不是合法的 URL（${raw}）`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw toolError(`fetch 失败：只支持 http:// 与 https://，收到 ${url.protocol}//`)
  }
  return url
}

/**
 * 无 save_to：读一段正文回给模型（文本回正文，二进制回元信息）。
 * `finalHref` 是**跟完重定向之后**真正落到的地址（与请求地址不同才回显 `final-url:`）。
 */
async function readResponseText(
  response: Response,
  requestedHref: string,
  finalHref: string
): Promise<string> {
  const contentType = response.headers.get('content-type')
  const { bytes, more } = await readCapped(response, FETCH_READ_LIMIT_BYTES)

  const header = [
    statusLine(response),
    ...(contentType === null ? [] : [`content-type: ${contentType}`]),
    ...(finalHref === requestedHref || finalHref === '' ? [] : [`final-url: ${finalHref}`]),
    ''
  ]

  if (sniffBinary(contentType, bytes)) {
    const size = bytes.length
    const suffix = more ? `（响应更大，只读取了前 ${size} 字节）` : ''
    return [
      ...header,
      `[二进制响应（${contentType ?? '类型未知'}，已读取 ${size} 字节）${suffix}；未回传正文 —— 要保存请带 save_to]`
    ].join('\n')
  }

  const text = bytes.toString('utf8')
  const clipped = clipText(text, FETCH_TEXT_LIMIT_BYTES)
  const moreNote = more ? `\n[响应超出 ${FETCH_READ_LIMIT_BYTES} 字节上限，已截停]` : ''
  return [...header, clipped.text === '' ? '（空响应体）' : clipped.text + moreNote].join('\n')
}

/** 有 save_to：仅 2xx 流式落盘；非 2xx 按普通响应回状态码 + 正文 */
async function downloadResponse(
  response: Response,
  saveAbs: string,
  saveLabel: string,
  requestedHref: string
): Promise<string> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type')
    const { bytes } = await readCapped(response, FETCH_READ_LIMIT_BYTES)
    const text = sniffBinary(contentType, bytes)
      ? `[二进制响应（${contentType ?? '类型未知'}，${bytes.length} 字节）]`
      : clipText(bytes.toString('utf8'), FETCH_TEXT_LIMIT_BYTES).text || '（空响应体）'
    return [
      statusLine(response),
      ...(contentType === null ? [] : [`content-type: ${contentType}`]),
      `[非 2xx 响应：未写入 ${saveLabel}]`,
      '',
      text
    ].join('\n')
  }

  await mkdir(dirname(saveAbs), { recursive: true })
  const file = await open(saveAbs, 'w')
  let total = 0
  let overflow = false
  try {
    for await (const chunk of response.body ?? []) {
      const buffer = Buffer.from(chunk as Uint8Array)
      total += buffer.length
      if (total > FETCH_MAX_DOWNLOAD_BYTES) {
        overflow = true
        break
      }
      await file.write(buffer)
    }
  } catch (error) {
    await file.close()
    await rm(saveAbs, { force: true })
    // 超时/中止由外层统一映射成"请求超时"；其它错误给人话
    if (isAbortLike(error)) throw error
    throw toolError(`下载中断：${detailOf(error)}（${requestedHref}）`)
  }
  await file.close()

  if (overflow) {
    await rm(saveAbs, { force: true })
    throw toolError(
      `fetch 失败：响应超过 ${FETCH_MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB 下载上限，已中止并删除半截文件`
    )
  }

  const contentType = response.headers.get('content-type')
  return `已下载 → ${saveAbs}（HTTP ${response.status}，${total} 字节${contentType === null ? '' : `，${contentType}`}）`
}

/** 最多读 limit 字节；more=true 表示响应还有未读内容（被我们截停） */
async function readCapped(
  response: Response,
  limit: number
): Promise<{ bytes: Buffer; more: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { bytes: Buffer.alloc(0), more: false }

  const chunks: Buffer[] = []
  let total = 0
  let more = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buffer = Buffer.from(value)
    const room = limit - total
    if (room <= 0) {
      more = true
      await reader.cancel().catch(() => {})
      break
    }
    if (buffer.length > room) {
      chunks.push(buffer.subarray(0, room))
      total += room
      more = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(buffer)
    total += buffer.length
  }
  return { bytes: Buffer.concat(chunks), more }
}

/** content-type 与字节内容合起来的二进制判定（见文件头注） */
export function sniffBinary(contentType: string | null, bytes: Buffer): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type !== '') {
    if (type.startsWith('text/')) return false
    if (TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return false
    return true
  }
  return bytes.subarray(0, 8192).includes(0)
}

function statusLine(response: Response): string {
  const statusText = response.statusText.trim()
  return `HTTP ${response.status}${statusText === '' ? '' : ` ${statusText}`}`
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string' && code !== '') return code
    return error.message
  }
  return String(error)
}

function fetchFailure(error: unknown, timedOut: boolean, href: string, timeoutMs: number): Error {
  if (timedOut) {
    return toolError(`请求超时：超过 ${formatSeconds(timeoutMs)} 秒未完成（${href}）`)
  }
  return toolError(`请求失败：${detailOf(error)}（${href}）`)
}

/** 一次请求的落点：跟完重定向之后真正拿到的那个响应 + 它落在哪个地址 */
interface FetchHop {
  response: Response
  /** 跟完重定向之后真正落到的地址（没跳就是起始地址） */
  finalHref: string
}

interface FetchHopInput {
  start: URL
  method: string
  headers: Record<string, string> | undefined
  body: string | undefined
  signal: AbortSignal
  allow: readonly string[]
  lookup: (host: string) => Promise<readonly string[]>
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 跨源重定向时该丢掉的凭据头（与 fetch 规范同口径：别把 Authorization 送到另一个源） */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

/**
 * 自己跟重定向（round 73）：**每一跳都重新过一遍出站边界**。
 *
 * 为什么不用 `redirect: 'follow'`（实测过的洞）：跟随是 undici 内部做的，我们看不到中间那一跳，
 * 于是"公网 URL 302 到 http://127.0.0.1:…"会直接落回本机、把内容带回来，事后只能在回执里
 * 补一句 `final-url:` —— 事后的回显拦不住已经发生的读取。改成 `manual` 之后每一跳都
 * `blockedTargetReason` 一次，任何一跳落到被拒地址就停住并如实回报（见 blockedError）。
 *
 * 与 `follow` 的其余口径对齐：
 *   - 跳数上限 20（与规范一致；超了报"重定向次数超过"而不是让底层抛 `fetch failed`）；
 *   - 301/302 把 POST 降成 GET、303 一律 GET、307/308 原样重放（语义口径不变）；
 *   - 跨源重定向**丢掉 Authorization / Cookie**（否则 Jina Key 这类凭据会跟着跳到别的源）。
 * 相对 Location（`/a`）按当前地址解析；看不懂的 Location 直接报错，不猜。
 */
async function requestFollowing(input: FetchHopInput): Promise<FetchHop> {
  let current = input.start
  let method = input.method
  let headers = input.headers
  let body = input.body

  for (let hop = 0; ; hop += 1) {
    const reason = await blockedTargetReason(current, input.allow, input.lookup)
    if (reason !== null) throw blockedError(current, reason, hop)

    const response = await fetch(current.href, {
      method,
      headers,
      body,
      signal: input.signal,
      redirect: 'manual'
    })
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalHref: current.href }
    }

    const location = response.headers.get('location')
    // 30x 却没有 Location：把它当终点如实回给模型（比"猜一个地址"老实）
    if (location === null || location.trim() === '') {
      return { response, finalHref: current.href }
    }
    // 这一跳的响应体不要了 —— 不排空会让连接一直挂着
    await response.body?.cancel().catch(() => undefined)

    if (hop >= FETCH_MAX_REDIRECTS) {
      throw toolError(
        `fetch 失败：重定向次数超过 ${FETCH_MAX_REDIRECTS} 次（起点 ${input.start.href}），已停止跟随`
      )
    }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw toolError(`fetch 失败：重定向给了一个看不懂的地址（${location}）`)
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== 'GET' &&
        method !== 'HEAD')
    ) {
      method = 'GET'
      body = undefined
      // 正文没了，描述这个正文的头也不能留着（与 fetch 规范里"body 变 null 就删 content-*"一致）
      headers = withoutHeaders(headers, ['content-length', 'content-type'])
    }
    if (next.origin !== current.origin) headers = withoutHeaders(headers, CREDENTIAL_HEADERS)
    current = next
  }
}

/** 去掉若干个请求头（大小写不敏感），返回新对象 —— 不改调用方给的那一份 */
function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: Iterable<string>
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const drop = new Set([...names].map((name) => name.toLowerCase()))
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (drop.has(key.trim().toLowerCase())) continue
    next[key] = value
  }
  return next
}
