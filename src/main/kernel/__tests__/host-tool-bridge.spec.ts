// @vitest-environment node
/**
 * B2：HostToolBridge（D2）= main 内回环 HTTP + 每次启动随机 token。
 * 只验传输与鉴权；不接业务、不启动内核。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { startHostToolBridge, type HostToolBridge } from '../host-tool-bridge'

let bridge: HostToolBridge | null = null

afterEach(async () => {
  await bridge?.close()
  bridge = null
})

async function post(url: string, token: string | null, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  })
}

describe('HostToolBridge：回环 HTTP + 随机 token', () => {
  it('每次启动 token 随机且不同；无 token 401；正确 token 200', async () => {
    bridge = await startHostToolBridge({
      handler: async (request) => ({ echoed: request.body })
    })
    const first = bridge.token
    expect(first).toMatch(/^[A-Za-z0-9_-]{30,}$/)

    expect(new URL(bridge.url).hostname).toBe('127.0.0.1')
    expect(await (await post(bridge.url, null, { ping: 1 })).status).toBe(401)
    expect(await (await post(bridge.url, 'wrong-token', { ping: 1 })).status).toBe(401)

    const ok = await post(bridge.url, first, { ping: 1 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, result: { echoed: { ping: 1 } } })

    // 第二次启动的 token 不同
    const second = await startHostToolBridge({ handler: async () => null })
    expect(second.token).not.toBe(first)
    await second.close()
  })

  it('handler 抛错 → 500（错误不穿透到 main）；非 POST → 405；坏 JSON → 400', async () => {
    bridge = await startHostToolBridge({
      handler: async () => {
        throw new Error('boom')
      }
    })
    const failed = await post(bridge.url, bridge.token, {})
    expect(failed.status).toBe(500)
    expect(await failed.json()).toMatchObject({ ok: false, error: 'boom' })

    const get = await fetch(bridge.url, { method: 'GET' })
    expect(get.status).toBe(405)

    const bad = await fetch(bridge.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(bad.status).toBe(400)
  })

  it('close 之后端口不再可连（不泄漏监听）', async () => {
    const local = await startHostToolBridge({ handler: async () => ({}) })
    const url = local.url
    await local.close()
    await expect(post(url, local.token, {})).rejects.toThrow()
  })
})
