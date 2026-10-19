/**
 * PB-023：宿主 MCP 配置（`settings.mcpServers`）→ DSH 内核侧的 MCP 插件配置。
 *
 * 背景：0.2.0 起 MCP 不再由宿主 `@mastra/mcp` 连接（`src/main/mcp/lifecycle.ts` 下线），
 * 改为 DSH 内核自带插件 `@deepseek-ai/dsh-mcp-client`（快照内 0.2.1-rc.2，第一方包）。
 * 宿主只负责把用户在设置里维护的 server 列表**翻译**成内核的 patch 层：
 *
 *   `$DSH_HOME/cordis.patch.yml`（home patch；`dsh-app-boot` 的 `composeProfile` 会把它
 *   应用在 profile 层之后，机器级、对所有 profile 生效）
 *
 * 与 `profiles/web/cordis.patch.yml`（adapter 写 goal 轮次上限）**分开文件**：两个 owner
 * 各自重写自己的 patch，互不覆盖，也不需要改 kernel 启动参数（`--patch` 那条要给 adapter
 * 加透传，超出本单边界）。
 *
 * 口径（照抄 DSH 模板 `dsh-agent-preset/.../templates/mcp/cordis.patch.yml`）：
 *   - `insert:` 一个插件项：`id: mcp-<server.id>`、`name: '@deepseek-ai/dsh-mcp-client'`；
 *   - `serverName` = `settings.mcpServers[].id`（两边字符集兼容：`[a-z0-9-]{1,32}` ⊂ `[A-Za-z0-9_-]{1,32}`），
 *     工具名继续保持 `mcp__<id>__<tool>`，renderer/审批/轨迹的解析零改动；
 *   - stdio：`transport: stdio` + `command/args/env`；http：`transport: streamable-http` + `url/headers`；
 *   - `failOnStartupError: true`（与模板一致：单个 server 起不来只让这个插件项报错，内核照常启动）。
 *
 * 安全：所有用户输入（command/args/env/url/headers）一律 JSON 双引号标量输出（YAML 1.2 允许），
 * 不拼裸字符串；换行/空 header 名在 `shared/mcp.ts` 的校验里已被拦下（这里只消费"可启用"的条目）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpServerProblems } from '../../shared/mcp'
import type { McpServerConfig } from '../../shared/settings'

/** home patch 的文件名（`$DSH_HOME/cordis.patch.yml`；与 profile patch 同名但不同目录） */
export const MCP_HOME_PATCH_FILENAME = 'cordis.patch.yml'

export interface McpPatchSkipped {
  id: string
  reason: string
}

export interface McpPatchRender {
  /** patch 文件全文（顶层 YAML 数组；无启用项时是 `[]` + 头注释，用来清掉旧条目） */
  yaml: string
  /** 进入 patch 的 server id（= 内核 serverName） */
  included: string[]
  /** 没进 patch 的（停用除外；停用是正常状态，不算 skipped 噪音） */
  skipped: McpPatchSkipped[]
}

export interface McpPatchWrite extends McpPatchRender {
  file: string
  /** 内容有变化才写（幂等：同样的 settings 连续启动不反复改 mtime） */
  changed: boolean
}

const HEADER = [
  '# kyclaw 0.2.0（PB-023）：settings.mcpServers → DSH 内核 MCP 插件（@deepseek-ai/dsh-mcp-client）。',
  '# 本文件由 kyclaw 每次启动按设置重写，**手改会被覆盖**；要加 MCP server 请在应用设置里加。',
  '# 内核在启动时读取本 patch；改完设置需重启应用生效。'
].join('\n')

/** JSON 双引号标量（YAML 1.2 合法；任何字符都不会把 YAML 结构撑坏） */
function q(value: string): string {
  return JSON.stringify(value)
}

function indent(lines: readonly string[], spaces: number): string[] {
  const prefix = ' '.repeat(spaces)
  return lines.map((line) => `${prefix}${line}`)
}

function pluginEntry(server: McpServerConfig): string[] {
  const config: string[] = [`serverName: ${q(server.id)}`]
  if (server.transport === 'stdio') {
    config.push('transport: stdio')
    config.push(`command: ${q(server.command ?? '')}`)
    const args = server.args ?? []
    if (args.length > 0) {
      config.push('args:')
      config.push(
        ...indent(
          args.map((arg) => `- ${q(arg)}`),
          2
        )
      )
    }
    const env = Object.entries(server.env ?? {})
    if (env.length > 0) {
      config.push('env:')
      config.push(
        ...indent(
          env.map(([name, value]) => `${q(name)}: ${q(value)}`),
          2
        )
      )
    }
  } else {
    config.push('transport: streamable-http')
    config.push(`url: ${q((server.url ?? '').trim())}`)
    const headers = Object.entries(server.headers ?? {})
    if (headers.length > 0) {
      config.push('headers:')
      config.push(
        ...indent(
          headers.map(([name, value]) => `${q(name)}: ${q(value)}`),
          2
        )
      )
    }
  }
  config.push('failOnStartupError: true')
  return [
    `- id: ${q(`mcp-${server.id}`)}`,
    `  name: ${q('@deepseek-ai/dsh-mcp-client')}`,
    '  config:',
    ...indent(config, 4)
  ]
}

/**
 * 纯函数：settings.mcpServers → home patch 的 YAML 文本。
 * - 只出 `enabled` 的；启用但配置不完整的**跳过并在 skipped 里说明**（不该发生：设置落盘前已拦，
 *   但旧 settings.json 可能是手改的 —— 内核 patch 里塞半截配置会让整个 patch 解析失败）；
 * - 重复 id 只保留第一条（DSH 侧 serverName 冲突会让插件项启动失败）；
 * - 停用项是正常状态，不报 skipped。
 */
export function renderMcpPatch(servers: readonly McpServerConfig[]): McpPatchRender {
  const skipped: McpPatchSkipped[] = []
  const included: string[] = []
  const entries: string[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    if (!server.enabled) continue
    const problems = mcpServerProblems(server)
    if (problems.length > 0) {
      skipped.push({ id: server.id, reason: problems.join('；') })
      continue
    }
    if (seen.has(server.id)) {
      skipped.push({ id: server.id, reason: '标识重复：只启用第一条' })
      continue
    }
    seen.add(server.id)
    included.push(server.id)
    entries.push(...pluginEntry(server))
  }

  if (included.length === 0) {
    return { yaml: `${HEADER}\n[]\n`, included, skipped }
  }
  const body = ['', '- insert:', ...indent(entries, 4), ''].join('\n')
  return { yaml: `${HEADER}\n${body}`, included, skipped }
}

/**
 * 把 settings 里的 MCP 配置写到 `$DSH_HOME/cordis.patch.yml`（原子替换、幂等）。
 * 调用时机：内核启动之前（main/index.ts），保证 spawn 时 patch 已落盘。
 */
export function ensureMcpHomePatch(
  dshHome: string,
  servers: readonly McpServerConfig[]
): McpPatchWrite {
  const rendered = renderMcpPatch(servers)
  const file = join(dshHome, MCP_HOME_PATCH_FILENAME)
  mkdirSync(dshHome, { recursive: true })
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null
  const changed = previous !== rendered.yaml
  if (changed) {
    const tmp = `${file}.tmp-${String(process.pid)}`
    writeFileSync(tmp, rendered.yaml, 'utf8')
    renameSync(tmp, file)
  }
  return { ...rendered, file, changed }
}
