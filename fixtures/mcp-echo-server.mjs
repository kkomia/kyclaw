#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 测试替身，保持零依赖零类型 */
/**
 * MCP 测试用最小 server（T12）：真实外部工具的自足替身，不依赖任何 SDK。
 *
 * 两种传输：
 *   - stdio（缺省）：换行分隔的 JSON-RPC 2.0 读写 stdin/stdout；
 *   - HTTP：`--http=8137` 在 127.0.0.1 上起一个最小 Streamable HTTP 端点（POST /mcp 回 JSON）。
 *
 * 工具集（覆盖本任务的判据）：
 *   - echo {message}          → 回显（Step 1：调用回显正确）
 *   - write_remote {path,content} → 假装"远端写"（带 path 字段，用来钉"外部工具带工作区外路径也必须问审批"）
 *   - fail {}                 → 服务端 in-band 错误（isError，调用错误分类）
 *   - crash {}                → 回包后退出进程（lifecycle 的崩溃重启用例）
 *
 * 故障开关（建连接/列工具的错误分类）：
 *   - --hang        initialize 永不回包 → 握手超时
 *   - --fail-list   tools/list 回错 → 服务连上了但列工具失败
 *   - --state-file=<path>  持久故障演练：启动时若该文件存在就立刻退出（模拟"服务坏了，拉不起来"）；
 *                          配合 crash 工具（先写这个文件再退出）用来钉"崩溃重启 ≤2 次后暂停"。
 *
 * 协议：legacy initialize 握手（2024-11-05）——@mastra/mcp 的客户端在 server/discover
 * 探测不到时会回落 legacy，这个 fixture 就走那条路。
 */
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { existsSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const hang = argv.includes('--hang')
const failList = argv.includes('--fail-list')
const httpArg = argv.find((arg) => arg.startsWith('--http'))
const stateFile = argv.find((arg) => arg.startsWith('--state-file='))?.split('=')[1]

// 持久故障：上一轮 crash 已经把"坏"写进状态文件 → 这次启动直接退（模拟起不来的服务）
if (stateFile !== undefined && existsSync(stateFile)) process.exit(1)

const TOOLS = [
  {
    name: 'echo',
    description: '原样回显 message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message']
    }
  },
  {
    name: 'write_remote',
    description: '远端写入（测试用替身，不碰本机文件）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径' },
        content: { type: 'string', description: '内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'fail',
    description: '总是返回一个服务端错误（in-band）',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'crash',
    description: '回包后退出进程（重启用例）',
    inputSchema: { type: 'object', properties: {} }
  }
]

/** JSON-RPC 请求 → 回应对象；null = 不回（通知 / 故意挂起） */
function respond(message) {
  const { id, method, params } = message
  if (method === undefined || id === undefined) return null
  if (hang && method === 'initialize') return null

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-echo', version: '1.0.0' }
        }
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return failList
        ? { jsonrpc: '2.0', id, error: { code: -32603, message: 'fixture 故意让 tools/list 失败' } }
        : { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    case 'tools/call':
      return callTool(id, params)
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      }
  }
}

function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const text = (value) => ({ content: [{ type: 'text', text: value }] })

  if (name === 'echo') {
    return { jsonrpc: '2.0', id, result: text(`echo: ${String(args.message ?? '')}`) }
  }
  if (name === 'write_remote') {
    return {
      jsonrpc: '2.0',
      id,
      result: text(`已记录 ${String(args.path ?? '')}（${String(args.content ?? '').length} 字符）`)
    }
  }
  if (name === 'fail') {
    return {
      jsonrpc: '2.0',
      id,
      result: { isError: true, ...text('远端拒绝了这次调用') }
    }
  }
  if (name === 'crash') {
    if (stateFile !== undefined) writeFileSync(stateFile, 'broken\n', 'utf8')
    setTimeout(() => process.exit(1), 100)
    return { jsonrpc: '2.0', id, result: text('好，我崩了') }
  }
  return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } }
}

if (httpArg !== undefined) {
  const port = Number(httpArg.includes('=') ? httpArg.split('=')[1] : '8137')
  startHttp(port)
} else {
  startStdio()
}

function startStdio() {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    const answer = respond(message)
    if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`)
  })
  rl.on('close', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}

/** 最小 Streamable HTTP：POST /mcp 收 JSON-RPC、立即回 application/json（不开 SSE 流） */
function startHttp(port) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'only POST /mcp' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } })
        )
        return
      }
      const answer = respond(message)
      if (answer === null) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'mcp-echo-session'
      })
      res.end(JSON.stringify(answer))
    })
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`mcp-echo listening on http://127.0.0.1:${port}/mcp\n`)
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
}
