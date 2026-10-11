import { describe, expect, it } from 'vitest'
import { parseMcpServersJson } from '../mcp'
import type { McpServerConfig } from '../settings'

/**
 * JSON 导入解析器（round 9，纯函数）：
 * 吃整段 `{"mcpServers": {...}}`（可多个）或单个 server 对象；不合法 throw 人话 Error。
 * id 规范化（小写、非法字符→-、截 32 位）不合法/重名 → 退 `mcp-N`；sse 明确报错。
 */
const EXISTING: McpServerConfig[] = [
  {
    id: 'perfsight',
    name: '已存在',
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    readOnlyTools: []
  }
]

const USER_EXAMPLE = `{
  "mcpServers": {
    "perfsight": {
      "type": "http",
      "url": "https://api.perfsight.qq.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`

describe('parseMcpServersJson · 两种输入形状', () => {
  it('标准包壳：一条 http 服务（用户原话的例子），headers 原样收下', () => {
    const servers = parseMcpServersJson(USER_EXAMPLE, [])

    expect(servers).toEqual([
      {
        id: 'perfsight',
        name: 'perfsight',
        transport: 'http',
        url: 'https://api.perfsight.qq.com/mcp',
        headers: { Authorization: 'Bearer YOUR_API_KEY' },
        enabled: false,
        readOnlyTools: []
      }
    ])
  })

  it('包里多条：都转出来；单条配置也认（带 url / command 的对象）', () => {
    const parsed = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          a: { type: 'http', url: 'https://a.example/mcp' },
          b: { command: 'npx', args: ['-y', 'server-b'] }
        }
      }),
      []
    )
    expect(parsed.map((server) => [server.id, server.transport])).toEqual([
      ['a', 'http'],
      ['b', 'stdio']
    ])

    const single = parseMcpServersJson(
      JSON.stringify({ name: '单条', type: 'http', url: 'https://s.example/mcp' }),
      []
    )
    expect(single).toHaveLength(1)
    // 纯中文名规范化后没有可用字符 → id 退 mcp-N（名字仍是原名）
    expect(single[0]).toMatchObject({ id: 'mcp-1', name: '单条', transport: 'http' })
  })
})

describe('parseMcpServersJson · id 规范化与退让', () => {
  it('键规范化：小写 + 非法字符→- + 截 32 位', () => {
    const [server] = parseMcpServersJson(
      JSON.stringify({ mcpServers: { 'My Server!V2': { url: 'https://x.example/mcp' } } }),
      []
    )
    expect(server.id).toBe('my-server-v2')
  })

  it('与已有重名 → 退 mcp-N；批内重名也依次退（保证唯一）', () => {
    const parsed = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          perfsight: { url: 'https://new.example/mcp' },
          PerfSight: { url: 'https://other.example/mcp' }
        }
      }),
      EXISTING
    )
    expect(parsed.map((server) => server.id)).toEqual(['mcp-1', 'mcp-2'])
    // 名字仍保留原始键
    expect(parsed.map((server) => server.name)).toEqual(['perfsight', 'PerfSight'])
  })

  it('规范化后没有可用字符（纯中文键）→ 退 mcp-N', () => {
    const [server] = parseMcpServersJson(
      JSON.stringify({ mcpServers: { 服务: { url: 'https://cn.example/mcp' } } }),
      []
    )
    expect(server.id).toBe('mcp-1')
    expect(server.name).toBe('服务')
  })
})

describe('parseMcpServersJson · 逐条映射与报错', () => {
  it('type 归一：streamable-http / streamablehttp 都算 http；stdio 或带 command 算 stdio', () => {
    const parsed = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          one: { type: 'streamable-http', url: 'https://1.example/mcp' },
          two: { type: 'streamablehttp', url: 'https://2.example/mcp' },
          three: { type: 'stdio', command: 'node', args: 'server.mjs' },
          four: { command: 'node' }
        }
      }),
      []
    )
    expect(parsed.map((server) => server.transport)).toEqual(['http', 'http', 'stdio', 'stdio'])
    // args 给 string 容忍成单元素
    expect(parsed[2].args).toEqual(['server.mjs'])
  })

  it('sse 明确报错（不静默当 http）', () => {
    expect(() =>
      parseMcpServersJson(
        JSON.stringify({ mcpServers: { s: { type: 'sse', url: 'https://s.example/sse' } } }),
        []
      )
    ).toThrow(/s：sse 暂不支持/)
  })

  it('错误带条目标识：坏 url / 不认识的 type / 缺 command / 坏 headers / 坏 args', () => {
    const cases: Array<[string, RegExp]> = [
      [
        JSON.stringify({ mcpServers: { bad: { type: 'http', url: 'ftp://x/mcp' } } }),
        /bad：url 不是完整的 http\(s\) 地址/
      ],
      [
        JSON.stringify({ mcpServers: { odd: { type: 'websocket', url: 'https://o/mcp' } } }),
        /odd：不认识的 type：websocket/
      ],
      [JSON.stringify({ mcpServers: { s: { type: 'stdio' } } }), /s：缺少 command/],
      [
        JSON.stringify({ mcpServers: { h: { url: 'https://h/mcp', headers: 'nope' } } }),
        /h：headers 要是一个对象/
      ],
      [
        JSON.stringify({
          mcpServers: { h: { url: 'https://h/mcp', headers: { X: { deep: 1 } } } }
        }),
        /h：headers 的值「X」要是字符串/
      ],
      [
        JSON.stringify({ mcpServers: { a: { command: 'node', args: [1] } } }),
        /a：args 要是字符串数组/
      ],
      [JSON.stringify({ mcpServers: { n: { nothing: true } } }), /n：缺少 url 或 command/]
    ]
    for (const [text, pattern] of cases) {
      expect(() => parseMcpServersJson(text, []), text).toThrow(pattern)
    }
  })

  it('headers/env 的值容忍数字与布尔（String 化）；未知字段忽略；默认停用 + 空只读表', () => {
    const [server] = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          k: {
            type: 'http',
            url: 'https://k.example/mcp',
            headers: { 'X-Retries': 3, 'X-Flag': true },
            unknownField: { deep: true }
          }
        }
      }),
      []
    )
    expect(server.headers).toEqual({ 'X-Retries': '3', 'X-Flag': 'true' })
    expect(server.enabled).toBe(false)
    expect(server.readOnlyTools).toEqual([])
    expect('unknownField' in server).toBe(false)
  })
})

describe('parseMcpServersJson · 顶层形状不合法', () => {
  it('空串 / 不是 JSON / 不是对象 / mcpServers 不是对象 / 没有服务 → 人话错误', () => {
    expect(() => parseMcpServersJson('   ', [])).toThrow(/内容是空的/)
    expect(() => parseMcpServersJson('{oops', [])).toThrow(/不是合法的 JSON/)
    expect(() => parseMcpServersJson('[1, 2]', [])).toThrow(/要贴一个对象/)
    expect(() => parseMcpServersJson('{"mcpServers": [1]}', [])).toThrow(/mcpServers 要是一个对象/)
    expect(() => parseMcpServersJson('{"mcpServers": {}}', [])).toThrow(/没有服务/)
    expect(() => parseMcpServersJson('{"mcpServers": {"a": 1}}', [])).toThrow(/a：配置要是一个对象/)
    expect(() => parseMcpServersJson('{"foo": 1}', [])).toThrow(/没认出可导入的服务/)
  })
})
