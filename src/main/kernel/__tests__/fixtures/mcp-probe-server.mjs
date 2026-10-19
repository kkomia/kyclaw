// PB-023 集成测试用最小 MCP stdio server（newline-delimited JSON-RPC 2.0）。
// 只实现 initialize / notifications/initialized / tools/list / tools/call / ping；
// 工具 ping 返回 "MCP-PONG:<参数 text 或 no-arg>"，供内核的 @deepseek-ai/dsh-mcp-client 注册与调用。
import { createInterface } from 'node:readline'

const TOOL = {
  name: 'ping',
  description: 'PB-023 probe: returns MCP-PONG',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    additionalProperties: false
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '1.0.0' }
      }
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })
    return
  }
  if (method === 'tools/call') {
    const args = params?.arguments ?? {}
    const suffix = typeof args.text === 'string' && args.text !== '' ? args.text : 'no-arg'
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `MCP-PONG:${suffix}` }],
        isError: false
      }
    })
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} })
})
lines.on('close', () => {
  process.exit(0)
})
