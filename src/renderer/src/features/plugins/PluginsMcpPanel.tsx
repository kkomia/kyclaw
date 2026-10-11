import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { Cog } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { IconButton } from '@renderer/components/ui/icon-button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip } from '@renderer/components/ui/tooltip'
import { fetchMcpServers, saveMcpServers, testMcpServer } from '@renderer/lib/mcp-api'
import {
  argsToText,
  mcpServerProblems,
  textToArgs,
  type McpTestResult,
  type McpToolInfo
} from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'
import { McpKeyValueEditor } from './McpKeyValueEditor'
import { recordToRows, rowsToRecord, type KeyValueRow } from './mcp-form'

/**
 * 插件页「MCP」面板（R2 round 5；原设置页「工具与 MCP」改版迁入）：
 * **行式**管理列表（照 ChatGPT MCPs 页 / 用户实拍 #9 与图3）——名称 + 齿轮（编辑对话框）+ 开关。
 *
 * 口径（round 5）：
 *   - 启停是**一个开关**（Switch，Kimi 图5 形态），不再做"启用/停用"两个 chip；
 *   - 新增走页面右上角「＋新增」菜单（round 9 起：点菜单项**直接开对话框**填配置，见 PluginsPage），
 *     本面板只管列表与编辑；
 *   - 嵌套 ≤2 层（Step D）：页级容器（PluginsPage 给）> 行；编辑在**对话框**里做（字段 + 保存/删除 +
 *     测试工具清单），不再在行内叠三层面板；
 *   - 行为与 T12 一致：整表保存、以回吐为准、失败行内报错；新增一律停用落盘；
 *     测试连接真连一次；单工具「只读」= 勾了免审批（写类逐次询问）——落盘状态的一部分。
 *   - round 9：编辑对话框补 Headers（http）/ 环境变量（stdio）键值编辑器（复用 McpKeyValueEditor）；
 *     删掉标题下那句解释性小字（雷点 2.1/2.2：流程靠控件本身表达）。
 *   - round 11（用户实拍）：**测试连接搬进编辑对话框**（行 = 名称 + 传输徽标 + problems + 齿轮 + 开关），
 *     结果行与工具清单就地展示；「保存」成功即关对话框（失败留在原地行内报错），测试的内部自动保存不关。
 */
interface Draft {
  name: string
  command: string
  argsText: string
  url: string
  headers: KeyValueRow[]
  env: KeyValueRow[]
}

function draftOf(server: McpServerConfig): Draft {
  return {
    name: server.name,
    command: server.command ?? '',
    argsText: argsToText(server.args ?? []),
    url: server.url ?? '',
    headers: recordToRows(server.headers),
    env: recordToRows(server.env)
  }
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

function withDraft(server: McpServerConfig, draft: Draft): McpServerConfig {
  return {
    ...server,
    name: draft.name,
    // 只写当前 transport 的字段；另一类的字段保持原值（空行由 rowsToRecord 丢弃）
    ...(server.transport === 'stdio'
      ? { command: draft.command, args: textToArgs(draft.argsText), env: rowsToRecord(draft.env) }
      : { url: draft.url, headers: rowsToRecord(draft.headers) })
  }
}

function toolLabel(tool: McpToolInfo): string {
  return tool.description === '' ? tool.name : `${tool.name} — ${tool.description}`
}

function resultText(result: McpTestResult): string {
  return result.ok
    ? `连接正常，发现 ${result.tools.length} 个工具，延迟 ${result.latencyMs} ms`
    : `连接失败：${result.message}`
}

export interface PluginsMcpPanelProps {
  /** 页面的「＋新增」加完之后 +1：面板据此重拉列表（新增逻辑在页面侧，见 PluginsPage） */
  revision?: number
}

export function PluginsMcpPanel({ revision = 0 }: PluginsMcpPanelProps): React.JSX.Element {
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [loaded, setLoaded] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, setPending] = useState<Record<string, 'saving' | 'testing' | undefined>>({})
  const [results, setResults] = useState<Record<string, McpTestResult | undefined>>({})
  const [tools, setTools] = useState<Record<string, McpToolInfo[] | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [pageError, setPageError] = useState<string | undefined>(undefined)
  /** 正在编辑的 server id（null = 没开对话框） */
  const [editing, setEditing] = useState<string | null>(null)

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
  }, [revision])

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

  /** 启停 / 删除 / 只读标记：都是整表保存（不经过草稿） */
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
        setEditing((current) => (current === id ? null : current))
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

  const editingServer = servers.find((server) => server.id === editing) ?? null
  const editingIndex = editingServer === null ? -1 : servers.indexOf(editingServer)
  const editingDraft =
    editingServer === null ? null : (drafts[editingServer.id] ?? draftOf(editingServer))
  const editingResult = editingServer === null ? undefined : results[editingServer.id]

  /** 「保存」按钮专用的收口（round 11：成功就关对话框）；「测试连接」的内部保存不走这里，不关 */
  const saveAndClose = useCallback(async (): Promise<void> => {
    if (editingServer === null) return
    const id = editingServer.id
    if (await save(editingServer)) setEditing((current) => (current === id ? null : current))
  }, [editingServer, save])

  return (
    <div data-testid="mcp-settings" className="flex flex-col gap-3">
      {servers.length === 0 ? (
        <p data-testid="mcp-empty" className="text-b2 text-ink-secondary">
          {loaded ? '还没有 MCP 服务：点右上角「新增」把服务接进来。' : '正在读取…'}
        </p>
      ) : (
        servers.map((server, index) => {
          const draft = drafts[server.id] ?? draftOf(server)
          const problems = mcpServerProblems(withDraft(server, draft))
          const busy = pending[server.id]

          return (
            <div
              key={server.id}
              data-testid={`mcp-server-${index}`}
              className="flex flex-wrap items-center gap-3 rounded-control px-3 py-2.5 transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-b1 font-medium text-ink">
                    {draft.name || server.id}
                  </span>
                  <span className="shrink-0 rounded-pill bg-selected px-2 py-0.5 text-c1 text-ink">
                    {server.transport === 'stdio' ? 'stdio' : 'HTTP'}
                  </span>
                </div>
                {problems.length > 0 ? (
                  <span
                    data-testid={`mcp-server-${index}-problems`}
                    className="text-c1 text-ink-secondary"
                  >
                    {problems.join('；')}
                  </span>
                ) : null}
                {errors[server.id] ? (
                  <span data-testid={`mcp-server-${index}-error`} className="text-c1 text-danger">
                    {errors[server.id]}
                  </span>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  data-testid={`mcp-server-${index}-edit`}
                  label="编辑"
                  icon={<Cog />}
                  className="border-transparent hover:bg-hover"
                  onClick={() => setEditing(server.id)}
                />
                <Switch
                  checked={server.enabled}
                  disabled={busy !== undefined}
                  // 可访问名稳定（round 7 台账 minor②）：不随开关状态翻转，状态由 aria-checked 表达
                  label={`启用 ${server.name}`}
                  data-testid={`mcp-server-${index}-enable`}
                  onCheckedChange={(next) =>
                    void apply(server.id, (candidate) => ({ ...candidate, enabled: next }))
                  }
                />
              </div>
            </div>
          )
        })
      )}

      {pageError ? (
        <p data-testid="mcp-page-error" className="text-c1 text-danger">
          {pageError}
        </p>
      ) : null}

      {/* 编辑对话框（Step D：字段与工具清单都收进浮层，行内只留"名称 + 测试 + 齿轮 + 开关"） */}
      <Dialog
        open={editingServer !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        title="编辑 MCP 服务"
        size="md"
        footer={
          <>
            {editingServer === null || editingIndex < 0 ? null : (
              <Button
                variant="danger"
                data-testid={`mcp-server-${editingIndex}-remove`}
                disabled={pending[editingServer.id] !== undefined}
                onClick={() => void remove(editingServer.id)}
              >
                删除
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" data-testid="mcp-edit-cancel" onClick={() => setEditing(null)}>
              取消
            </Button>
            {editingServer === null ? null : (
              <Button
                data-testid={`mcp-server-${editingIndex}-save`}
                loading={pending[editingServer.id] === 'saving'}
                onClick={() => void saveAndClose()}
              >
                保存
              </Button>
            )}
          </>
        }
      >
        {editingServer === null || editingDraft === null ? null : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">名称</span>
              <Input
                data-testid={`mcp-server-${editingIndex}-name`}
                value={editingDraft.name}
                onChange={(event) => patchDraft(editingServer, { name: event.target.value })}
              />
            </label>

            {editingServer.transport === 'stdio' ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">命令</span>
                  <Input
                    data-testid={`mcp-server-${editingIndex}-command`}
                    value={editingDraft.command}
                    placeholder="如 npx"
                    onChange={(event) => patchDraft(editingServer, { command: event.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">参数</span>
                  <Input
                    data-testid={`mcp-server-${editingIndex}-args`}
                    value={editingDraft.argsText}
                    placeholder="如 -y @modelcontextprotocol/server-filesystem D:/notes"
                    onChange={(event) =>
                      patchDraft(editingServer, { argsText: event.target.value })
                    }
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">环境变量</span>
                  <McpKeyValueEditor
                    rows={editingDraft.env}
                    onChange={(env) => patchDraft(editingServer, { env })}
                    testIdPrefix={`mcp-server-${editingIndex}-env`}
                    namePlaceholder="环境变量名"
                    valuePlaceholder="环境变量值"
                    addLabel="添加环境变量"
                  />
                </div>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">地址</span>
                  <Input
                    data-testid={`mcp-server-${editingIndex}-url`}
                    value={editingDraft.url}
                    placeholder="http://127.0.0.1:8000/mcp"
                    onChange={(event) => patchDraft(editingServer, { url: event.target.value })}
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">Headers</span>
                  <McpKeyValueEditor
                    rows={editingDraft.headers}
                    onChange={(headers) => patchDraft(editingServer, { headers })}
                    testIdPrefix={`mcp-server-${editingIndex}-headers`}
                    namePlaceholder="Header 名称"
                    valuePlaceholder="Header 值"
                    addLabel="添加 Header"
                  />
                </div>
              </>
            )}

            {/* 测试连接（round 11：从行内搬进对话框）——脏草稿先存再测，「保存」的关闭逻辑不在这条路上 */}
            <div className="flex flex-col gap-2">
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`mcp-server-${editingIndex}-test`}
                  loading={pending[editingServer.id] === 'testing'}
                  disabled={pending[editingServer.id] !== undefined}
                  onClick={() => void test(editingServer)}
                >
                  测试连接
                </Button>
              </div>
              {editingResult === undefined ? null : (
                <span
                  data-testid={`mcp-server-${editingIndex}-test-result`}
                  className="text-c1 text-ink-secondary"
                >
                  {resultText(editingResult)}
                </span>
              )}
            </div>

            {tools[editingServer.id] === undefined ? null : (
              <div data-testid={`mcp-server-${editingIndex}-tools`} className="flex flex-col gap-2">
                <span className="text-b2 text-ink-secondary">工具（打开 = 免审批）</span>
                {tools[editingServer.id]?.map((tool) => (
                  <div key={tool.name} className="flex items-center gap-3">
                    <Tooltip label={toolLabel(tool)} side="bottom" align="start">
                      <span
                        data-testid={`mcp-server-${editingIndex}-tool-${tool.name}`}
                        tabIndex={0}
                        className="min-w-0 flex-1 truncate rounded-button-sm font-mono text-c1 text-ink-secondary"
                      >
                        {tool.name}
                      </span>
                    </Tooltip>
                    <Switch
                      checked={editingServer.readOnlyTools.includes(tool.name)}
                      disabled={pending[editingServer.id] !== undefined}
                      label={`免审批：${tool.name}`}
                      data-testid={`mcp-server-${editingIndex}-tool-${tool.name}-readonly`}
                      onCheckedChange={() => void toggleReadOnly(editingServer, tool.name)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
