#!/usr/bin/env node
'use strict'
/**
 * E2E kernel stub — 0.2.0（PB-021）：**离线、零依赖、CI 可复跑**的 DSH 内核替身。
 *
 * 它只做一件事：按 `@deepseek-ai/* 0.2.1-rc.2` 里**被宿主真实消费**的那一小段协议，
 * 回放脚本化的内核帧，让 e2e 在没有真内核快照 / 没有模型 / 没有网络时也能跑完整 UI 链路。
 *
 * 协议契约（字段来源 = 宿主代码，不是设计稿；详见
 * `.superpowers/dev-verify/20261019-0.2.0/nia/kernel-stub-contract.md`）：
 *   - 就绪：stdout 一行 `dsh web: http://127.0.0.1:<port>/?token=<token>`
 *     （`src/main/kernel/kernel-process.ts` READY_PATTERN 消费）
 *   - `GET /connect?token=…` → 302 + `set-cookie: dsh-auth-…=…` + `Location: ./api/remote.mux`
 *     （`kernel-auth.ts` 消费）
 *   - `POST /api/<endpoint>`：`{type:'client-request', rpcId, method, payload:{args}}`
 *     → `{type:'server-response', rpcId, result:{ok:true,value}}`
 *     （`kernel-rpc.ts` 消费；endpoint 面见下）
 *   - `WS /api/remote.mux`：客户端发 `{type:'open', streamId, endpoint:'session/follow', payload:{args:{request:{address:{kind:'session',sessionId}, assistantStream:true}}}}`
 *     → 服务端回 `{type:'item', streamId, value:{type:'snapshot'|'assistant-stream'|'event', …}}`
 *     （`kernel-adapter.ts` onMessage 消费；帧形状见 `sse-map.ts` KernelFollowValue）
 *
 * 启动方式与真内核完全一致：Electron-as-node 执行本文件，参数 `web --host 127.0.0.1 --port 0 --no-open`
 * （参数被忽略，端口永远由 OS 分配；token 每次随机）。
 *
 * 环境变量（全部可选；e2e harness 注入）：
 *   KYCLAW_STUB_CHUNKS             JSON 字符串数组：assistant 文本分片（默认=旧 mock 三段原文）
 *   KYCLAW_STUB_CHUNK_DELAY_MS     分片间隔 ms（默认 250，与旧 mock 的 MOCK_CHUNK_DELAY_MS 一致）
 *   KYCLAW_STUB_SCENARIO           default | error | hang（默认 default）
 *   KYCLAW_STUB_USAGE              JSON：{inputTokens,outputTokens,totalTokens}（默认 12/8/20）
 *   KYCLAW_STUB_ERROR              JSON：{code,message}（error 场景用）
 *   KYCLAW_STUB_TOOL               JSON：{name,input,result,isError?} —— 文本后补一次 tool/call + tool/result
 *                                  （**只发事件，不执行任何产品工具**：stub 不假装工具产出）
 *   KYCLAW_STUB_LOG                文件路径：追加 JSONL 事件日志（证据用：proves stub was actually used）
 *
 * 纪律：本文件不 import 产品代码、不读用户 profile、不联网、不写产品状态；只监听 127.0.0.1。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')

const DSH_WEB_READY_PREFIX = 'dsh web: '

function readJsonEnv(name, fallback) {
  const raw = process.env[name]
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    process.stderr.write(`[kernel-stub] ${name} 不是合法 JSON，忽略：${raw}\n`)
    return fallback
  }
}

const DEFAULT_CHUNKS = ['（kyclaw 离线模式）', '你好，', '我是 kyclaw。']
const rawChunks = readJsonEnv('KYCLAW_STUB_CHUNKS', DEFAULT_CHUNKS)
const CHUNKS = Array.isArray(rawChunks)
  ? rawChunks.filter((item) => typeof item === 'string')
  : DEFAULT_CHUNKS
const CHUNK_DELAY_MS = Math.max(0, Number(process.env.KYCLAW_STUB_CHUNK_DELAY_MS ?? '250') || 0)
const SCENARIO = process.env.KYCLAW_STUB_SCENARIO ?? 'default'
const USAGE = readJsonEnv('KYCLAW_STUB_USAGE', {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20
})
const ERROR = readJsonEnv('KYCLAW_STUB_ERROR', {
  code: 'TRANSPORT',
  message: 'kernel stub: scripted error turn'
})
const TOOL = readJsonEnv('KYCLAW_STUB_TOOL', null)
/** PB-004 审批事件（只发协议事件，不做任何应答/执行）：{id,toolName,callId?,reason?,decision?:{id,outcome}} */
const APPROVAL = readJsonEnv('KYCLAW_STUB_APPROVAL', null)
const RETRY_ATTEMPTS = Math.max(0, Number(process.env.KYCLAW_STUB_RETRY_ATTEMPTS ?? '0') || 0)
const RETRY_TEXT = process.env.KYCLAW_STUB_RETRY_TEXT ?? '被作废的正文。'
const LOG_FILE = process.env.KYCLAW_STUB_LOG ?? ''

const token = crypto.randomBytes(18).toString('base64url')
const cookieName = `dsh-auth-${crypto.randomBytes(8).toString('hex')}`
const cookieValue = crypto.randomBytes(18).toString('base64url')

/** @type {Map<string, {cwd: string, seq: number, streams: Set<unknown>, turn: null | {cancelled: boolean, settled: boolean, waiters: Array<() => void>}}>} */
const sessions = new Map()
/** @type {Map<string, {sessionId: string, socket: import('node:net').Socket}>} */
const streams = new Map()
let turnCounter = 0

function logStub(event, data) {
  if (LOG_FILE === '') return
  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`)
  } catch {
    // 证据日志写不了不该影响协议
  }
}

function nextSeq(session) {
  const seq = session.seq
  session.seq += 1
  return seq
}

function ensureSession(sessionId, cwd) {
  let session = sessions.get(sessionId)
  if (session === undefined) {
    session = { cwd: typeof cwd === 'string' ? cwd : process.cwd(), seq: 0, streams: new Set(), turn: null }
    sessions.set(sessionId, session)
  }
  return session
}

// ── WS 帧编码 / 解析（只服务 ws-mux.ts 的 client 侧：文本帧 + ping/pong/close） ──────────────

function encodeServerFrame(opcode, payload) {
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function sendWsText(socket, object) {
  if (socket.destroyed === true || socket.writableEnded === true) return
  try {
    socket.write(encodeServerFrame(0x1, Buffer.from(JSON.stringify(object), 'utf8')))
  } catch {
    // socket 已断：调用方下一帧自然停
  }
}

function sendItem(streamId, value) {
  const stream = streams.get(streamId)
  if (stream === undefined) return
  sendWsText(stream.socket, { type: 'item', streamId, value })
}

function broadcast(session, value) {
  for (const streamId of session.streams) sendItem(streamId, value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitCancelled(turn, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = turn.waiters.indexOf(waiter)
      if (index >= 0) turn.waiters.splice(index, 1)
      resolve()
    }, ms)
    const waiter = () => {
      clearTimeout(timer)
      resolve()
    }
    turn.waiters.push(waiter)
  })
}

// ── 一轮 assistant 流（帧顺序 = sse-map.test 与实际内核 follow 的消费顺序） ───────────────────

async function runTurn(session, text) {
  if (session.turn !== null) return
  const turn = { cancelled: false, settled: false, waiters: [] }
  session.turn = turn
  const attemptId = `stub-attempt-${String(++turnCounter)}`
  const turnNumber = turnCounter
  logStub('turn-start', { sessionId: session.cwd, prompt: text, attemptId })

  broadcast(session, {
    type: 'event',
    event: { type: 'turn/start', seq: nextSeq(session), time: Date.now(), data: { turn: turnNumber } }
  })
  // PB-013 重试形态：前 N 次 attempt 先交付一段"将被作废"的正文，然后新 attempt 重来。
  // 宿主 mapper 看到 attemptId 变化会发 reset-step（实时流），有效帧里只留最终 attempt 的正文。
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const retryAttemptId = `stub-attempt-${String(turnCounter)}-r${String(attempt)}`
    broadcast(session, {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: retryAttemptId, revision: 0, turn: turnNumber, step: attempt }
    })
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: retryAttemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'block-start', index: 0, blockType: 'text' }
      }
    })
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: retryAttemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'text-delta', index: 0, text: RETRY_TEXT }
      }
    })
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: retryAttemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'block-end', index: 0 }
      }
    })
  }
  broadcast(session, {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId, revision: 0, turn: turnNumber, step: 1 }
  })
  if (CHUNKS.length > 0) {
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'block-start', index: 0, blockType: 'text' }
      }
    })
  }
  for (let index = 0; index < CHUNKS.length; index += 1) {
    if (index > 0) {
      await Promise.race([sleep(CHUNK_DELAY_MS), waitCancelled(turn, CHUNK_DELAY_MS)])
    }
    if (turn.cancelled) break
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'text-delta', index: 0, text: CHUNKS[index] }
      }
    })
    if (SCENARIO === 'hang' && index === 0) {
      // 负向控制用：首段后**永远不 settle**（不发 turn/end）——宿主必须超时/cancel，不能假绿
      await new Promise((resolve) => {
        turn.waiters.push(() => resolve(undefined))
      })
      break
    }
  }
  if (turn.settled) return
  if (!turn.cancelled && CHUNKS.length > 0) {
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'block-end', index: 0 }
      }
    })
  }
  if (!turn.cancelled && TOOL !== null && typeof TOOL.name === 'string') {
    const callId = `stub-tool-${String(turnCounter)}`
    broadcast(session, {
      type: 'event',
      event: {
        type: 'tool/call',
        seq: nextSeq(session),
        time: Date.now(),
        data: { callId, name: TOOL.name, arguments: JSON.stringify(TOOL.input ?? {}) }
      }
    })
    broadcast(session, {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: nextSeq(session),
        time: Date.now(),
        data: {
          message: {
            toolCallId: callId,
            isError: TOOL.isError === true,
            content: [
              { type: 'text', text: JSON.stringify(TOOL.result ?? { ok: true }) }
            ]
          }
        }
      }
    })
  }
  if (turn.cancelled) {
    // cancel 分支的帧由 cancelTurn() 立即发出；这里只收尾（避免重复 turn/end）
    turn.settled = true
    session.turn = null
    return
  }
  if (
    APPROVAL !== null &&
    typeof APPROVAL.id === 'string' &&
    typeof APPROVAL.toolName === 'string'
  ) {
    // PB-004 / B3.5：只回放内核的两条审批事件；**不替用户应答、不执行工具**
    broadcast(session, {
      type: 'event',
      event: {
        type: 'approval/asked',
        seq: nextSeq(session),
        time: Date.now(),
        data: {
          id: APPROVAL.id,
          toolName: APPROVAL.toolName,
          ...(typeof APPROVAL.callId === 'string' ? { callId: APPROVAL.callId } : {}),
          ...(typeof APPROVAL.reason === 'string' ? { reason: APPROVAL.reason } : {})
        }
      }
    })
    const decision = APPROVAL.decision
    if (
      typeof decision === 'object' &&
      decision !== null &&
      typeof decision.id === 'string' &&
      typeof decision.outcome === 'string'
    ) {
      broadcast(session, {
        type: 'event',
        event: {
          type: 'approval/decided',
          seq: nextSeq(session),
          time: Date.now(),
          data: { id: decision.id, outcome: decision.outcome }
        }
      })
    }
  }

  const failed = SCENARIO === 'error'
  if (failed) {
    broadcast(session, {
      type: 'assistant-stream',
      frame: { type: 'end', attemptId, outcome: { kind: 'failed', error: ERROR } }
    })
    broadcast(session, {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: nextSeq(session),
        time: Date.now(),
        data: { reason: { kind: 'error', error: ERROR } }
      }
    })
  } else {
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'usage', index: 0, usage: USAGE }
      }
    })
    broadcast(session, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId,
        revision: 0,
        index: 0,
        chunk: { type: 'finish', index: 0, reason: { kind: 'stop' } }
      }
    })
    broadcast(session, {
      type: 'assistant-stream',
      frame: { type: 'end', attemptId, outcome: { kind: 'completed', seq: nextSeq(session) } }
    })
    broadcast(session, {
      type: 'event',
      event: {
        type: 'turn/end',
        seq: nextSeq(session),
        time: Date.now(),
        data: { reason: { kind: 'completed' } }
      }
    })
  }
  turn.settled = true
  session.turn = null
  logStub(failed ? 'turn-error' : 'turn-end', { attemptId, cancelled: false })
}

function cancelTurn(session) {
  const turn = session.turn
  if (turn === null || turn.settled) return
  turn.cancelled = true
  turn.settled = true
  session.turn = null
  for (const waiter of turn.waiters.splice(0)) waiter()
  const attemptId = `stub-attempt-cancel-${String(turnCounter)}`
  broadcast(session, {
    type: 'assistant-stream',
    frame: { type: 'end', attemptId, outcome: { kind: 'cancelled' } }
  })
  broadcast(session, {
    type: 'event',
    event: {
      type: 'turn/end',
      seq: nextSeq(session),
      time: Date.now(),
      data: { reason: { kind: 'cancelled' } }
    }
  })
  logStub('turn-cancelled', {})
}

// ── 一元 RPC（/api/<endpoint>） ─────────────────────────────────────────────────────────────

function rpcResult(value) {
  return { ok: true, value }
}

function handleRpc(endpoint, args) {
  const input = typeof args === 'object' && args !== null ? args : {}
  switch (endpoint) {
    case 'session/create': {
      const request = input.request ?? {}
      const sessionId =
        typeof request.sessionId === 'string' && request.sessionId !== ''
          ? request.sessionId
          : `session-${crypto.randomUUID()}`
      ensureSession(sessionId, request.cwd)
      logStub('session-create', { sessionId })
      return rpcResult({ sessionId })
    }
    case 'session/list': {
      return rpcResult({
        items: [...sessions.entries()].map(([sessionId, session]) => ({
          sessionId,
          cwd: session.cwd,
          running: session.turn !== null,
          blank: true
        }))
      })
    }
    case 'session/prompt': {
      const request = input.request ?? {}
      const sessionId = typeof request.sessionId === 'string' ? request.sessionId : ''
      const session = sessions.get(sessionId)
      if (session === undefined) {
        return { ok: false, error: { code: 'session/not-found', message: sessionId } }
      }
      const text = Array.isArray(request.content)
        ? request.content
            .flatMap((part) =>
              typeof part === 'object' && part !== null && part.type === 'text' && typeof part.text === 'string'
                ? [part.text]
                : []
            )
            .join('')
        : ''
      logStub('session-prompt', { sessionId, text })
      void runTurn(session, text)
      return rpcResult({ accepted: true })
    }
    case 'session/cancel': {
      const request = input.request ?? {}
      const session = sessions.get(typeof request.sessionId === 'string' ? request.sessionId : '')
      if (session !== undefined) cancelTurn(session)
      logStub('session-cancel', { sessionId: request.sessionId ?? null })
      return rpcResult({ cancelled: true })
    }
    case 'session/projections': {
      return rpcResult({ values: { goal: null, plan: { active: false, pending: false } } })
    }
    case 'commands/list': {
      return rpcResult([
        { name: 'goal', description: 'stub: goal command' },
        { name: 'plan', description: 'stub: plan command' }
      ])
    }
    case 'commands/execute': {
      return rpcResult({ accepted: true })
    }
    case 'session/follow': {
      // follow 正常走 WS `open`；这里给出同形空结果，避免调用方误判
      return rpcResult({ followed: true })
    }
    default:
      return {
        ok: false,
        error: { code: 'unknown-endpoint', message: `kernel stub: unknown RPC endpoint ${endpoint}` }
      }
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function hasApiCookie(request) {
  const header = request.headers.cookie
  return typeof header === 'string' && header.includes(`${cookieName}=${cookieValue}`)
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body))
  })
  response.end(body)
}

async function handleHttp(request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/connect') {
    if (url.searchParams.get('token') !== token) {
      response.writeHead(401, { 'content-type': 'text/plain' }).end('bad token')
      return
    }
    logStub('connect', { interactions: url.searchParams.get('interactions') })
    response.writeHead(302, {
      location: './api/remote.mux',
      'set-cookie': [`${cookieName}=${cookieValue}; Path=/; HttpOnly`]
    })
    response.end()
    return
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!hasApiCookie(request)) {
      jsonResponse(response, 401, { error: 'unauthorized' })
      return
    }
    let body
    try {
      body = await readBody(request, 4 * 1024 * 1024)
    } catch {
      jsonResponse(response, 413, { error: 'body-too-large' })
      return
    }
    let envelope
    try {
      envelope = JSON.parse(body)
    } catch {
      jsonResponse(response, 400, { error: 'invalid-json' })
      return
    }
    if (envelope.type !== 'client-request') {
      jsonResponse(response, 400, { error: 'not-client-request' })
      return
    }
    const endpoint = url.pathname.slice('/api/'.length)
    const result = handleRpc(endpoint, envelope.payload?.args)
    jsonResponse(response, 200, {
      type: 'server-response',
      rpcId: envelope.rpcId,
      result
    })
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
}

// ── WS 升级与消息处理 ───────────────────────────────────────────────────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function handleUpgrade(request, socket) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/api/remote.mux' || !hasApiCookie(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  )
  const state = { socket, buffer: Buffer.alloc(0), fragments: [], fragmentOpcode: 0 }
  logStub('ws-open', {})
  socket.on('data', (chunk) => onWsData(state, chunk))
  socket.on('close', () => {
    for (const streamId of [...streams.keys()]) {
      const stream = streams.get(streamId)
      if (stream !== undefined && stream.socket === socket) {
        detachStream(streamId)
      }
    }
    // 宿主退出：进行中的一轮静默收尾，别留 timer 把进程吊住
    for (const session of sessions.values()) {
      if (session.turn !== null) {
        session.turn.cancelled = true
        session.turn.settled = true
        for (const waiter of session.turn.waiters.splice(0)) waiter()
        session.turn = null
      }
    }
    logStub('ws-close', {})
  })
  socket.on('error', () => socket.destroy())
}

function onWsData(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk])
  for (;;) {
    const buffer = state.buffer
    if (buffer.length < 2) return
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    let mask
    if (masked) {
      if (buffer.length < offset + 4) return
      mask = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    state.buffer = buffer.subarray(offset + length)
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0)
      }
    }
    if (opcode === 0x08) {
      try {
        state.socket.write(encodeServerFrame(0x08, Buffer.alloc(0)))
      } catch {
        // ignore
      }
      state.socket.end()
      return
    }
    if (opcode === 0x09) {
      try {
        state.socket.write(encodeServerFrame(0x0a, payload))
      } catch {
        // ignore
      }
      continue
    }
    if (opcode === 0x0a) continue
    if (opcode === 0x00) {
      state.fragments.push(payload)
      if (!fin) continue
      const complete = Buffer.concat(state.fragments)
      state.fragments = []
      if (state.fragmentOpcode === 0x01) {
        handleWsMessage(state.socket, complete.toString('utf8'))
      }
      continue
    }
    if (opcode === 0x01) {
      if (!fin) {
        state.fragmentOpcode = 0x01
        state.fragments = [payload]
        continue
      }
      handleWsMessage(state.socket, payload.toString('utf8'))
    }
  }
}

function detachStream(streamId) {
  const stream = streams.get(streamId)
  if (stream === undefined) return
  streams.delete(streamId)
  const session = sessions.get(stream.sessionId)
  session?.streams.delete(streamId)
}

function handleWsMessage(socket, text) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (message.type === 'open') {
    const streamId = typeof message.streamId === 'string' ? message.streamId : ''
    const request = message.payload?.args?.request ?? {}
    const sessionId = request.address?.sessionId
    if (streamId === '' || typeof sessionId !== 'string') {
      sendWsText(socket, {
        type: 'error',
        streamId,
        error: { code: 'bad-open', message: 'kernel stub: open without sessionId' }
      })
      return
    }
    const session = ensureSession(sessionId, request.cwd)
    streams.set(streamId, { sessionId, socket })
    session.streams.add(streamId)
    logStub('follow-open', { streamId, sessionId })
    // snapshot 是 follow 的 opening：adapter 用它判定"接上了"，并读 cursor/startedAfterSeq/nextIndex
    sendItem(streamId, {
      type: 'snapshot',
      cursor: session.seq,
      records: [],
      header: {
        version: 4,
        id: sessionId,
        createdAt: Date.now(),
        cwd: session.cwd,
        isSeeded: false,
        agentPreset: 'standard'
      }
    })
    return
  }
  if (message.type === 'cancel') {
    // 这是"取消订阅"（reattach 时宿主主动卸旧流），**不是**取消正在跑的一轮
    if (typeof message.streamId === 'string') {
      detachStream(message.streamId)
      logStub('follow-detach', { streamId: message.streamId })
    }
    return
  }
}

// ── 启动 ───────────────────────────────────────────────────────────────────────────────────

const server = http.createServer((request, response) => {
  handleHttp(request, response).catch((error) => {
    try {
      jsonResponse(response, 500, { error: String(error) })
    } catch {
      // ignore
    }
  })
})
server.on('upgrade', handleUpgrade)
server.on('error', (error) => {
  process.stderr.write(`[kernel-stub] server error: ${String(error)}\n`)
  process.exit(1)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    process.stderr.write('[kernel-stub] no address after listen\n')
    process.exit(1)
    return
  }
  logStub('ready', { port: address.port })
  // 这一行是 kernel-process.ts READY_PATTERN 的唯一输入，格式不要改
  process.stdout.write(`${DSH_WEB_READY_PREFIX}http://127.0.0.1:${String(address.port)}/?token=${token}\n`)
})

function shutdown() {
  try {
    server.close()
  } catch {
    // ignore
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
