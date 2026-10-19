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
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '1.0.0' }
        }
      })}\n`
    )
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`)
    return
  }
  if (method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [TOOL] } })}\n`)
    return
  }
  if (method === 'tools/call') {
    const args = params?.arguments ?? {}
    const suffix = typeof args.text === 'string' && args.text !== '' ? args.text : 'no-arg'
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `MCP-PONG:${suffix}` }],
          isError: false
        }
      })}\n`
    )
    return
  }
  if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`)
  }
})
lines.on('close', () => {
  process.exit(0)
})
