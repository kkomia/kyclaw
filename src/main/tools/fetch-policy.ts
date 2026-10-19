import { isIP } from 'node:net'

/** 重定向的跳数上限（与 fetch 规范里 `redirect: 'follow'` 的上限一致：20 跳） */
export const FETCH_MAX_REDIRECTS = 20

export const FETCH_ALLOW_HOSTS_ENV = 'KYCLAW_FETCH_ALLOW_HOSTS'

/** 解析主机名的等待上限（毫秒）：解析不动就当"解析不出来"（fail closed） */
const DNS_TIMEOUT_MS = 3000

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

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof code === 'string' && code !== '') return code
    return error.message
  }
  return String(error)
}
