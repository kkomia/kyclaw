/**
 * B3.1a：内核 API 鉴权（POC 那套）。
 *
 * 流程：`GET /connect?token=<启动令牌>&interactions=answer`
 *   → `302` + `set-cookie: dsh-auth-…`（API Peer cookie）+ `Location: ./api/remote.mux`。
 * 之后：
 *   - 一元 RPC：`POST /api/<endpoint>` 带该 cookie；
 *   - 事件流：`WS /api/remote.mux` 带该 cookie。
 *
 * D1：cookie/token 只留 main；本模块不打印它们，也不进入任何 renderer 帧。
 */
export interface KernelPeerAuth {
  /** API Peer cookie（host-only、HttpOnly；只用于 main 内的 fetch/WS） */
  readonly cookie: string
  /** 已解析为绝对 ws:// 的 mux 地址 */
  readonly muxUrl: string
}

export interface ConnectKernelPeerOptions {
  baseUrl: string
  token: string
  interactions?: 'answer' | 'none'
  timeoutMs?: number
}

export async function connectKernelPeer(
  options: ConnectKernelPeerOptions
): Promise<KernelPeerAuth> {
  const interactions = options.interactions ?? 'answer'
  const url = new URL('/connect', options.baseUrl)
  url.searchParams.set('token', options.token)
  url.searchParams.set('interactions', interactions)

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('kernel auth: timeout'))
  }, options.timeoutMs ?? 10_000)
  let response: Response
  try {
    response = await fetch(url, { redirect: 'manual', signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (response.status !== 302) {
    throw new Error(`kernel auth: /connect returned HTTP ${String(response.status)} (expected 302)`)
  }
  const location = response.headers.get('location')
  if (location === null || location === '') throw new Error('kernel auth: /connect has no Location')
  const cookies =
    (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const cookie = cookies
    .map((item) => item.split(';')[0]?.trim() ?? '')
    .filter((item) => item !== '')
    .join('; ')
  if (cookie === '') throw new Error('kernel auth: /connect returned no API cookie')

  const mux = new URL(location, new URL('/connect', options.baseUrl))
  if (mux.protocol !== 'http:')
    throw new Error(`kernel auth: unexpected mux protocol ${mux.protocol}`)
  mux.protocol = 'ws:'
  return { cookie, muxUrl: mux.toString() }
}
