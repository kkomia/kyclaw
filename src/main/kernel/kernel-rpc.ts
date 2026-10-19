/**
 * B3.1a：内核一元 RPC（Connection 的 `/api` 通道）。
 *
 * 线格式（实测，rc.2）：
 *   POST /api/<endpoint>
 *   { "type": "client-request", "rpcId": "<uuid>", "method": "<endpoint>", "payload": { "args": {…} } }
 *   → { "type": "server-response", "rpcId": "<同一个>", "result": {"ok":true,"value":…} | {"ok":false,"error":{…}} }
 *
 * 所有调用都带 API Peer cookie（不出现 renderer 帧，也不写日志）。
 */
import { randomUUID } from 'node:crypto'

interface RpcEnvelope {
  type?: string
  rpcId?: string
  result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
}

export class KernelRpcClient {
  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string
  ) {}

  async call<T>(
    endpoint: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<T> {
    const rpcId = randomUUID()
    const response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      ...(signal === undefined ? {} : { signal })
    })
    if (!response.ok) {
      throw new Error(`kernel rpc: ${endpoint} returned HTTP ${String(response.status)}`)
    }
    const envelope = (await response.json()) as RpcEnvelope
    if (envelope.type !== 'server-response')
      throw new Error(`kernel rpc: ${endpoint} is not a server-response`)
    if (envelope.rpcId !== rpcId) throw new Error(`kernel rpc: ${endpoint} rpcId mismatch`)
    const result = envelope.result
    if (result === undefined) throw new Error(`kernel rpc: ${endpoint} has no result`)
    if (result.ok !== true) {
      const code = result.error?.code ?? 'unknown'
      const message = result.error?.message ?? 'unknown error'
      throw new Error(`kernel rpc: ${endpoint} failed (${code}): ${message}`)
    }
    return result.value as T
  }
}
