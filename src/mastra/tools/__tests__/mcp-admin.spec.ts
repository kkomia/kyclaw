// @vitest-environment node
/**
 * add_mcp_server / remove_mcp_server（round 65）：让模型把用户贴来的 MCP 配置落进设置并生效。
 *
 * 钉住的六件事：
 *   ① **落盘走既有那条路**：写的是注入的 `saveMcpServers`（生产 = PUT /api/mcp/servers 用的同一个
 *      函数），写成功后调 `onMcpServersChanged`（连接对齐）；
 *   ② stdio / http 两种 transport 的字段口径（command 必填 / url 必须完整 http(s)）；
 *   ③ id 口径：给了要过 pattern，没给按 name 派生且不撞已占用的；
 *   ④ 缺省不启用；只有配置完整才允许 enabled: true；
 *   ⑤ 人话错误：缺字段 / 不合法 url / id 不存在都回字符串（不抛）；
 *   ⑥ 审批：两个都是写类（ask 工作区要问、full 工作区免审）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthoringRuntime } from '../../../shared/authoring'
import type { McpServerConfig } from '../../../shared/settings'
import { classifyToolCall } from '../../../main/permission/classify'
import { callTool, createBed, type TestBed } from './helpers'
import { createAddMcpServerTool, createRemoveMcpServerTool } from '../mcp-admin'

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

/** 一份内存里的 settings.mcpServers + 写入记录（落盘路径用假实现钉住"写了什么"） */
function bedRuntime(initial: McpServerConfig[] = []): {
  runtime: () => AuthoringRuntime
  saved: () => McpServerConfig[]
  changed: () => number
} {
  let servers = [...initial]
  let changedCount = 0
  return {
    runtime: () => ({
      skillsDir: '',
      pluginSkillDirs: [],
      builtinSkillNames: [],
      readMcpServers: () => servers,
      saveMcpServers: (next) => {
        servers = [...next]
        return servers
      },
      onMcpServersChanged: () => {
        changedCount += 1
      }
    }),
    saved: () => servers,
    changed: () => changedCount
  }
}

const EXISTING: McpServerConfig[] = [
  {
    id: 'echo',
    name: '回声服务',
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    readOnlyTools: []
  }
]

describe('add_mcp_server：两种 transport', () => {
  it('stdio：写进设置（缺省停用），并通知连接对齐', async () => {
    const bedRt = bedRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const out = String(
      await callTool(tool, {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
        env: { DATA_DIR: 'D:/data' }
      })
    )

    expect(out).toContain('已添加 MCP 服务「filesystem」')
    expect(out).toContain('id: filesystem')
    expect(out).toContain('stdio：npx')
    expect(out).toContain('未启用')
    expect(bedRt.saved()).toEqual([
      {
        id: 'filesystem',
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
        env: { DATA_DIR: 'D:/data' },
        enabled: false,
        readOnlyTools: []
      }
    ])
    expect(bedRt.changed()).toBe(1)
  })

  it('http：url + headers；enabled: true 且配置完整时直接启用', async () => {
    const bedRt = bedRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const out = String(
      await callTool(tool, {
        name: '搜索服务',
        id: 'search-1',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer test' },
        enabled: true
      })
    )

    expect(out).toContain('已启用')
    expect(out).toContain('mcp__search-1__')
    expect(bedRt.saved()[0]).toMatchObject({
      id: 'search-1',
      name: '搜索服务',
      transport: 'http',
      enabled: true,
      readOnlyTools: []
    })
  })

  it('同名 id 已存在 = 覆盖更新（不是追加第二条）', async () => {
    const bedRt = bedRuntime(EXISTING)
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const out = String(
      await callTool(tool, {
        id: 'echo',
        name: '回声服务（新地址）',
        transport: 'http',
        url: 'https://example.com/v2/mcp'
      })
    )

    expect(out).toContain('已更新 MCP 服务')
    expect(bedRt.saved()).toHaveLength(1)
    expect(bedRt.saved()[0]?.url).toBe('https://example.com/v2/mcp')
    // 覆盖时 enabled 跟着新输入走（缺省 false：先停用，用户测过再启用）
    expect(bedRt.saved()[0]?.enabled).toBe(false)
  })
})

describe('add_mcp_server：校验与错误（人话，不抛）', () => {
  it('stdio 缺 command / http 缺 url / url 不合法：回人话并指路另一种 transport', async () => {
    const bedRt = bedRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const noCommand = String(await callTool(tool, { name: 'x', transport: 'stdio' }))
    expect(noCommand).toContain('要填 command')
    expect(noCommand).toContain('transport: "http"')

    const noUrl = String(await callTool(tool, { name: 'x', transport: 'http' }))
    expect(noUrl).toContain('http:// 或 https://')
    expect(noUrl).toContain('transport: "stdio"')

    const badUrl = String(
      await callTool(tool, { name: 'x', transport: 'http', url: 'example.com/mcp' })
    )
    expect(badUrl).toContain('http:// 或 https://')

    expect(bedRt.saved()).toEqual([])
    expect(bedRt.changed()).toBe(0)
  })

  it('id 不合规：回人话；没给 id 就按名字派生', async () => {
    const bedRt = bedRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const bad = String(
      await callTool(tool, { name: 'x', id: 'Bad_ID__x', transport: 'stdio', command: 'node' })
    )
    expect(bad).toContain('标识只能用')

    // 名字派生：能用的字符留下、其余折成短横线；全用不了的（纯中文名）退 mcp-N
    const ok = String(
      await callTool(tool, { name: 'Filesystem Server', transport: 'stdio', command: 'node' })
    )
    expect(ok).toContain('id: filesystem-server')
    expect(bedRt.saved()[0]?.id).toBe('filesystem-server')

    const cjk = String(
      await callTool(tool, { name: '文件服务', transport: 'stdio', command: 'node' })
    )
    expect(cjk).toContain('id: mcp-')
    expect(bedRt.saved()[1]?.id).toMatch(/^mcp-\d+$/)
  })

  it('配置不完整却要启用：拒绝并给补全建议', async () => {
    const bedRt = bedRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, bedRt.runtime)

    const out = String(
      await callTool(tool, {
        name: 'x',
        id: 'empty-cmd',
        transport: 'stdio',
        command: '',
        enabled: true
      })
    )
    // command 为空也算"没填"（人话在这一层就拦下）
    expect(out).toContain('要填 command')
    expect(bedRt.saved()).toEqual([])
  })

  it('落盘抛错（比如设置里已有非法条目）：回人话，不把异常冒出去', async () => {
    const rt: AuthoringRuntime = {
      skillsDir: '',
      pluginSkillDirs: [],
      builtinSkillNames: [],
      readMcpServers: () => [],
      saveMcpServers: () => {
        throw new Error('settings.json 写入失败')
      }
    }
    const tool = await createAddMcpServerTool(bed.ctx, () => rt)

    const out = String(await callTool(tool, { name: 'x', transport: 'stdio', command: 'node' }))
    expect(out).toContain('没能落盘')
    expect(out).toContain('settings.json 写入失败')
  })

  it('运行时缺失：回人话（不抛）', async () => {
    const tool = await createAddMcpServerTool(bed.ctx, () => null)
    const out = String(await callTool(tool, { name: 'x', transport: 'stdio', command: 'node' }))
    expect(out).toContain('不支持修改 MCP 配置')
  })
})

describe('remove_mcp_server', () => {
  it('按 id 移除并通知对齐；id 不存在时列出当前配置', async () => {
    const bedRt = bedRuntime(EXISTING)
    const tool = await createRemoveMcpServerTool(bed.ctx, bedRt.runtime)

    const missing = String(await callTool(tool, { id: 'nope' }))
    expect(missing).toContain('没有 id 为「nope」的 MCP 服务')
    expect(missing).toContain('echo（回声服务）')

    const out = String(await callTool(tool, { id: 'echo' }))
    expect(out).toContain('已移除 MCP 服务「回声服务」')
    expect(bedRt.saved()).toEqual([])
    expect(bedRt.changed()).toBe(1)
  })
})

describe('审批档位', () => {
  it('两个都是写类：ask 工作区要问、full 工作区免审', async () => {
    expect(classifyToolCall('add_mcp_server', { name: 'x' })).toBe('write')
    expect(classifyToolCall('remove_mcp_server', { id: 'x' })).toBe('write')

    const add = await createAddMcpServerTool(bed.ctx, () => null)
    const remove = await createRemoveMcpServerTool(bed.ctx, () => null)
    const gate = (tool: unknown): ((input: unknown) => boolean) =>
      (tool as { requireApproval: (input: unknown) => boolean }).requireApproval

    expect(gate(add)({ name: 'x' })).toBe(true)
    expect(gate(remove)({ id: 'x' })).toBe(true)

    bed.roots[0] = { ...bed.roots[0], mode: 'full' }
    expect(gate(add)({ name: 'x' })).toBe(false)
    expect(gate(remove)({ id: 'x' })).toBe(false)
  })
})
