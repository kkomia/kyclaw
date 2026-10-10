import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { Input } from '@renderer/components/ui/input'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { fetchMcpServers, saveMcpServers, testMcpServer } from '@renderer/lib/mcp-api'
import {
  argsToText,
  mcpServerProblems,
  newMcpServer,
  textToArgs,
  type McpTestResult,
  type McpToolInfo
} from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'

/**
 * 设置页「工具与 MCP」组（T12）：MCP server 列表（新增/编辑/删除/启停）+ 测试连接 + 单工具只读标记。
 *
 * 分工：
 *   - 列表是服务端的（mastra/routes/mcp.ts，落 settings.json 的 mcpServers）：每次改动整表保存、
 *     以回吐为准；保存失败行内给原因（例如"启用的服务必须配置完整"），不假装成功；
 *   - 新加的 server 一律**停用**落盘：先把命令/地址填对、测通了再启用，不让半截配置进运行期；
 *   - 「测试连接」真连一次（服务端起子进程/发请求）：成功把工具清单列出来，
 *     每个工具一个「只读」开关——勾了就免审批，不勾按写类逐次询问；
 *   - 只读标记属于落盘状态（PUT 整表的一部分），失败同样行内报错。
 */
interface Draft {
  name: string
  command: string
  argsText: string
  url: string
}

function draftOf(server: McpServerConfig): Draft {
  return {
    name: server.name,
    command: server.command ?? '',
    argsText: argsToText(server.args ?? []),
    url: server.url ?? ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withDraft(server: McpServerConfig, draft: Draft): McpServerConfig {
  return {
    ...server,
    name: draft.name,
    ...(server.transport === 'stdio'
      ? { command: draft.command, args: textToArgs(draft.argsText) }
      : { url: draft.url })
  }
}

function toolLabel(tool: McpToolInfo): string {
  return tool.description === '' ? tool.name : `${tool.name} — ${tool.description}`
}

export function McpSettings(): React.JSX.Element {
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [loaded, setLoaded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, setPending] = useState<Record<string, 'saving' | 'testing' | undefined>>({})
  const [results, setResults] = useState<Record<string, McpTestResult | undefined>>({})
  const [tools, setTools] = useState<Record<string, McpToolInfo[] | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [pageError, setPageError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const list = await fetchMcpServers()
        if (alive) setServers(list)
      } catch (error) {
        if (alive) setPageError(messageOf(error))
      } finally {
        if (alive) setLoaded(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const patchDraft = useCallback((server: McpServerConfig, patch: Partial<Draft>): void => {
    setDrafts((previous) => ({
      ...previous,
      [server.id]: { ...(previous[server.id] ?? draftOf(server)), ...patch }
    }))
  }, [])

  const setError = useCallback((id: string, message: string | undefined): void => {
    setErrors((previous) => ({ ...previous, [id]: message }))
  }, [])

  /** 整表保存；失败抛给调用方（行内错误由调用方落） */
  const persist = useCallback(async (next: McpServerConfig[]): Promise<void> => {
    setServers(await saveMcpServers(next))
  }, [])

  /** 保存一条（草稿 → 落盘）；返回是否成功，测试连接据此决定要不要继续 */
  const save = useCallback(
    async (server: McpServerConfig): Promise<boolean> => {
      const draft = drafts[server.id] ?? draftOf(server)
      const next = withDraft(server, draft)
      setPending((previous) => ({ ...previous, [server.id]: 'saving' }))
      setError(server.id, undefined)
      try {
        await persist(servers.map((candidate) => (candidate.id === server.id ? next : candidate)))
        setDrafts((previous) => ({ ...previous, [server.id]: draftOf(next) }))
        return true
      } catch (error) {
        setError(server.id, messageOf(error))
        return false
      } finally {
        setPending((previous) => ({ ...previous, [server.id]: undefined }))
      }
    },
    [drafts, persist, servers, setError]
  )

  /** 启停 / 删除 / 只读标记：都是整表保存（不经过草稿——草稿只属于"编辑字段 + 保存"那条路） */
  const apply = useCallback(
    async (id: string, mutate: (server: McpServerConfig) => McpServerConfig): Promise<void> => {
      setPending((previous) => ({ ...previous, [id]: 'saving' }))
      setError(id, undefined)
      try {
        await persist(servers.map((server) => (server.id === id ? mutate(server) : server)))
      } catch (error) {
        setError(id, messageOf(error))
      } finally {
        setPending((previous) => ({ ...previous, [id]: undefined }))
      }
    },
    [persist, servers, setError]
  )

  const test = useCallback(
    async (server: McpServerConfig): Promise<void> => {
      const draft = drafts[server.id] ?? draftOf(server)
      const dirty = JSON.stringify(withDraft(server, draft)) !== JSON.stringify(server)

      setResults((previous) => ({ ...previous, [server.id]: undefined }))
      setTools((previous) => ({ ...previous, [server.id]: undefined }))
      setError(server.id, undefined)
      if (dirty && !(await save(server))) return

      setPending((previous) => ({ ...previous, [server.id]: 'testing' }))
      try {
        const result = await testMcpServer(server.id)
        setResults((previous) => ({ ...previous, [server.id]: result }))
        if (result.ok) setTools((previous) => ({ ...previous, [server.id]: result.tools }))
      } catch (error) {
        setError(server.id, messageOf(error))
      } finally {
        setPending((previous) => ({ ...previous, [server.id]: undefined }))
      }
    },
    [drafts, save, setError]
  )

  const add = useCallback(
    async (transport: 'stdio' | 'http'): Promise<void> => {
      setPageError(undefined)
      try {
        await persist([...servers, newMcpServer(servers, transport)])
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [persist, servers]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setPageError(undefined)
      try {
        await persist(servers.filter((server) => server.id !== id))
        setDrafts((previous) => {
          const next = { ...previous }
          delete next[id]
          return next
        })
        setResults((previous) => {
          const next = { ...previous }
          delete next[id]
          return next
        })
        setTools((previous) => {
          const next = { ...previous }
          delete next[id]
          return next
        })
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [persist, servers]
  )

  const toggleReadOnly = useCallback(
    async (server: McpServerConfig, toolName: string): Promise<void> => {
      const marked = server.readOnlyTools.includes(toolName)
      const readOnlyTools = marked
        ? server.readOnlyTools.filter((name) => name !== toolName)
        : [...server.readOnlyTools, toolName]
      await apply(server.id, (candidate) => ({ ...candidate, readOnlyTools }))
    },
    [apply]
  )

  return (
    <div data-testid="mcp-settings" className="flex flex-col gap-4">
      {servers.length === 0 ? (
        <p data-testid="mcp-empty" className="text-b2 text-ink-secondary">
          {loaded ? '还没有 MCP 服务：添加一个，把它的工具接进对话。' : '正在读取…'}
        </p>
      ) : (
        servers.map((server, index) => {
          const draft = drafts[server.id] ?? draftOf(server)
          const problems = mcpServerProblems(withDraft(server, draft))
          const result = results[server.id]
          const toolList = tools[server.id]
          const busy = pending[server.id]

          return (
            <section
              key={server.id}
              data-testid={`mcp-server-${index}`}
              className="flex flex-col gap-3 rounded-panel border border-hairline p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-b1 font-medium text-ink">{draft.name || server.id}</span>
                <span className="rounded-pill bg-selected px-2 py-0.5 text-c1 text-ink">
                  {server.transport === 'stdio' ? 'stdio' : 'HTTP'}
                </span>
                <div role="group" aria-label="启用状态" className="ml-auto flex gap-3">
                  <Chip
                    data-testid={`mcp-server-${index}-enable`}
                    aria-pressed={server.enabled}
                    className={server.enabled ? 'bg-selected' : ''}
                    disabled={busy !== undefined}
                    onClick={() =>
                      void apply(server.id, (candidate) => ({ ...candidate, enabled: true }))
                    }
                  >
                    启用
                  </Chip>
                  <Chip
                    data-testid={`mcp-server-${index}-disable`}
                    aria-pressed={!server.enabled}
                    className={!server.enabled ? 'bg-selected' : ''}
                    disabled={busy !== undefined}
                    onClick={() =>
                      void apply(server.id, (candidate) => ({ ...candidate, enabled: false }))
                    }
                  >
                    停用
                  </Chip>
                </div>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">名称</span>
                <Input
                  data-testid={`mcp-server-${index}-name`}
                  value={draft.name}
                  onChange={(event) => patchDraft(server, { name: event.target.value })}
                />
              </label>

              {server.transport === 'stdio' ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">命令</span>
                    <Input
                      data-testid={`mcp-server-${index}-command`}
                      value={draft.command}
                      placeholder="如 npx"
                      onChange={(event) => patchDraft(server, { command: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-b2 text-ink-secondary">参数</span>
                    <Input
                      data-testid={`mcp-server-${index}-args`}
                      value={draft.argsText}
                      placeholder="如 -y @modelcontextprotocol/server-filesystem D:/notes"
                      onChange={(event) => patchDraft(server, { argsText: event.target.value })}
                    />
                  </label>
                </>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">地址</span>
                  <Input
                    data-testid={`mcp-server-${index}-url`}
                    value={draft.url}
                    placeholder="http://127.0.0.1:8000/mcp"
                    onChange={(event) => patchDraft(server, { url: event.target.value })}
                  />
                </label>
              )}

              {problems.length > 0 ? (
                <p
                  data-testid={`mcp-server-${index}-problems`}
                  className="text-c1 text-ink-secondary"
                >
                  {problems.join('；')}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  data-testid={`mcp-server-${index}-save`}
                  loading={busy === 'saving'}
                  onClick={() => void save(server)}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`mcp-server-${index}-test`}
                  loading={busy === 'testing'}
                  onClick={() => void test(server)}
                >
                  测试连接
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`mcp-server-${index}-remove`}
                  disabled={busy !== undefined}
                  onClick={() => void remove(server.id)}
                >
                  删除
                </Button>
              </div>

              {result ? (
                <p
                  data-testid={`mcp-server-${index}-test-result`}
                  className="text-c1 text-ink-secondary"
                >
                  {result.ok
                    ? `连接正常，发现 ${result.tools.length} 个工具，延迟 ${result.latencyMs} ms`
                    : `连接失败：${result.message}`}
                </p>
              ) : null}

              {errors[server.id] ? (
                <p data-testid={`mcp-server-${index}-error`} className="text-c1 text-danger">
                  {errors[server.id]}
                </p>
              ) : null}

              {toolList === undefined ? null : (
                <div data-testid={`mcp-server-${index}-tools`} className="flex flex-col gap-2">
                  {toolList.map((tool) => {
                    const marked = server.readOnlyTools.includes(tool.name)
                    return (
                      <div key={tool.name} className="flex items-center gap-3">
                        <Tooltip label={toolLabel(tool)} side="bottom" align="start">
                          <span
                            data-testid={`mcp-server-${index}-tool-${tool.name}`}
                            tabIndex={0}
                            className="min-w-0 flex-1 truncate rounded-button-sm font-mono text-c1 text-ink-secondary"
                          >
                            {tool.name}
                          </span>
                        </Tooltip>
                        <Chip
                          data-testid={`mcp-server-${index}-tool-${tool.name}-readonly`}
                          aria-pressed={marked}
                          className={marked ? 'bg-selected' : ''}
                          disabled={busy !== undefined}
                          onClick={() => void toggleReadOnly(server, tool.name)}
                        >
                          只读
                        </Chip>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })
      )}

      <div className="flex flex-col gap-2">
        <span className="text-b2 text-ink-secondary">添加 MCP 服务</span>
        <div data-testid="mcp-add" className="flex flex-wrap gap-3">
          <Chip data-testid="mcp-add-stdio" onClick={() => void add('stdio')}>
            本地命令（stdio）
          </Chip>
          <Chip data-testid="mcp-add-http" onClick={() => void add('http')}>
            远程地址（HTTP）
          </Chip>
        </div>
      </div>

      {pageError ? (
        <p data-testid="mcp-page-error" className="text-c1 text-danger">
          {pageError}
        </p>
      ) : null}
    </div>
  )
}
